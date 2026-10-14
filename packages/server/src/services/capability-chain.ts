import fs from 'fs';
import type { Database } from 'better-sqlite3';
import { listSchedulers, type SchedulerStatus } from './scheduler-registry';

/**
 * Stall watch, capability chain (Workstream B): a capability is only healthy when every link holds —
 *   CONFIGURED → ENABLED → DEPENDENCIES_READY → SCHEDULED → EXECUTED → OUTCOME_PERSISTED
 * prod 2026-10-08: DREAM_STATE_ENABLED stayed on and its scheduler kept ticking while its required judgment
 * (TYPESAFE_FAILURE_CAUSE_MODE) was off, so replay() returned early and no dream_ledger row was written for 6 days — no
 * detector saw it. One declarative row per watched capability; observe() reads facts (env, paths, scheduler registry,
 * outcome/input queries), classify() is pure over those facts, so a fact set collected read-only on prod replays in a test.
 * Expected inactivity (flag off, cap reached, no input work) is IDLE_EXPECTED, never STALLED; missing evidence is UNKNOWN.
 * A required path env that is unset (no implicit default) is DISABLED_BY_POLICY or UNCONFIGURED per spec — explicit, not an
 * anomaly; a path that is set but missing/unreadable here stays MISCONFIGURED.
 * Read-only: nothing here restarts or reconfigures anything (the scheduler self-heal stays as it is).
 */
export const CHAIN_LINKS = ['CONFIGURED', 'ENABLED', 'DEPENDENCIES_READY', 'SCHEDULED', 'EXECUTED', 'OUTCOME_PERSISTED'] as const;
export type ChainLink = (typeof CHAIN_LINKS)[number];
export type CapabilityState = 'HEALTHY' | 'IDLE_EXPECTED' | 'DISABLED_BY_POLICY' | 'UNCONFIGURED' | 'BLOCKED' | 'STALLED' | 'MISCONFIGURED' | 'UNKNOWN';
export type LinkStatus = 'ok' | 'failed' | 'unknown' | 'not_applicable';

const H = 3_600_000;
export interface CapabilitySpec {
  name: string;
  /** all must hold for the capability to be enabled; value in `on` (default ['true']). None = always on. */
  flags: Array<{ env: string; on?: string[] }>;
  /** required dependencies: the capability runs but cannot produce its outcome without them */
  dependency_flags?: Array<{ env: string; on: string[] }>;
  /** paths named by env that must exist as `kind` here; no default: env unset → the `unset` state (off by policy, or not configured) */
  paths?: Array<{ label: string; env: string; kind: 'dir' | 'file'; unset: 'DISABLED_BY_POLICY' | 'UNCONFIGURED' }>;
  /** scheduler-registry name (noteScheduler); omitted for on-demand capabilities */
  scheduler?: string;
  /** observation window: an outcome / progress older than this is stale */
  window_ms: number;
  /** latest persisted outcome: SQL returning one row { t } */
  outcome?: { label: string; sql: string };
  /** queue-driven capabilities: pending work ({ n }) and its last state change ({ t }); no pending work = idle by design */
  input?: { label: string; pending_sql: string; progress_sql: string };
  /** a budget: `used_sql` ({ n }, bound to now − 24 h) at or above env `max_env` (default `max_default`) = idle by design */
  cap?: { label: string; used_sql: string; max_env: string; max_default: number };
  /** where to look when the chain breaks */
  hint: string;
}

