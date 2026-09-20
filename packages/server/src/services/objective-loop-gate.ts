/**
 * objective-loop-gate — pure gating logic for whether a goal is allowed to
 * be dispatched to a real objective-mode maker/checker cycle
 * (LoopService.startObjectiveLoop) instead of the safe, no-op
 * doc-drift-and-small-fix-loop.
 *
 * This is the first path in the codebase where a goal's own free text
 * reaches a real code-writing maker worker unsupervised — deliberately
 * more conservative than the self-improvement refinement loop's precedent
 * (SELF_IMPROVEMENT_REFINEMENT_ENABLED/_MAX_PER_TICK): default off, a
 * per-tick cap of 1 (not 3) since this spawns a real, potentially
 * minutes-long maker subprocess against a shared runtime pool per attempt
 * rather than a cheap LLM call, and restricted to low-risk
 * self-improvement-sourced goals only until it proves out.
 *
 * Kept as pure functions (no DB/daemon dependency) so the qualification
 * logic is trivially unit-testable in isolation, mirroring authority-gate.ts.
 */

const OBJECTIVE_LOOP_MAX_PER_TICK_CEILING = 3;

export function objectiveModeEnabled(): boolean {
  return process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_ENABLED === 'true';
}

export function objectiveModeMaxPerTick(): number {
  const n = Number(process.env.SELF_IMPROVEMENT_OBJECTIVE_LOOP_MAX_PER_TICK ?? '1');
  const normalized = Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  return Math.min(OBJECTIVE_LOOP_MAX_PER_TICK_CEILING, normalized);
}

export interface ObjectiveModeQualification {
  qualifies: boolean;
  reason: string;
}

export function goalQualifiesForObjectiveMode(
  goal: { risk_class: string; metadata: Record<string, unknown> },
): ObjectiveModeQualification {
  if (goal.metadata?.source !== 'self-improvement') {
    return { qualifies: false, reason: 'not_self_improvement_source' };
  }
  if (goal.risk_class !== 'low') {
    return { qualifies: false, reason: `risk_class_not_low:${goal.risk_class}` };
  }
  return { qualifies: true, reason: 'qualifies' };
}
