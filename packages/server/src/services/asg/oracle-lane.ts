import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { aceLane } from '../ace-001';
import { TG_LOOP } from '../tg-001';
import { digestOf, FsWorkspace, safeWorkspacePath } from './effects';
import { asgEffectiveMode, type AsgMode } from './mode';
import { defaultRegistry, TEST_PATH_PATTERN } from './macros';
import { decideRoute, extractFeatures, type AsgTaskSpec, type RouteDecision } from './router';
import { redactSecrets } from '../secret-patterns';
import type { FailureClass } from './contract';

/**
 * ASG-001 in the oracle-lane maker path (LoopWorkerExecutorService.runMaker). Only test-gap / mutation-gap goal runs; never
 * TG-001 or the gym. ASG_MODE=off: nothing here is called.
 *  - before the runtime: the deterministic route decision (decision-time features of the grounded proposal and the worktree)
 *    and the base digests of the declared targets are recorded on the lease (`metadata.asg`) and as an `asg_route` event.
 *    No real runtime has a macro adapter (none enforces a per-action allow-list), so the executed route is MICRO: the
 *    runtime runs exactly as today, within the same permissions.
 *  - after the runtime: observed vs expected effects. In `on`, a runtime that stopped on its timeout or token brake is
 *    not treated as incomplete: if its effects are bounded to the worktree (codex workspace-write sandbox, mock), all of
 *    them are inside the declared write set, and the declared test passes when the daemon runs it, the maker is
 *    `succeeded_with_incident` — execution failed, verification passed, the incident recorded separately. Every other
 *    failure keeps today's outcome. Runtimes whose external effects are unknown are never rescued.
 */
export const RUNTIME_MACRO_ADAPTERS: ReadonlySet<string> = new Set(); // none in v1 (asg-harness only, outside prod)
/** Runtimes whose effects are bounded to the worktree (so an interrupted run's effects are fully observable there). */
export function effectsBounded(runtime: string, skipPermissions: boolean): boolean {
  return runtime === 'mock' || (runtime === 'codex' && !skipPermissions);
}

export interface AsgMakerContext {
  mode: Exclude<AsgMode, 'off'>; requested: AsgMode; blocked_by: string[];
  attempt_id: string; lane: 'test-gap' | 'mutation';
  spec: AsgTaskSpec; decision: RouteDecision; route_executed: 'MICRO';
  base: { head: string | null; targets: Record<string, string | null> };
}

export interface AsgMakerOutcome {
  mode: Exclude<AsgMode, 'off'>;
  execution_status: 'succeeded' | 'failed';
  verification_status: 'passed' | 'failed' | 'not_run' | 'unavailable';
  result: 'succeeded' | 'succeeded_with_incident' | 'failed';
  rescued: boolean;
  incident: { class: FailureClass; runtime_exit: number | null; timed_out: boolean; token_budget_hit: boolean } | null;
  failure: { class: FailureClass; recoverable: boolean } | null;
  effects: { expected: string[]; observed: string[]; out_of_scope: string[]; declared_untouched: string[]; bounded: boolean };
  verifier: { command: string | null; exit: number | null; output: string } | null;
  would_verify?: boolean;
}

interface GroundingRow { title: string | null; description: string | null; grounding_json: string | null }

/** null = not an oracle-lane maker, or ASG_MODE=off. */
export function asgBeforeMaker(
  db: Database,
  run: { id: string; goal_id?: string | null; loop_name?: string | null },
  lease: { id: string; role: string; runtime: string; worktree_path?: string | null },
  git: (cwd: string, args: string[]) => string,
  env: NodeJS.ProcessEnv = process.env,
): AsgMakerContext | null {
  const eff = asgEffectiveMode(env);
  if (eff.mode === 'off') return null;
  if (lease.role !== 'maker' || !lease.worktree_path || run.loop_name === TG_LOOP || run.loop_name === 'evolution-gym') return null;
  const lane = (() => { try { return aceLane(db, run.goal_id ?? null); } catch { return null; } })();
  if (!lane) return null;
  let g: GroundingRow | undefined;
  try { g = db.prepare('SELECT s.title, s.description, s.grounding_json FROM goals x JOIN self_improvements s ON s.id = x.improvement_id WHERE x.id = ?').get(run.goal_id) as GroundingRow | undefined; } catch { g = undefined; }
  let grounding: { target?: string; artifactPath?: string; acceptanceTest?: string } = {};
  try { grounding = JSON.parse(g?.grounding_json || '{}'); } catch { grounding = {}; }
  const test = typeof grounding.artifactPath === 'string' ? grounding.artifactPath : null;
  const source = lane.lane === 'test-gap' ? (typeof grounding.target === 'string' ? grounding.target : null)
    : /MUTATE_FILE=([A-Za-z0-9_./@-]+)/.exec(grounding.acceptanceTest ?? '')?.[1] ?? null;
  // the proposal's budget: "abort if any file other than the new test file changes" — the declared write set is the test
  const declared = test ? [test] : [];
  const spec: AsgTaskSpec = {
    task_id: run.id, lane: lane.lane, prompt: `${g?.title ?? ''}\n${g?.description ?? ''}`.slice(0, 4000),
    targets: { source_path: source, test_path: test }, declared_writes: declared, capability: { write: declared },
    runtime: lease.runtime, runtime_has_macro_adapter: RUNTIME_MACRO_ADAPTERS.has(lease.runtime),
  };
  const ws = new FsWorkspace(lease.worktree_path);
  const decision = decideRoute(spec, extractFeatures(spec, ws), defaultRegistry(), { executableStates: ['eligible', 'active'], remainingBudget: Number.MAX_SAFE_INTEGER });
  const targets: Record<string, string | null> = {};
  for (const p of [source, test]) if (p && safeWorkspacePath(p)) targets[p] = digestOf(ws.read(p));
  let head: string | null = null;
  try { head = git(lease.worktree_path, ['rev-parse', 'HEAD']).trim() || null; } catch { head = null; }
  return { mode: eff.mode, requested: eff.requested, blocked_by: eff.blocked_by, attempt_id: `${lease.id}:asg`, lane: lane.lane, spec, decision, route_executed: 'MICRO', base: { head, targets } };
}

