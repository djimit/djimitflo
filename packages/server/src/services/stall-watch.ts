import fs from 'fs';
import type { Database } from 'better-sqlite3';
import { decide, expiringAdmissions } from '../execution/runtime-admission';
import { randomUUID } from 'crypto';
import { guardTick, healSchedulers, quarantinedSchedulers, selfHealMode, type RecoveryAction } from './scheduler-registry';
import { capabilityChain, isAnomaly, type CapabilityVerdict, type ObserveOptions } from './capability-chain';
import { autoFailoverMode, panelFallbackRuntime, readOllamaLimit } from './inference-failover';
import { panelInferenceStatus } from './ollama-outage-fallback';
import { experimentsReport } from './experiment-registry';
import { hostTokenStalls, hostTokenWatchMode } from './host-token-watch';

/**
 * Plan M10: Djimitflo noticed none of its own silent failures on 2026-09-27 — the workstation gym benched for 9 h, NVIDIA
 * 429s swallowed by the safety check, 42 review goals left 'running'. Each detector is one read-only query; a stall names
 * its subsystem, since when, and what to look at. GET /api/health/stalls always; hourly log lines with STALL_WATCH_ENABLED=true.
 */
export interface Stall { subsystem: string; since: string | null; detail: string }

const ago = (now: number, hours: number) => new Date(now - hours * 3_600_000).toISOString();

/**
 * Cockpit 3.0: an empty stall list is not health. Each detector reports its own status — a query that throws (missing
 * table, SQL error) is `error`, a detector whose flag is off is `not_applicable` — so a broken detector reads UNKNOWN,
 * never HEALTHY. Queries here throw on purpose; detectStallsWithHealth catches per detector.
 */
/** capped (EP6): the subsystem is idle because it reached its own budget — expected, not a stall and not unknown. */
export type DetectorStatus = 'ok' | 'error' | 'not_applicable' | 'capped';
export interface DetectorHealth { name: string; status: DetectorStatus; error?: string; detail?: string; checked_at: string }
export type StallHealth = 'HEALTHY' | 'DEGRADED' | 'UNKNOWN' | 'BREACHED';
/** capabilities: the capability chain (configured → outcome) per watched capability, with its observed facts (capability-chain.ts) */
export interface StallReport { stalls: Stall[]; detectors: DetectorHealth[]; health: StallHealth; capabilities: CapabilityVerdict[] }
/** A capability anomaly already raised by a legacy detector above is not raised twice (its verdict still lists the chain). */
const LEGACY_SUBSYSTEM: Record<string, string> = { evolution_estimates: 'estimates', evolution_gym: 'gym' };

/** The remote gym's rolling 24 h cap (EVOLUTION_GYM_REMOTE_MAX_PER_DAY): claims used, the limit, and when the oldest claim
 *  in the window ages out. Shared by claim() and the stall watch, so a gym idle at its cap is not reported as stalled. */
export function remoteGymCap(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): { used: number; max: number; capped: boolean; next_slot_at: string | null } {
  const since = new Date(now - 86_400_000).toISOString();
  const r = db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM loop_runs WHERE json_extract(metadata, '$.gym.remote_host') IS NOT NULL AND created_at >= ?").get(since) as { n: number; oldest: string | null };
  const max = Number(env.EVOLUTION_GYM_REMOTE_MAX_PER_DAY) || 24;
  return { used: r.n, max, capped: r.n >= max, next_slot_at: r.oldest ? new Date(Date.parse(r.oldest) + 86_400_000).toISOString() : null };
}

interface DeployEvent { at: string; event: string; sha: string; detail?: string }
/** Deploy log as auto-deploy.sh writes it (same file recentDeploys reads); null when the file does not exist (dev, tests). */
function readDeployLog(file: string): DeployEvent[] | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  return text.trim().split('\n').map((l) => { try { return JSON.parse(l) as DeployEvent; } catch { return null; } }).filter((e): e is DeployEvent => Boolean(e?.event));
}

/**
 * G0.2 value-anomaly alarm (prod 17–19 Oct: claude makers exited 0 with a diff ten times and every lease failed
 * maker_gate_failed:token_budget against a 1000-token cap — nothing alarmed, because nothing was idle). Report-only.
 * VALUE_ANOMALY_ALARM: off (default) | shadow (findings in the detector detail only) | on (stall events).
 */