/** One table, one row per watched capability. Keep queries read-only and cheap (MAX/COUNT on indexed tables). */
export const CAPABILITY_SPECS: CapabilitySpec[] = [
  { name: 'dream_state', flags: [{ env: 'DREAM_STATE_ENABLED' }], dependency_flags: [{ env: 'TYPESAFE_FAILURE_CAUSE_MODE', on: ['shadow', 'enforce'] }],
    scheduler: 'dream_state', window_ms: 13 * H, outcome: { label: 'dream_ledger row', sql: 'SELECT MAX(created_at) AS t FROM dream_ledger' },
    hint: 'services/dream-state-service.ts replay(): every pass writes one dream_ledger row unless its judgment is off' },
  { name: 'evolution_estimates', flags: [{ env: 'EVOLUTION_ESTIMATORS_ENABLED' }], scheduler: 'evolution_estimators', window_ms: 36 * H,
    outcome: { label: 'evolution_estimates row', sql: 'SELECT MAX(computed_at) AS t FROM evolution_estimates' }, hint: 'services/evolution-estimators.ts (nightly)' },
  { name: 'evolution_gym', flags: [{ env: 'EVOLUTION_GYM_ENABLED' }], scheduler: 'evolution_gym', window_ms: 6 * H,
    outcome: { label: 'local gym outcome', sql: "SELECT MAX(created_at) AS t FROM skill_outcomes WHERE domain = 'gym' AND COALESCE(evidence_refs_json, '') NOT LIKE '%\"remote:%'" },
    cap: { label: 'local gym daily cap', used_sql: "SELECT COUNT(*) AS n FROM skill_outcomes WHERE domain = 'gym' AND created_at >= ? AND COALESCE(evidence_refs_json, '') NOT LIKE '%\"remote:%'", max_env: 'EVOLUTION_GYM_MAX_PER_DAY', max_default: 12 },
    hint: 'services/evolution-gym-service.ts (local gym)' },
  { name: 'evolution_gym_remote', flags: [{ env: 'EVOLUTION_GYM_REMOTE_ENABLED' }], window_ms: 6 * H,
    outcome: { label: 'settled remote gym run', sql: "SELECT MAX(updated_at) AS t FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL AND status != 'running'" },
    cap: { label: 'remote gym daily cap', used_sql: "SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL AND created_at >= ?", max_env: 'EVOLUTION_GYM_REMOTE_MAX_PER_DAY', max_default: 24 },
    hint: 'remote gym workers claim via /api/gym/claim and settle via /api/gym/result (services/remote-gym-service.ts)' },
  { name: 'frontier_experts', flags: [{ env: 'FRONTIER_EXPERTS_SCHEDULER_ENABLED' }], scheduler: 'frontier_experts', window_ms: 26 * H, hint: 'frontier experts scheduler (index.ts)' },
  { name: 'memory_candidate_review', flags: [{ env: 'MEMORY_CANDIDATE_REVIEW_ENABLED' }], scheduler: 'memory_candidate_review', window_ms: 2 * H,
    input: { label: 'memory candidate(s) pending promotion', pending_sql: "SELECT COUNT(*) AS n FROM memory_candidates WHERE status = 'candidate' AND promotion_status = 'proposed'",
      progress_sql: 'SELECT MAX(updated_at) AS t FROM memory_candidates' },
    hint: 'services/memory-candidate-review-scheduler.ts' },
  { name: 'proposal_review', flags: [{ env: 'SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED' }], scheduler: 'self_improvement_auto_review', window_ms: 12 * H,
    input: { label: "proposal(s) in 'proposed'", pending_sql: "SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'proposed'", progress_sql: 'SELECT MAX(updated_at) AS t FROM self_improvements' },
    hint: 'services/self-improvement-auto-review-scheduler.ts (panel review of proposals)' },
  { name: 'goal_queue', flags: [], window_ms: 6 * H,
    input: { label: 'goal(s) created/decomposed, not started', pending_sql: "SELECT COUNT(*) AS n FROM goals WHERE status IN ('created', 'decomposed')", progress_sql: 'SELECT MAX(updated_at) AS t FROM goals' },
    hint: 'the loop daemon picks up goals (services/loop-service.ts)' },
  { name: 'skill_loader', flags: [], window_ms: 24 * H, paths: [{ label: 'skills directory', env: 'DJIMITFLO_SKILLS_DIR', kind: 'dir', unset: 'DISABLED_BY_POLICY' }],
    hint: 'skill loading is off unless DJIMITFLO_SKILLS_DIR names an operator-provisioned skills directory (services/skill-loader-service.ts; the image provisions none)' },
  { name: 'skill_training_promotion_gate', flags: [], window_ms: 24 * H,
    paths: [{ label: 'skill-training eval runner', env: 'DJIMIT_SKILL_TRAINING_EVAL_RUNNER', kind: 'file', unset: 'UNCONFIGURED' }],
    hint: 'services/skill-training-promotion-gate.ts refuses every skill promotion (fail-closed) until DJIMIT_SKILL_TRAINING_EVAL_RUNNER names a readable runner' },
];

type Q<T> = { value: T } | { error: string };
/** Facts about one capability, as observed — serialisable, so a prod fact set can be replayed as a fixture. */
export interface CapabilityObservation {
  name: string;
  observed_at: string;
  env: Record<string, string | null>;
  paths: Array<{ label: string; env: string; path: string | null; kind: 'dir' | 'file'; status: 'ok' | 'unset' | 'missing' | 'unreadable' | 'wrong_kind' }>;
  /** null = not observed (no registry in this process, or the scheduler never registered) */
  scheduler: { status: SchedulerStatus; last_run: string | null; last_error: string | null } | null;
  outcome: Q<string | null> | null;
  input: Q<{ pending: number; last_progress: string | null }> | null;
  cap: Q<{ used: number; max: number }> | null;
}

