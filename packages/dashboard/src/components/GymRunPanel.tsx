import { useCallback } from 'react';
import { api, type GymSkillOutcome, type LoopRunRecord } from '../lib/api';
import { fmt } from '../lib/format';
import { useResource } from '../hooks/useResource';
import { StatusPill } from './ui';

/**
 * Gym run panel (read-only): answers "why did this run stop, what is proven done, what happens next" for one evolution-gym
 * or TG-001 run, from loop_runs.metadata.gym (the claim), metadata.gym_result (what remote-gym-service record() or the
 * server's own settlement wrote) and the skill outcome record() wrote (GET /loops/runs/:id/gym-outcome).
 * Server-side checks and worker claims are kept in separate groups; a value no record holds reads "unknown", never 0.
 */
export const GYM_LOOP_NAMES: readonly string[] = ['evolution-gym', 'tg-001'];
export const isGymRun = (run: Pick<LoopRunRecord, 'loop_name'>): boolean => GYM_LOOP_NAMES.includes(run.loop_name);

/** Mirrors remote-gym-service.ts: the two settlements the server makes itself, and the P0-12 evidence discard. */
const LOST_AT_CLAIM = 'infra: worker lost the result (no report before its next claim)';
const ORPHANED_NO_RESULT = 'infra: orphaned_no_result';
const NO_DIFF_EVIDENCE = 'infra: success without changed_files/diff evidence';
const BASELINE_GENOME = 'baseline'; // genome-registry.ts BASELINE_GENOME

export type GymStopClass = 'verified' | 'proxy-success' | 'failure' | 'quarantined' | 'void' | 'infra-discarded' | 'lost' | 'discarded' | 'running' | 'unknown';
export type GymNext = 'served again' | 'counted' | 'quarantined' | 'not counted' | 'experiment record' | 'pending' | 'unknown';
export interface GymRow { label: string; value: string; source: string }
export interface GymRunView {
  stop: GymStopClass;
  answer: string;
  context: GymRow[];
  proven: GymRow[];
  claimed: GymRow[];
  next: { label: GymNext; detail: string };
}
/** The outcome lookup as the panel holds it: loading, failed, or the stored row (null = record() wrote none). */
export type OutcomeState = { state: 'loading' } | { state: 'error' } | { state: 'loaded'; outcome: GymSkillOutcome | null };

interface GymMeta {
  commit?: string; kind?: string; species?: string; remote_host?: string; genome?: string; probe?: number; canary?: number;
  prod_gates?: number; mutant_keys?: string[]; tier?: number; tg?: { experiment?: string; arm?: string; attempt_id?: string };
}
interface GymResultMeta {
  status?: string; reason?: string; tokens?: number | null; hack_flags?: string[]; killed_mutants?: string[];
  prod_gates?: Record<string, string>; graded?: number; graded_kind?: string; diff_ref?: string; void?: string; late_result?: number;
  fire_check?: { goal_sha256?: string; genome_lines?: number; genome_lines_found?: number };
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);
const UNKNOWN_NOT_REPORTED = 'unknown (not reported)';

/** remote-gym-service.ts reportedTokens(): only a positive count is a count; 0, null or missing is unknown. */
const tokensText = (tokens: unknown): string => (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0 ? `${fmt(Math.floor(tokens))} tokens` : UNKNOWN_NOT_REPORTED);

/** Plain-English stop reasons for the worker reasons gym-worker.mjs emits; anything else is shown verbatim. */
export function describeReason(reason: string | undefined): string {
  const r = (reason ?? '').trim();
  if (!r) return 'no reason given';
  if (r === 'tests still red') return "tests still red after the maker's change";
  if (r === 'no change (maker gave up)') return 'no change: the maker gave up';
  if (r === 'no change') return 'the maker made no change';
  if (r === 'test kills no mutant') return 'the new test kills no served mutant';
  const scope = /^out of scope: (.*)$/.exec(r);
  if (scope) return `the maker changed files out of scope (${scope[1]})`;
  const gate = /^prod_gate_failed:(.+)$/.exec(r);
  if (gate) return `prod gate ${gate[1]} failed after the gym oracle passed`;
  return r;
}