export const VALUE_ANOMALY_WINDOW_H = 24;
/** zero_success: a consumer with at least this many finished attempts in the window and none succeeded */
export const ZERO_SUCCESS_MIN_ATTEMPTS = 5;
/** gate_always_fails: at least this many maker leases of one runtime that exited 0, every one failed by the same gate */
export const GATE_ALWAYS_FAILS_MIN_LEASES = 3;
export type ValueAnomalyMode = 'off' | 'shadow' | 'on';
export function valueAnomalyMode(env: NodeJS.ProcessEnv = process.env): ValueAnomalyMode {
  const v = (env.VALUE_ANOMALY_ALARM || '').trim().toLowerCase();
  return v === 'on' || v === 'shadow' ? v : 'off';
}

/** Health from detectors + stalls: BREACHED on any stall, UNKNOWN when a detector errored and nothing stalled. */
export function stallHealth(stalls: Stall[], detectors: DetectorHealth[]): StallHealth {
  if (stalls.length) return 'BREACHED';
  if (detectors.some((d) => d.status === 'error')) return 'UNKNOWN';
  return 'HEALTHY';
}

export function detectStallsWithHealth(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env, chainOpts: ObserveOptions = {}): StallReport {
  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T | undefined;
  const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const gymOn = env.EVOLUTION_GYM_ENABLED === 'true' || env.EVOLUTION_GYM_REMOTE_ENABLED === 'true';
  const out: Stall[] = []; const detectors: DetectorHealth[] = []; const checked_at = new Date(now).toISOString();
  const run = (name: string, applicable: boolean, fn: () => void | { capped: string }) => {
    if (!applicable) { detectors.push({ name, status: 'not_applicable', checked_at }); return; }
    try { const r = fn(); detectors.push(r ? { name, status: 'capped', detail: r.capped, checked_at } : { name, status: 'ok', checked_at }); }
    catch (e) { detectors.push({ name, status: 'error', error: (e instanceof Error ? e.message : String(e)).slice(0, 200), checked_at }); }
  };
  // 1. gym enabled but no scored outcome for 6 h (the breaker or the worker can silently idle it)
  run('gym', gymOn, () => {
    const last = one<{ t: string | null }>("SELECT MAX(created_at) AS t FROM skill_outcomes WHERE domain = 'gym'")?.t ?? null;
    if (!last || last < ago(now, 6)) {
      // EP6 (prod 10-10: the 20/day remote cap idled the gym and the cockpit read BREACHED): with the local gym off, a
      // remote gym that used its daily cap is waiting by design — alarm only when it is below its cap and still silent
      const cap = remoteGymCap(db, now, env);
      if (env.EVOLUTION_GYM_ENABLED !== 'true' && env.EVOLUTION_GYM_REMOTE_ENABLED === 'true' && cap.capped) {
        return { capped: `gym at its daily cap ${cap.used}/${cap.max}; next slot at ${cap.next_slot_at ?? 'unknown'}` };
      }
      const infra = one<{ n: number }>("SELECT COUNT(*) AS n FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym_result.reason') LIKE 'infra:%'", ago(now, 24))?.n ?? 0;
      out.push({ subsystem: 'gym', since: last, detail: `no gym outcome for > 6 h; ${infra} infra discard(s) in 24 h (circuit breaker benches a species at 3)` });
    }
    return undefined;
  });
  // 1b. per species: its last three gym attempts were all infra discards → the circuit breaker is benching it (prod 2026-09-27:
  // the workstation's only species sat out 9 h while VPS gym outcomes kept the global check quiet)
  run('gym_species', gymOn, () => {
    const species = all<{ sp: string }>("SELECT DISTINCT json_extract(metadata, '$.gym.species') AS sp FROM loop_runs WHERE loop_name = 'evolution-gym' AND created_at >= ? AND json_extract(metadata, '$.gym.species') IS NOT NULL", ago(now, 48));
    for (const { sp } of species) {
      const last = all<{ reason: string | null; created_at: string }>("SELECT json_extract(metadata, '$.gym_result.reason') AS reason, created_at FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.species') = ? AND json_extract(metadata, '$.gym.canary') IS NULL ORDER BY created_at DESC LIMIT 3", sp);
      if (last.length === 3 && last.every((r) => (r.reason ?? '').startsWith('infra:'))) out.push({ subsystem: `gym:${sp}`, since: last[2].created_at, detail: `last 3 attempts were infra discards (${(last[0].reason ?? '').slice(0, 80)}); the breaker benches this species` });
    }
  });
  // 2. a judgment failing more than 30 % of the time in the last 6 h (e.g. provider 429s). `<judgment>@local` (T1, the
  // workstation) and `<judgment>@<model>` (JEV-114 challenger) rows are shadow experiments, not production signals: their errors
  // show in the cockpit, not as stalls.
  run('judgments', true, () => {
    for (const j of all<{ judgment: string; errors: number; n: number }>("SELECT judgment, SUM(decision = 'error') AS errors, COUNT(*) AS n FROM judgments WHERE created_at >= ? AND instr(judgment, '@') = 0 GROUP BY judgment HAVING n >= 10", ago(now, 6))) {
      if (j.errors / j.n > 0.3) out.push({ subsystem: `judgment:${j.judgment}`, since: ago(now, 6), detail: `${j.errors}/${j.n} verdicts were errors in 6 h` });
    }
  });
  // 3. proposals waiting for a panel while no panel verdict came in 12 h
  run('panel', true, () => {
    const waiting = one<{ n: number }>("SELECT COUNT(*) AS n FROM self_improvements WHERE status = 'proposed' AND created_at < ?", ago(now, 12))?.n ?? 0;
    const panels = one<{ n: number }>("SELECT COUNT(*) AS n FROM judgments WHERE judgment LIKE 'panel_%' AND created_at >= ?", ago(now, 12))?.n ?? 0;
    if (waiting > 0 && panels === 0) out.push({ subsystem: 'panel', since: ago(now, 12), detail: `${waiting} proposal(s) waiting > 12 h, no panel verdict in 12 h` });
  });
  // 4. goals 'running' whose latest run ended more than 2 h ago
  run('goals', true, () => {
    const zombies = one<{ n: number; oldest: string | null }>(`SELECT COUNT(*) AS n, MIN(g.updated_at) AS oldest FROM goals g
      WHERE g.status = 'running' AND (SELECT r.status FROM loop_runs r WHERE r.goal_id = g.id ORDER BY r.created_at DESC LIMIT 1) IN ('completed', 'failed', 'cancelled')
        AND g.updated_at < ?`, ago(now, 2));
    if (zombies && zombies.n > 0) out.push({ subsystem: 'goals', since: zombies.oldest, detail: `${zombies.n} goal(s) 'running' although their latest run ended` });
  });
  // 4b. incident 17-10: proposals 'executing' whose goal is not running and whose latest run had no activity for > 2 h (a
  // restart killed the worker; the goal was 'blocked', so check 4 never saw it). A wait on a pending approval is not a stall.
  run('stuck_executing', true, () => {
    const stuck = one<{ n: number; oldest: string | null }>(`SELECT COUNT(*) AS n, MIN(last) AS oldest FROM (
        SELECT (SELECT MAX(t) FROM (SELECT r.updated_at AS t UNION ALL SELECT e.created_at FROM loop_events e WHERE e.loop_run_id = r.id)) AS last
        FROM self_improvements p JOIN goals g ON g.improvement_id = p.id
        JOIN loop_runs r ON r.id = (SELECT id FROM loop_runs WHERE goal_id = g.id ORDER BY created_at DESC LIMIT 1)
        WHERE p.status = 'executing' AND g.status != 'running'
          AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.id = json_extract(g.metadata, '$.awaiting_approval.approval_id') AND a.status = 'pending'))
      WHERE julianday(last) < julianday(?)`, ago(now, 2));
    if (stuck && stuck.n > 0) out.push({ subsystem: 'stuck_executing', since: stuck.oldest, detail: `${stuck.n} proposal(s) 'executing' while their goal is not running and their run had no activity for > 2 h (a restart may have killed the worker)` });
  });
  // 5. fleet discoveries stopped (publishers run daily). Never judged at all while enabled = no telemetry, also a stall.
  run('discoveries', env.FRONTIER_EXPERT_SOURCE_UNITS_ENABLED === 'true', () => {
    // DI-001 C: while DISCOVERY_RELEVANCE_PAUSED nothing is judged on purpose; a stall is then publishers that stopped sending
    if (env.DISCOVERY_RELEVANCE_PAUSED === 'true') {
      const received = one<{ t: string | null }>("SELECT MAX(occurred_at) AS t FROM external_events WHERE event_type LIKE 'discovery.%'")?.t ?? null;
      if (!received || received < ago(now, 36)) out.push({ subsystem: 'discoveries', since: received, detail: 'no fleet discovery received for > 36 h (discovery_relevance is paused: DISCOVERY_RELEVANCE_PAUSED)' });
      return;
    }
    const last = one<{ t: string | null }>("SELECT MAX(created_at) AS t FROM judgments WHERE judgment = 'discovery_relevance'")?.t ?? null;
    if (!last || last < ago(now, 36)) out.push({ subsystem: 'discoveries', since: last, detail: last ? 'no fleet discovery judged for > 36 h (publishers on Mac mini / Eve-V / workstation)' : 'source units are enabled but no fleet discovery was ever judged' });
  });
  // 7. RX-11: a solved gym canary (a run carrying an unsolvable test) means the oracle or the sandbox is compromised
  run('gym_canary', true, () => {
    const solved = one<{ n: number; first: string | null }>("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM loop_runs WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.canary') = 1 AND json_extract(metadata, '$.gym_result.status') = 'success' AND created_at >= ?", ago(now, 24 * 30));
    if (solved && solved.n > 0) out.push({ subsystem: 'gym:canary', since: solved.first, detail: `${solved.n} gym canary run(s) reported success — a canary cannot be solved from the source file: check the oracle and the worker sandbox` });
  });
  // 7b. prod 25-10: a pending trial item no claim could be given a task for (gym_trial_blocked, refreshed by every remote claim
  // that meets it) keeps that trial from ever completing — reported while a trial runs and the block was seen in the last 24 h
  run('trial_blocked', env.DREAM_EVOLUTION_ENABLED === 'true', () => {
    const rows = all<{ task_key: string; genomes: string; reason: string; first_seen: string }>(`SELECT task_key, group_concat(genome_id, ', ') AS genomes, MAX(reason) AS reason,
      MIN(first_seen) AS first_seen FROM gym_trial_blocked WHERE last_seen >= ? AND EXISTS (SELECT 1 FROM maker_genomes WHERE status = 'trial') GROUP BY task_key ORDER BY task_key`, ago(now, 24));
    for (const r of rows) out.push({ subsystem: 'gym:trial_blocked', since: r.first_seen, detail: `trial task ${r.task_key} cannot be served for ${r.genomes}: ${r.reason}; the trial cannot complete until it is served or settled by the operator`.slice(0, 300) });
  });
  // 8. RX-14: the nightly thermometer is on but wrote nothing for 36 h (trends cannot be backfilled)
  run('estimates', env.EVOLUTION_ESTIMATORS_ENABLED === 'true', () => {
    const last = one<{ t: string | null }>('SELECT MAX(computed_at) AS t FROM evolution_estimates')?.t ?? null;
    if (!last || last < ago(now, 36)) out.push({ subsystem: 'estimates', since: last, detail: 'EVOLUTION_ESTIMATORS_ENABLED is on but no evolution estimate was written for > 36 h' });
  });
  // 6b. prod 27-10: an active host's token refused again and again (it expired at 00:24Z; 7 h of 401s went unnoticed), or a
  // host token that expires within 7 days (host-token-watch.ts; HOST_TOKEN_WATCH_MODE=shadow)
  run('host_tokens', hostTokenWatchMode(env) === 'shadow', () => { out.push(...hostTokenStalls(db, now)); });
  // 6. a runtime admission expires within 30 days: at expiry the engine stops dispatching to that runtime
  run('runtime_admission', true, () => {
    for (const a of expiringAdmissions(now)) out.push({ subsystem: `runtime_admission:${a.runtime_id}`, since: a.expires_at, detail: `admission ${decide(a).decision} expires ${a.expires_at}; reassess (execution/runtime-admission.ts) before then` });
  });
  // 9. Cockpit 3.0: a deploy that succeeded technically but never passed the post-deploy check (auto-deploy.sh writes
  // verdict_ok ~15 min after done), or whose latest event is a failure, is not a healthy build — HTTP 200 is not readiness.
  const commit = env.DJIMITFLO_BUILD_COMMIT;
  const events = (() => { try { return readDeployLog(env.DEPLOY_LOG_PATH || '/data/deploy-log.jsonl'); } catch { return undefined; } })();
  run('deploy', Boolean(commit) && events !== null, () => {
    if (!events) throw new Error('deploy log unreadable');
    const latest = events[events.length - 1];
    if (latest && (latest.event === 'failed' || latest.event === 'paused')) out.push({ subsystem: 'deploy', since: latest.at, detail: `latest deploy event '${latest.event}' for ${latest.sha.slice(0, 8)}${latest.detail ? `: ${latest.detail}` : ''}` });
    const mine = events.filter((e) => commit && e.sha && (e.sha.startsWith(commit) || commit.startsWith(e.sha)));
    const last = mine[mine.length - 1];
    if (last?.event === 'done' && Date.parse(last.at) < now - 40 * 60_000) out.push({ subsystem: 'deploy', since: last.at, detail: `build ${commit!.slice(0, 8)} deployed but no post-deploy verdict within 40 min — functional readiness unproven` });
  });
  // OLLAMA_AUTO_FAILOVER: Ollama Cloud answered with its usage limit; opencode leases run on claude until the 30-min probe succeeds
  run('inference_limited', autoFailoverMode(env) === 'on', () => {
    const s = readOllamaLimit(db);
    if (s) out.push({ subsystem: 'inference_limited', since: s.detected_at, detail: `Ollama ${s.error_class} usage limit (via ${s.source}); opencode leases fail over to claude${s.last_probe_at ? `; last probe ${s.last_probe_at}: ${s.last_probe_result ?? ''}` : ''}`.slice(0, 300) });
  });
  // PANEL_FALLBACK_RUNTIME: the panel needs claude but the shared Claude subscription backoff holds; seats wait without a verdict
  run('inference_unavailable', panelFallbackRuntime(env) !== null, () => {
    const p = panelInferenceStatus(db, env, now);
    if (p.status === 'inference_unavailable' && p.backoff) out.push({ subsystem: 'inference_unavailable', since: p.backoff.hit_at,
      detail: `panel reviews wait: Claude subscription usage limit (via ${p.backoff.source}), backoff until ${p.backoff.until}; no attempt, quarantine or verdict meanwhile` });
  });
  // Know when to stop (SOUL.md, report-only): an experiment past its registered stop date, or at its target n in every arm,
  // without a verdict is overdue. Experiments whose protocol registers no stop date are named in the detector detail.
  let noStopDate: string[] = [];
  run('experiment_overdue', true, () => {
    const r = experimentsReport(db, env, now); noStopDate = r.no_stop_date;
    // DF-05: overdue at target n before stop_by leaves stop_by in the future — a since is never in the future, so none then
    for (const e of r.experiments.filter((x) => x.overdue)) {
      const since = e.stop_by ?? e.started_at;
      out.push({ subsystem: `experiment:${e.id}`, since: Date.parse(since) > now ? null : since, detail: `${e.overdue_reason}; record a verdict or stop it (${e.protocol})`.slice(0, 300) });
    }
  });
  const expDetector = detectors.find((d) => d.name === 'experiment_overdue' && d.status === 'ok');
  if (expDetector && noStopDate.length) expDetector.detail = `no stop date — violates know-when-to-stop: ${noStopDate.join(', ')}`;
  // P0.1 escalation: a scheduler the self-heal quarantined (no tick after its bounded restart, or no restart possible)
  run('schedulers', true, () => {
    for (const name of quarantinedSchedulers()) out.push({ subsystem: `scheduler:${name}`, since: null, detail: `scheduler '${name}' is armed but not ticking and was quarantined (see scheduler_recovery judgments); needs the operator` });
  });
  // G0.2 value anomalies: work that runs but never yields (see VALUE_ANOMALY_ALARM above); shadow keeps them out of the stalls
  const vaMode = valueAnomalyMode(env); const vaShadow: Stall[] = []; const vaSink = vaMode === 'on' ? out : vaShadow;
  run('zero_success', vaMode !== 'off', () => {
    const since = ago(now, VALUE_ANOMALY_WINDOW_H);
    for (const m of all<{ runtime: string; model: string | null; n: number; first: string }>(`SELECT runtime, json_extract(metadata, '$.model') AS model,
        COUNT(*) AS n, MIN(created_at) AS first FROM worker_leases WHERE role = 'maker' AND runtime != 'manual' AND status IN ('completed', 'failed')
        AND created_at >= ? GROUP BY runtime, model HAVING n >= ? AND SUM(status = 'completed') = 0`, since, ZERO_SUCCESS_MIN_ATTEMPTS)) {
      const species = m.model ? `${m.runtime}@${m.model}` : m.runtime;
      vaSink.push({ subsystem: `zero_success:maker:${species}`, since: m.first, detail: `0/${m.n} maker leases of ${species} completed in ${VALUE_ANOMALY_WINDOW_H} h — it runs but never yields; check its failure_reason` });
    }
    for (const c of all<{ consumer: string; n: number; first: string }>(`SELECT consumer, COUNT(*) AS n, MIN(created_at) AS first FROM llm_model_calls
        WHERE shadow = 0 AND created_at >= ? GROUP BY consumer HAVING n >= ? AND SUM(ok = 1) = 0`, since, ZERO_SUCCESS_MIN_ATTEMPTS)) {
      vaSink.push({ subsystem: `zero_success:llm:${c.consumer}`, since: c.first, detail: `0/${c.n} model calls of purpose ${c.consumer} succeeded in ${VALUE_ANOMALY_WINDOW_H} h` });
    }
  });
  run('gate_always_fails', vaMode !== 'off', () => {
    const rows = all<{ runtime: string; reason: string | null; created_at: string }>(`SELECT runtime, json_extract(metadata, '$.failure_reason') AS reason, created_at
      FROM worker_leases WHERE role = 'maker' AND runtime != 'manual' AND status IN ('completed', 'failed') AND created_at >= ?
        AND json_extract(metadata, '$.exit_status') = 0 ORDER BY created_at`, ago(now, VALUE_ANOMALY_WINDOW_H));
    const byRuntime = new Map<string, typeof rows>();
    for (const r of rows) byRuntime.set(r.runtime, [...(byRuntime.get(r.runtime) ?? []), r]);
    for (const [runtime, leases] of byRuntime) {
      if (leases.length < GATE_ALWAYS_FAILS_MIN_LEASES) continue;
      const gatesOf = (reason: string | null) => /^maker_gate_failed:([^;]*)/.exec(reason ?? '')?.[1].split(',').filter(Boolean) ?? [];
      for (const gate of gatesOf(leases[0].reason)) {
        if (leases.every((l) => gatesOf(l.reason).includes(gate))) vaSink.push({ subsystem: `gate_always_fails:${gate}:${runtime}`, since: leases[0].created_at,
          detail: `maker gate ${gate} failed ${leases.length}/${leases.length} ${runtime} leases that exited 0 in ${VALUE_ANOMALY_WINDOW_H} h — a gate rejecting every clean exit is likely misconfigured (e.g. a budget cap)` });
      }
    }
  });
  for (const name of ['zero_success', 'gate_always_fails']) {
    const d = detectors.find((x) => x.name === name && x.status === 'ok');
    const mine = vaShadow.filter((s) => s.subsystem.startsWith(`${name}:`));
    if (d && mine.length) d.detail = `shadow (VALUE_ANOMALY_ALARM=shadow, not raised): ${mine.map((s) => s.subsystem).join(', ')}`.slice(0, 500);
  }
  // Workstream B: the capability chain — an enabled capability with a disabled dependency, a misconfigured path, a ticking
  // scheduler without outcomes, or pending work without progress is a stall; idle by design (flag off, cap, no input) is not
  let capabilities: CapabilityVerdict[] = [];
  run('capabilities', true, () => {
    capabilities = capabilityChain(db, now, env, chainOpts);
    for (const v of capabilities.filter(isAnomaly)) {
      if (out.some((s) => s.subsystem === LEGACY_SUBSYSTEM[v.component])) continue;
      // since = the newest evidence the chain stopped at (last outcome / state change / tick), not the observation time
      const since = v.facts.map((f) => f.at).filter((t): t is string => Boolean(t) && t !== checked_at).sort().pop() ?? null;
      out.push({ subsystem: `capability:${v.component}`, since, detail: `${v.state} at ${v.link}: ${v.facts.map((f) => f.fact).join('; ')}`.slice(0, 500) });
    }
  });
  return { stalls: out, detectors, health: stallHealth(out, detectors), capabilities };
}