export interface CapabilityVerdict {
  component: string;
  state: CapabilityState;
  /** the first link that does not hold (OUTCOME_PERSISTED when healthy) */
  link: ChainLink;
  chain: Record<ChainLink, LinkStatus>;
  facts: Array<{ fact: string; at: string | null }>;
  window: { ms: number; since: string };
  remediation: string;
}

export interface ObserveOptions {
  /** injectable for tests: 'dir' | 'file' | 'missing' | 'unreadable' */
  stat?: (p: string) => 'dir' | 'file' | 'missing' | 'unreadable';
  /** scheduler registry snapshot; default: this process' registry */
  schedulers?: Array<{ name: string; status: SchedulerStatus; last_run: string | null; last_error: string | null }>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
export function statPath(p: string): 'dir' | 'file' | 'missing' | 'unreadable' {
  try { const s = fs.statSync(p); fs.accessSync(p, fs.constants.R_OK); return s.isDirectory() ? 'dir' : 'file'; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'missing' : 'unreadable'; }
}

export function observeCapability(spec: CapabilitySpec, db: Database, now: number, env: NodeJS.ProcessEnv, opts: ObserveOptions = {}): CapabilityObservation {
  const stat = opts.stat ?? statPath;
  const q = <T>(fn: () => T): Q<T> => { try { return { value: fn() }; } catch (e) { return { error: errMsg(e) }; } };
  const envKeys = [...spec.flags.map((f) => f.env), ...(spec.dependency_flags ?? []).map((f) => f.env), ...(spec.paths ?? []).map((p) => p.env), ...(spec.cap ? [spec.cap.max_env] : [])];
  const schedulers = opts.schedulers ?? listSchedulers(now).schedulers;
  const s = spec.scheduler ? schedulers.find((x) => x.name === spec.scheduler) : undefined;
  return {
    name: spec.name, observed_at: new Date(now).toISOString(),
    env: Object.fromEntries(envKeys.map((k) => [k, env[k] ?? null])),
    paths: (spec.paths ?? []).map((p) => {
      const resolved = env[p.env]?.trim(); if (!resolved) return { label: p.label, env: p.env, path: null, kind: p.kind, status: 'unset' as const };
      const st = stat(resolved);
      return { label: p.label, env: p.env, path: resolved, kind: p.kind, status: st === 'missing' || st === 'unreadable' ? st : st === p.kind ? 'ok' : 'wrong_kind' };
    }),
    scheduler: s ? { status: s.status, last_run: s.last_run, last_error: s.last_error } : null,
    outcome: spec.outcome ? q(() => (db.prepare(spec.outcome!.sql).get() as { t: string | null } | undefined)?.t ?? null) : null,
    input: spec.input ? q(() => ({ pending: (db.prepare(spec.input!.pending_sql).get() as { n: number }).n, last_progress: (db.prepare(spec.input!.progress_sql).get() as { t: string | null } | undefined)?.t ?? null })) : null,
    cap: spec.cap ? q(() => ({ used: (db.prepare(spec.cap!.used_sql).get(new Date(now - 24 * H).toISOString()) as { n: number }).n, max: Number(env[spec.cap!.max_env]) || spec.cap!.max_default })) : null,
  };
}

const iso = (t: string | null) => (t && !Number.isNaN(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : t);
const hours = (ms: number) => `${Math.round(ms / H)} h`;

/** Pure: the chain verdict for one capability from its observed facts. */
export function classifyCapability(spec: CapabilitySpec, obs: CapabilityObservation, now: number): CapabilityVerdict {
  const since = new Date(now - spec.window_ms).toISOString();
  const chain = Object.fromEntries(CHAIN_LINKS.map((l) => [l, 'not_applicable'])) as Record<ChainLink, LinkStatus>;
  const facts: CapabilityVerdict['facts'] = [];
  const at = obs.observed_at;
  const verdict = (state: CapabilityState, link: ChainLink, remediation: string): CapabilityVerdict =>
    ({ component: spec.name, state, link, chain, facts, window: { ms: spec.window_ms, since }, remediation });
  const flagOn = (v: string | null, on: string[]) => v !== null && on.includes(v.toLowerCase());

  // ENABLED (checked before CONFIGURED so an unused, unconfigured capability is idle, not misconfigured)
  for (const f of spec.flags) facts.push({ fact: `${f.env}=${obs.env[f.env] ?? '(unset)'}`, at });
  const off = spec.flags.filter((f) => !flagOn(obs.env[f.env] ?? null, f.on ?? ['true']));
  if (off.length) { chain.ENABLED = 'failed'; return verdict('IDLE_EXPECTED', 'ENABLED', `none: ${off.map((f) => f.env).join(', ')} off — inactive by configuration`); }
  chain.ENABLED = 'ok';
  // CONFIGURED: declared paths are set (no implicit default) and exist in this environment. Unset is decided from env, so a
  // fact set recorded before defaults were removed replays to the same explicit state.
  const isSet = (env: string) => !!obs.env[env]?.trim();
  for (const p of obs.paths) facts.push({ fact: isSet(p.env) ? `${p.label} ${p.path} (${p.env}): ${p.status}` : `${p.label}: ${p.env} unset`, at });
  const unset = (spec.paths ?? []).find((p) => !isSet(p.env));
  if (unset) {
    if (unset.unset === 'DISABLED_BY_POLICY') chain.ENABLED = 'failed'; else chain.CONFIGURED = 'failed';
    return verdict(unset.unset, unset.unset === 'DISABLED_BY_POLICY' ? 'ENABLED' : 'CONFIGURED', `none: ${unset.env} unset — ${spec.hint}`);
  }
  const bad = obs.paths.filter((p) => p.status !== 'ok');
  if (bad.length) {
    chain.CONFIGURED = 'failed';
    return verdict('MISCONFIGURED', 'CONFIGURED', bad.map((p) => `set ${p.env} to a readable ${p.kind} in this environment (${p.path} is ${p.status} here)`).join('; ') + ` — ${spec.hint}`);
  }
  chain.CONFIGURED = 'ok';
  const outcomeFact = () => {
    if (!spec.outcome || !obs.outcome) return;
    if ('error' in obs.outcome) facts.push({ fact: `${spec.outcome.label}: query failed (${obs.outcome.error})`, at });
    else facts.push({ fact: obs.outcome.value ? `last ${spec.outcome.label} at ${iso(obs.outcome.value)}` : `no ${spec.outcome.label} ever`, at: iso(obs.outcome.value) });
  };
  // DEPENDENCIES_READY
  const deps = spec.dependency_flags ?? [];
  for (const d of deps) facts.push({ fact: `${d.env}=${obs.env[d.env] ?? '(unset)'} (required: ${d.on.join('|')})`, at });
  const missing = deps.filter((d) => !flagOn(obs.env[d.env] ?? null, d.on));
  if (missing.length) {
    chain.DEPENDENCIES_READY = 'failed'; outcomeFact();
    return verdict('BLOCKED', 'DEPENDENCIES_READY', `set ${missing.map((d) => `${d.env} to ${d.on.join(' or ')}`).join(', ')} or turn ${spec.flags.map((f) => f.env).join('/') || 'it'} off — until then it runs without producing ${spec.outcome?.label ?? 'its outcome'}; ${spec.hint}`);
  }
  if (deps.length) chain.DEPENDENCIES_READY = 'ok';
  // idle by design: budget used up, or nothing to do
  if (obs.cap) {
    if ('error' in obs.cap) facts.push({ fact: `${spec.cap!.label}: query failed (${obs.cap.error})`, at });
    else {
      facts.push({ fact: `${spec.cap!.label}: ${obs.cap.value.used}/${obs.cap.value.max} in 24 h`, at });
      if (obs.cap.value.used >= obs.cap.value.max) return verdict('IDLE_EXPECTED', 'SCHEDULED', `none: at its own budget (${spec.cap!.max_env}); resumes as the 24 h window rolls`);
    }
  }
  if (obs.input) {
    if ('error' in obs.input) { facts.push({ fact: `${spec.input!.label}: query failed (${obs.input.error})`, at }); return verdict('UNKNOWN', 'OUTCOME_PERSISTED', `the input query failed; check the table exists — ${spec.hint}`); }
    facts.push({ fact: `${obs.input.value.pending} ${spec.input!.label}`, at });
    facts.push({ fact: obs.input.value.last_progress ? `last state change at ${iso(obs.input.value.last_progress)}` : 'no state change ever', at: iso(obs.input.value.last_progress) });
    if (obs.input.value.pending === 0) return verdict('IDLE_EXPECTED', 'SCHEDULED', 'none: no input work');
  }
  // SCHEDULED / EXECUTED: reuse the scheduler registry (Cockpit 3.0 statuses)
  if (spec.scheduler) {
    const s = obs.scheduler;
    if (!s || s.status === 'unknown') { chain.SCHEDULED = 'unknown'; chain.EXECUTED = 'unknown'; facts.push({ fact: `scheduler ${spec.scheduler}: ${s ? 'armed, ticks not reported' : 'not observed'}`, at }); }
    else {
      facts.push({ fact: `scheduler ${spec.scheduler}: ${s.status}${s.last_run ? `, last tick ${s.last_run}` : ''}${s.last_error ? `, last error: ${s.last_error}` : ''}`, at: s.last_run });
      if (s.status === 'off') { chain.SCHEDULED = 'failed'; return verdict('MISCONFIGURED', 'SCHEDULED', `the flag is on but scheduler '${spec.scheduler}' was not armed at boot — check its start conditions; ${spec.hint}`); }
      if (s.status === 'armed_not_ticking' || s.status === 'quarantined') { chain.SCHEDULED = 'failed'; return verdict('STALLED', 'SCHEDULED', `scheduler '${spec.scheduler}' is armed but not ticking (see scheduler_recovery judgments; self-heal decides restarts) — ${spec.hint}`); }
      chain.SCHEDULED = 'ok';
      if (s.status === 'failing') { chain.EXECUTED = 'failed'; return verdict('STALLED', 'EXECUTED', `scheduler '${spec.scheduler}' ticks but its last tick failed: ${s.last_error ?? 'unknown error'} — ${spec.hint}`); }
      chain.EXECUTED = s.status === 'executing' ? 'ok' : 'unknown'; // armed_pending: inside the boot grace
    }
  }
  // OUTCOME_PERSISTED
  if (obs.input) {
    const p = obs.input.value as { pending: number; last_progress: string | null };
    if (!p.last_progress || Date.parse(p.last_progress) < now - spec.window_ms) {
      chain.OUTCOME_PERSISTED = 'failed';
      return verdict('STALLED', 'OUTCOME_PERSISTED', `${p.pending} ${spec.input!.label} and no state change within ${hours(spec.window_ms)} — ${spec.hint}`);
    }
    chain.OUTCOME_PERSISTED = 'ok';
  }
  if (spec.outcome) {
    outcomeFact();
    if (!obs.outcome || 'error' in obs.outcome) { chain.OUTCOME_PERSISTED = 'unknown'; return verdict('UNKNOWN', 'OUTCOME_PERSISTED', `the outcome query failed; check ${spec.outcome.label} — ${spec.hint}`); }
    const t = obs.outcome.value;
    if (!t || Date.parse(t) < now - spec.window_ms) {
      if (chain.EXECUTED === 'unknown' && obs.scheduler?.status === 'armed_pending') { chain.OUTCOME_PERSISTED = 'unknown'; return verdict('UNKNOWN', 'EXECUTED', 'none yet: inside the boot grace, no tick so far'); }
      chain.OUTCOME_PERSISTED = 'failed';
      const link: ChainLink = chain.EXECUTED === 'ok' ? 'OUTCOME_PERSISTED' : spec.scheduler ? 'EXECUTED' : 'OUTCOME_PERSISTED';
      return verdict('STALLED', link, `enabled with its dependencies ready, but no ${spec.outcome.label} within ${hours(spec.window_ms)}${chain.EXECUTED === 'ok' ? ' although the scheduler ticks' : ''} — ${spec.hint}`);
    }
    chain.OUTCOME_PERSISTED = 'ok';
  }
  if (spec.scheduler && !spec.outcome && !spec.input && chain.EXECUTED !== 'ok') return verdict('UNKNOWN', chain.SCHEDULED === 'ok' ? 'EXECUTED' : 'SCHEDULED', `no outcome is declared and the scheduler's execution is unproven — ${spec.hint}`);
  return verdict('HEALTHY', 'OUTCOME_PERSISTED', 'none');
}

/** Every watched capability's verdict, from this process' facts (read-only). */
export function capabilityChain(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env, opts: ObserveOptions = {}, specs = CAPABILITY_SPECS): CapabilityVerdict[] {
  return specs.map((s) => classifyCapability(s, observeCapability(s, db, now, env, opts), now));
}

/** Replay: verdicts from an observation set collected elsewhere (e.g. a read-only prod probe). Unknown names are skipped. */
export function classifyObservations(observations: CapabilityObservation[], now: number, specs = CAPABILITY_SPECS): CapabilityVerdict[] {
  return observations.flatMap((o) => { const s = specs.find((x) => x.name === o.name); return s ? [classifyCapability(s, o, now)] : []; });
}

export const isAnomaly = (v: CapabilityVerdict) => v.state === 'STALLED' || v.state === 'BLOCKED' || v.state === 'MISCONFIGURED';