export function gymRunView(run: Pick<LoopRunRecord, 'status' | 'loop_name' | 'metadata'>, outcome: OutcomeState): GymRunView {
  const gymRaw = obj(run.metadata?.gym) ?? {};
  const resRaw = obj(run.metadata?.gym_result);
  const gym: GymMeta = { ...gymRaw, mutant_keys: strings(gymRaw.mutant_keys), tg: obj(gymRaw.tg) as GymMeta['tg'] ?? undefined };
  const res: GymResultMeta | null = resRaw ? { ...resRaw, hack_flags: strings(resRaw.hack_flags), killed_mutants: strings(resRaw.killed_mutants),
    prod_gates: obj(resRaw.prod_gates) as Record<string, string> | undefined ?? undefined, fire_check: obj(resRaw.fire_check) as GymResultMeta['fire_check'] ?? undefined } : null;
  const reason = typeof res?.reason === 'string' ? res.reason : undefined;
  const status = typeof res?.status === 'string' ? res.status : undefined;
  const isInfra = !!reason?.startsWith('infra:');
  const serverSettled = reason === LOST_AT_CLAIM || reason === ORPHANED_NO_RESULT;
  const isTg = run.loop_name === 'tg-001' || !!gym.tg;
  const isCanary = gym.canary === 1;
  const gated = gym.prod_gates === 1;
  const gateMap = res?.prod_gates && Object.keys(res.prod_gates).length ? res.prod_gates : undefined;
  const writeTest = gym.kind === 'write_test' && !!gym.mutant_keys?.length;
  // a missing killed_mutants list is unknown, not 0 killed
  const killed = writeTest && res?.killed_mutants ? `${res.killed_mutants.length}/${gym.mutant_keys!.length}` : null;

  const context: GymRow[] = [
    { label: 'Task', value: gym.commit ? `${gym.commit}${gym.kind ? ` (${gym.kind})` : ' (repair)'}` : 'unknown', source: 'gym.commit, gym.kind' },
    { label: 'Species', value: gym.species || 'unknown', source: 'gym.species' },
    { label: 'Worker host', value: gym.remote_host || 'local gym (no remote host)', source: 'gym.remote_host' },
    { label: 'Genome', value: gym.genome || 'none on this claim', source: 'gym.genome' },
    ...(isTg ? [{ label: 'Experiment', value: `${gym.tg?.experiment ?? 'TG-001'}${gym.tg?.arm ? `, arm ${gym.tg.arm}` : ''}`, source: 'gym.tg' }] : []),
    ...(gym.probe === 1 || isCanary ? [{ label: 'Claim type', value: [gym.probe === 1 ? 'tier probe' : '', isCanary ? 'canary' : ''].filter(Boolean).join(', '), source: 'gym.probe, gym.canary' }] : []),
  ];

  // ---- Proven: what the server recorded or computed itself
  const proven: GymRow[] = [];
  proven.push({ label: 'Settled as', value: status ?? (run.status === 'running' ? 'not settled yet' : 'unknown (no gym result)'), source: 'gym_result.status' });
  proven.push({
    label: 'Prod gates',
    value: !gated ? 'not requested on this claim'
      : gateMap ? Object.entries(gateMap).map(([check, v]) => `${check} ${v}`).join(' · ')
        : status === 'failure' && reason?.startsWith('prod_gate_failed:') ? `failed: ${reason.slice('prod_gate_failed:'.length)} (no per-check map recorded)`
          // gym-worker.mjs runs the production gates only on a proxy success
          : status === 'failure' ? 'not run: the gym oracle failed first'
            : 'unknown (requested, no per-check results recorded)',
    source: 'gym.prod_gates, gym_result.prod_gates (ELIGIBLE_GATED)',
  });
  proven.push({
    label: 'Graded score (server-side)',
    value: res?.graded_kind === 'mutant_kill' && typeof res.graded === 'number' ? `${fmt(res.graded)} (${killed ? `${killed} served mutants killed` : 'mutant_kill; kill list not recorded'})`
      : killed && status !== 'discarded' ? `not graded; ${killed} served mutants killed`
        : 'none computed server-side',
    source: 'gym_result.graded, graded_kind mutant_kill (gymGraded)',
  });
  proven.push({
    label: 'Hack classifier',
    value: res?.hack_flags ? (res.hack_flags.length ? `flagged: ${res.hack_flags.join(', ')}` : 'ran, no flags')
      : status === 'discarded' ? 'not run (discarded before scoring)' : 'unknown (not run on this run)',
    source: 'gym_result.hack_flags (classifyHack)',
  });
  proven.push({
    label: 'Diff',
    value: typeof res?.diff_ref === 'string' ? `present, ${res.diff_ref.slice(0, 19)}…`
      : reason === NO_DIFF_EVIDENCE ? 'absent: no changed files or diff came with the success'
        : 'unknown (no diff hash recorded)',
    source: 'gym_result.diff_ref (server-side sha256)',
  });
  const fc = res?.fire_check;
  proven.push({
    label: 'Genome fire check',
    value: !gym.genome ? 'no genome on this claim'
      : gym.genome === BASELINE_GENOME ? 'baseline genome (no check needed)'
        : typeof res?.void === 'string' ? `VOID: ${res.void}`
          : fc && typeof fc.goal_sha256 === 'string' ? `lines reached the maker: ${fc.genome_lines_found ?? 'unknown'}/${fc.genome_lines ?? 'unknown'}, goal sha256 ${fc.goal_sha256.slice(0, 12)}…`
            : 'unknown (no fire check recorded)',
    source: 'gym_result.fire_check, gym_result.void (fireCheckVoid)',
  });

  // ---- Reported by the worker: never shown as proven
  const claimed: GymRow[] = [];
  const workerStatus = !res ? (run.status === 'running' ? 'no report yet' : 'unknown')
    : serverSettled ? 'no report (the server settled the run)'
      : status === 'quarantined' || reason === NO_DIFF_EVIDENCE ? 'success' : status ?? 'unknown';
  claimed.push({ label: 'Status', value: workerStatus, source: 'gym_result.status as reported' });
  claimed.push({
    label: 'Reason',
    value: !res ? 'unknown' : serverSettled ? 'none (no report)' : reason === NO_DIFF_EVIDENCE ? 'not kept (the server replaced it)' : reason || 'unknown',
    source: 'gym_result.reason',
  });
  claimed.push({ label: 'Tokens', value: tokensText(res?.tokens), source: 'gym_result.tokens' });
  const o = outcome.state === 'loaded' ? outcome.outcome : null;
  claimed.push({
    label: 'Duration',
    value: outcome.state === 'loading' ? 'loading'
      : outcome.state === 'error' ? 'unknown (outcome lookup failed)'
        : !o ? 'unknown (no skill outcome recorded)'
          : o.duration_ms > 0 ? `${fmt(Math.round(o.duration_ms / 1000))} s` : UNKNOWN_NOT_REPORTED,
    source: 'skill_outcomes.duration_ms',
  });
  if ((res?.graded_kind === 'tests_green' || res?.graded_kind === 'binary') && typeof res.graded === 'number') {
    claimed.push({ label: 'Graded score', value: `${fmt(res.graded)} (${res.graded_kind === 'tests_green' ? "the worker's per-test share" : 'binary, from the reported verdict'})`, source: 'gym_result.graded' });
  }
  if (res?.late_result === 1) claimed.push({ label: 'Late report', value: 'arrived after the server settled the run; not used', source: 'gym_result.late_result' });

  // ---- Stop class, the one-line answer and what happens next
  let stop: GymStopClass; let answer: string; let next: GymRunView['next'];
  const reServed = isTg
    // tg-001.ts: an infra discard of a TG attempt is re-queued, or INFRA_CENSORED once every permitted attempt was one
    ? { label: 'experiment record' as const, short: 'attempt re-queued or censored', detail: 'TG-001 attempt: no skill outcome; the tg_attempts row holds the result, and an infra discard is re-queued or INFRA_CENSORED (tg-001.ts).' }
    : isCanary
      // remote-gym-service.ts RX-11: a canary earns no outcome and never marks its task tried
      ? { label: 'not counted' as const, short: 'canary, not counted', detail: 'Canary: earns no outcome and never marks its task tried (remote-gym-service.ts RX-11).' }
      // evolution-gym-service.ts triedTasks(): an 'infra:' reason leaves the task untried until two infra discards for the
      // species ('infra: subscription_' ones excepted); record()/settleLostRuns(): a discard writes no skill outcome
      : { label: 'served again' as const, short: 'task will be re-served', detail: "Served again: an 'infra:' discard leaves the task untried and writes no skill outcome; after two infra discards for this species the task counts as tried (evolution-gym-service.ts triedTasks)." };
  if (!res) {
    stop = run.status === 'running' ? 'running' : 'unknown';
    answer = run.status === 'running' ? `Running: no result reported yet${gym.remote_host ? ` by ${gym.remote_host}` : ''}` : 'Unknown: no gym result recorded on this run';
    // remote-gym-service.ts settleLostRuns(): the host's next claim or the orphan sweep settles a silent run as an infra discard
    next = run.status === 'running'
      ? { label: 'pending', detail: "Pending: if no report arrives, the host's next claim or the orphan sweep settles the run as an infra discard (remote-gym-service.ts settleLostRuns)." }
      : { label: 'unknown', detail: 'Unknown: the run carries no gym result (a legacy row or an unsettled run).' };
  } else if (typeof res.void === 'string') {
    stop = 'void';
    answer = `VOID: ${res.void} — the attempt does not count`;
    // genome-registry.ts GENOME_FIRE_CHECK: a VOID attempt is served again, never paired, earns no outcome; INFRA_GIVE_UP = 3
    next = { label: 'served again', detail: 'Served again: a VOID attempt earns no outcome and is never paired; after 3 (INFRA_GIVE_UP) the task is unscorable for this genome (genome-registry.ts).' };
  } else if (status === 'quarantined') {
    stop = 'quarantined';
    answer = `Quarantined: the worker reported success, the hack classifier flagged ${res.hack_flags?.join(', ') || 'it'}`;
    // remote-gym-service.ts record(): a flagged success is 'quarantined', recorded as a non-win tagged gym:quarantined
    next = { label: 'quarantined', detail: 'Quarantined: recorded as a non-win outcome tagged gym:quarantined; not a win for fitness, gym statistics or genome trials (remote-gym-service.ts record).' };
  } else if (status === 'discarded' && isInfra) {
    stop = serverSettled ? 'lost' : 'infra-discarded';
    answer = `Infra discard: ${reason!.replace(/^infra:\s*/, '')} — ${reServed.short}`;
    next = { label: reServed.label, detail: reServed.detail };
  } else if (status === 'discarded') {
    stop = 'discarded';
    answer = `Discarded: ${describeReason(reason)} — not scored`;
    // evolution-gym-service.ts triedTasks(): a non-'infra:' reason marks the task tried; record(): a discard writes no outcome
    next = { label: 'not counted', detail: "Not counted, not served again: a discard writes no skill outcome, and a non-'infra:' reason marks the task tried (evolution-gym-service.ts triedTasks)." };
  } else if (status === 'success' || status === 'failure') {
    const verified = status === 'success' && gated && !!gateMap;
    stop = status === 'failure' ? 'failure' : verified ? 'verified' : 'proxy-success';
    answer = status === 'failure' ? `Stopped: ${describeReason(reason)} (worker report)`
      : verified ? `Verified: prod gates passed${killed ? `, ${killed} mutants killed` : ''}`
        : gated ? 'Success not verified: prod gates were requested but no gate results were recorded'
          : `Proxy success: gym oracle passed (worker report), prod gates not run${killed ? `, ${killed} mutants killed` : ''}`;
    // remote-gym-service.ts record(): a success or failure earns a skill outcome unless canary, VOID or TG-001;
    // genome-registry.ts ELIGIBLE_GATED: only a gated failure, or a gated success with its per-check map, decides headroom or promotion
    next = isTg ? { label: 'experiment record', detail: reServed.detail }
      : isCanary ? { label: 'not counted', detail: reServed.detail }
        : { label: 'counted', detail: `Counted: a ${status} skill outcome for this species; the task is now tried and not served again${gated && (status === 'failure' || gateMap) ? '. Gated, so it may decide headroom or promotion (ELIGIBLE_GATED)' : '. Not gated, so it never decides headroom or promotion (ELIGIBLE_GATED)'}.` };
  } else {
    stop = 'unknown';
    answer = `Unknown: unrecognised gym result status ${status ?? '(none)'}`;
    next = { label: 'unknown', detail: 'Unknown: no rule applies to this status.' };
  }
  if (res?.late_result === 1) answer += ' · a late worker report was rejected';
  return { stop, answer, context, proven, claimed, next };
}