const TEST_RE = new RegExp(TEST_PATH_PATTERN);

/** The daemon's own run of the declared test (argv, never text from the proposal). null = it cannot run here. */
export function runDeclaredTest(worktree: string, testPath: string): { command: string; exit: number | null; output: string } | null {
  const m = /^(packages\/[A-Za-z0-9_-]+)\/(.+)$/.exec(testPath);
  if (!m || !TEST_RE.test(testPath) || !safeWorkspacePath(testPath)) return null;
  const pkgDir = path.join(worktree, m[1]);
  const bin = [path.join(pkgDir, 'node_modules', '.bin', 'vitest'), path.join(worktree, 'node_modules', '.bin', 'vitest')].find((b) => fs.existsSync(b));
  if (!bin) return null;
  const r = spawnSync(bin, ['run', m[2]], { cwd: pkgDir, timeout: 180_000, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', CI: '1' } });
  return { command: `vitest run ${m[2]} (cwd ${m[1]})`, exit: r.status, output: redactSecrets(`${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-600)).redacted };
}

export function asgAfterMaker(
  ctx: AsgMakerContext,
  result: { exitCode: number | null; timedOut: boolean; tokenBudgetHit?: boolean },
  changedFiles: string[],
  worktree: string,
  skipPermissions: boolean,
  runTest: (worktree: string, testPath: string) => { command: string; exit: number | null; output: string } | null = runDeclaredTest,
): AsgMakerOutcome {
  const expected = ctx.spec.declared_writes;
  const observed = [...changedFiles].sort();
  const out_of_scope = observed.filter((p) => !expected.includes(p));
  const declared_untouched = expected.filter((p) => !observed.includes(p));
  const bounded = effectsBounded(ctx.spec.runtime, skipPermissions);
  const effects = { expected, observed, out_of_scope, declared_untouched, bounded };
  const ok = result.exitCode === 0 && !result.timedOut;
  const brake = result.timedOut || result.tokenBudgetHit === true;
  const base = { mode: ctx.mode, effects, verifier: null, incident: null, failure: null, rescued: false };
  if (ok) return { ...base, execution_status: 'succeeded', verification_status: 'not_run', result: 'succeeded' };
  const incident = { class: (result.timedOut ? 'timeout_uncertain' : 'executor_exception') as FailureClass, runtime_exit: result.exitCode, timed_out: result.timedOut, token_budget_hit: result.tokenBudgetHit === true };
  const stop = (cls: FailureClass, extra: Partial<AsgMakerOutcome> = {}): AsgMakerOutcome =>
    ({ ...base, execution_status: 'failed', verification_status: 'not_run', result: 'failed', incident, failure: { class: cls, recoverable: false }, ...extra });
  if (!brake) return stop('executor_exception');
  if (!bounded) return stop('unknown_external_effect');
  if (out_of_scope.length) return stop('permission_invalid');
  if (declared_untouched.length || !ctx.spec.targets.test_path) return stop('validation_failure');
  // shadow: everything above is recorded, the test is not run (no command executes in shadow)
  if (ctx.mode === 'shadow') return { ...stop('timeout_uncertain'), would_verify: true };
  const v = runTest(worktree, ctx.spec.targets.test_path);
  if (!v) return stop('validation_failure', { verification_status: 'unavailable' });
  if (v.exit !== 0) return stop('validation_failure', { verification_status: 'failed', verifier: v });
  return { ...base, execution_status: 'failed', verification_status: 'passed', result: 'succeeded_with_incident', rescued: true, incident, verifier: v };
}