/** Compatibility: the stalls only (callers that need detector health use detectStallsWithHealth). */
export function detectStalls(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Stall[] {
  return detectStallsWithHealth(db, now, env).stalls;
}

/**
 * O1a (re-20261029 C-reliability §3a: stalls were log-only, 0/20 non-CI defects caught by a monitor): each NEW stall subsystem
 * is persisted as one `judgments` row (judgment 'stall', subject = subsystem, decision 'open', answers = detail + since); a
 * subsystem open since the previous tick is not new. One that disappeared gets one 'cleared' row, so it is new again when it
 * returns and the previous tick is read back from the rows (a deploy restart does not re-announce ongoing stalls). Returns
 * the new stalls. Fail-soft: without a judgments table nothing is new.
 */
export function recordStallTransitions(db: Database, stalls: Stall[], now = new Date()): Stall[] {
  try {
    const open = new Set((db.prepare(`SELECT subject_id, decision FROM judgments j WHERE judgment = 'stall' AND rowid = (SELECT MAX(rowid) FROM judgments
        WHERE judgment = 'stall' AND subject_id = j.subject_id)`).all() as Array<{ subject_id: string; decision: string }>)
      .filter((r) => r.decision === 'open').map((r) => r.subject_id));
    const at = now.toISOString();
    const insert = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'stall', 'subsystem', ?, ?, 'annotation', ?, ?, ?, ?)`);
    const current = new Map(stalls.map((s) => [s.subsystem, s]));
    const fresh = [...current.values()].filter((s) => !open.has(s.subsystem));
    db.transaction(() => {
      for (const s of fresh) insert.run(randomUUID(), s.subsystem, s.since ?? '', 'open', s.detail.slice(0, 300), JSON.stringify({ detail: s.detail, since: s.since }), at);
      for (const subsystem of open) if (!current.has(subsystem)) insert.run(randomUUID(), subsystem, '', 'cleared', 'no longer reported by the stall watch', null, at);
    })();
    return fresh;
  } catch { return []; }
}

/** One stall-watch tick: detect, log every stall, persist the new ones and hand each new one to `notify` (the operator push). */
export async function stallWatchTick(db: Database, notify?: (s: Stall) => Promise<unknown>, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<Stall[]> {
  const stalls = detectStalls(db, now, env);
  for (const s of stalls) console.warn(`🚨 stall: ${s.subsystem} since ${s.since ?? 'never'} — ${s.detail}`);
  const fresh = recordStallTransitions(db, stalls, new Date(now));
  for (const s of fresh) { try { await notify?.(s); } catch { /* a push never breaks the watch */ } }
  return fresh;
}

export function startStallWatch(db: Database, intervalMs = 3_600_000, notify?: (s: Stall) => Promise<unknown>): (() => void) | null {
  if (process.env.STALL_WATCH_ENABLED !== 'true') return null;
  const tick = guardTick('stall_watch', () => { void stallWatchTick(db, notify).catch((e) => console.warn('stall watch failed:', e instanceof Error ? e.message : String(e))); });
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}

/** Each recovery action as a `scheduler_recovery` judgment (failure_id, strategy, attempt, result, next_action). Fail-soft. */
export function recordRecoveryActions(db: Database, actions: RecoveryAction[]): void {
  for (const a of actions) {
    try {
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
        VALUES (?, 'scheduler_recovery', 'scheduler', ?, ?, 'annotation', ?, ?, ?, ?)`)
        .run(randomUUID(), a.scheduler, a.failure_id, a.result, `${a.strategy} attempt ${a.attempt}: ${a.result}; next: ${a.next_action}`.slice(0, 300), JSON.stringify(a), a.at);
    } catch { /* judgments table absent */ }
    console.warn(`🩹 scheduler ${a.scheduler}: ${a.result} (${a.strategy}, attempt ${a.attempt}) — next: ${a.next_action}`);
  }
}

/** Scheduler self-heal watchdog (P0.1), every 15 min; independent of the stall watch so a stuck stall watch is healed too. */
export function startSchedulerWatchdog(db: Database, intervalMs = 15 * 60_000): (() => void) | null {
  if (selfHealMode() === 'off') return null;
  const timer = setInterval(() => { try { recordRecoveryActions(db, healSchedulers()); } catch (e) { console.warn('scheduler watchdog failed:', e instanceof Error ? e.message : String(e)); } }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
