import type { Database } from 'better-sqlite3';

/**
 * GYM_NATIVE_SKILL_TOOLS (off | on, default off): the oracle-gate skill (scripts/skills/oracle-gate.mjs) reaches a remote gym
 * maker as a native tool declared from its contract, not as assignment text (Skillware, arXiv 2611.07652; PL-001 / NE-016:
 * prompt-line procedures did not help). atomic-agent 0.6.5 gets it as an MCP stdio server in its config (scripts/gym-worker.mjs).
 * Offered only on an ordinary remote gym attempt (no TG-001 / PL-001 attempt, genome trial, canary, tier probe or holdout task)
 * to a worker announcing `native_skill_tools`; never to a production maker job (that path has no claim capabilities).
 * Measured loss it targets: makers that keep editing after the oracle passed (55/946 remote gym attempts lost). Descriptive
 * evidence only, not an experiment: a prereg comes first.
 */
export const NATIVE_TOOLS_CAPABILITY = 'native_skill_tools';
export const NATIVE_SKILL_TOOLS: readonly string[] = ['oracle_gate'];
/** "Stopped after a pass": the maker started at most this many steps after its first passing gate call (the reply is one). */
export const STOP_WITHIN_STEPS = 2;
export const gymNativeSkillToolsOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.GYM_NATIVE_SKILL_TOOLS === 'on';

/** The tools a claim advertises: only with the flag on, to a worker announcing the capability, on an ordinary attempt. */
export function nativeToolsForClaim(caps: string[], ordinary: boolean, isHoldout: () => boolean, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (!gymNativeSkillToolsOn(env) || !ordinary || !caps.includes(NATIVE_TOOLS_CAPABILITY) || isHoldout()) return null;
  return [...NATIVE_SKILL_TOOLS];
}

export interface NativeToolsResult { offered: string[]; calls: number | null; results: Array<{ pass: boolean | null; digest_ok: boolean | null }>; steps_after_pass: number | null }
const count = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** The worker's report, reduced to names the server advertised, counts and verdicts (no checks, scores or mutants: NE-013). null = unusable. */
export function sanitizeNativeTools(raw: unknown, advertised: readonly string[]): NativeToolsResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    offered: (Array.isArray(r.offered) ? r.offered.map(String) : []).filter((n) => advertised.includes(n)),
    calls: count(r.calls),
    results: (Array.isArray(r.results) ? r.results : []).slice(0, 20).map((x) => ({ pass: bool((x as Record<string, unknown>)?.pass), digest_ok: bool((x as Record<string, unknown>)?.digest_ok) })),
    steps_after_pass: count(r.steps_after_pass),
  };
}

const rate = (n: number, d: number): number | null => (d ? +(n / d).toFixed(3) : null);

/**
 * Evidence (descriptive): settled remote gym attempts offered the tool in the window, how many scored attempts reported their
 * calls, how many called it, the pass rate per call and per calling attempt, and how many attempts stopped within
 * STOP_WITHIN_STEPS steps of their first pass. An attempt whose calls are unknown is `unknown`, never "not called".
 * null when loop_runs is unreadable.
 */
export function gymNativeToolsEvidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  let rows: Array<{ status: string | null; nt: string | null }>;
  try {
    rows = db.prepare(`SELECT json_extract(metadata, '$.gym_result.status') AS status, json_extract(metadata, '$.gym_result.native_tools') AS nt FROM loop_runs
      WHERE loop_name = 'evolution-gym' AND json_extract(metadata, '$.gym.native_skill_tools') IS NOT NULL AND json_extract(metadata, '$.gym_result') IS NOT NULL AND created_at >= ?`).all(since) as typeof rows;
  } catch { return null; }
  const out = { mode: env.GYM_NATIVE_SKILL_TOOLS ?? null, stop_within_steps: STOP_WITHIN_STEPS, offered: rows.length, scored: 0, reported: 0, unknown: 0, called: 0, calls: 0, calls_passed: 0,
    call_pass_rate: null as number | null, attempts_passed: 0, attempt_pass_rate: null as number | null, stopped_within_n: 0 };
  let judged = 0; // calls whose verdict the worker reported (it reports at most 20 per attempt)
  for (const r of rows) {
    if (r.status === 'discarded') continue;
    out.scored++;
    let nt: NativeToolsResult | null = null;
    try { nt = r.nt ? sanitizeNativeTools(JSON.parse(r.nt), NATIVE_SKILL_TOOLS) : null; } catch { /* unreadable = unknown */ }
    if (!nt || nt.calls === null) { out.unknown++; continue; }
    out.reported++;
    if (nt.calls === 0) continue;
    out.called++; out.calls += nt.calls;
    const passed = nt.results.filter((x) => x.pass === true).length;
    out.calls_passed += passed; judged += nt.results.length;
    if (passed) { out.attempts_passed++; if (nt.steps_after_pass !== null && nt.steps_after_pass <= STOP_WITHIN_STEPS) out.stopped_within_n++; }
  }
  out.call_pass_rate = rate(out.calls_passed, judged);
  out.attempt_pass_rate = rate(out.attempts_passed, out.called);
  return out;
}