const TONE: Record<GymStopClass, 'ok' | 'warn' | 'error' | 'paused' | 'neutral'> = {
  verified: 'ok', 'proxy-success': 'warn', failure: 'error', quarantined: 'error', void: 'warn',
  'infra-discarded': 'paused', lost: 'paused', discarded: 'neutral', running: 'neutral', unknown: 'neutral',
};

/** Label/value pairs; the record behind each value sits in a native <details>, reachable by keyboard (no hover-only text). */
function Rows({ rows, sources = true }: { rows: GymRow[]; sources?: boolean }) {
  return (
    <>
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-3 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-foreground-tertiary">{r.label}</dt>
            <dd className="text-foreground break-words">{r.value}</dd>
          </div>
        ))}
      </dl>
      {sources && (
        <details className="mt-1 text-foreground-tertiary">
          <summary className="cursor-pointer">Sources</summary>
          <ul className="mt-1 space-y-0.5">{rows.map((r) => <li key={r.label}>{r.label}: {r.source}</li>)}</ul>
        </details>
      )}
    </>
  );
}

export function GymRunPanel({ run }: { run: LoopRunRecord }) {
  const fetchOutcome = useCallback(() => api.getGymOutcome(run.id), [run.id]);
  const { data, error, loading } = useResource(fetchOutcome);
  const outcome: OutcomeState = data && data.run_id === run.id ? { state: 'loaded', outcome: data.skill_outcome } : error ? { state: 'error' } : loading ? { state: 'loading' } : { state: 'error' };
  const view = gymRunView(run, outcome);
  const recorded = outcome.state === 'loaded'
    ? (outcome.outcome ? `${outcome.outcome.success ? 'success' : 'failure'} for ${outcome.outcome.skill_id}${outcome.outcome.evidence_refs.includes('gym:quarantined') ? ' (gym:quarantined)' : ''}` : 'none')
    : outcome.state === 'loading' ? 'loading' : 'unknown (lookup failed)';
  return (
    <section aria-labelledby="gym-run-heading" className="bg-background-secondary border border-border rounded-lg p-5 space-y-4 text-sm" data-testid="gym-run-panel">
      <div className="space-y-2">
        <h3 id="gym-run-heading" className="text-lg font-semibold text-foreground">Gym run</h3>
        <p className="flex flex-wrap items-baseline gap-2 text-foreground font-medium break-words" data-testid="gym-answer">
          <StatusPill tone={TONE[view.stop]} label={view.stop} />
          <span>{view.answer}</span>
        </p>
        <div className="text-xs"><Rows rows={view.context} sources={false} /></div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section aria-labelledby="gym-proven-heading" className="rounded border border-status-completed/30 p-3 space-y-2" data-testid="gym-proven">
          <h4 id="gym-proven-heading" className="font-semibold text-foreground">Proven</h4>
          <p className="text-xs text-foreground-tertiary">Recorded or computed by the server.</p>
          <div className="text-xs"><Rows rows={view.proven} /></div>
        </section>
        <section aria-labelledby="gym-claimed-heading" className="rounded border border-dashed border-border p-3 space-y-2" data-testid="gym-claimed">
          <h4 id="gym-claimed-heading" className="font-semibold text-foreground">Reported by worker</h4>
          <p className="text-xs text-foreground-tertiary">Claims from the gym worker; not independently checked.</p>
          <div className="text-xs"><Rows rows={view.claimed} /></div>
        </section>
      </div>
      <section aria-labelledby="gym-next-heading" className="space-y-1" data-testid="gym-next">
        <h4 id="gym-next-heading" className="font-semibold text-foreground">Next: {view.next.label}</h4>
        <p className="text-xs text-foreground-secondary">{view.next.detail}</p>
        <p className="text-xs text-foreground-tertiary">Skill outcome on record: {recorded}</p>
      </section>
    </section>
  );
}
