import { CONFIDENCE_FLOOR } from './checker-second-opinion';
import type { JudgmentDef } from '../judgment-service';

/**
 * Dream-state step 2 (plan E11): classify why a loop run failed or blocked. Prod 2026-09-23 showed the causes are mostly the
 * platform, not the proposal (root-owned .git, invisible new files, a dropped JSON brace, lockfile install noise), and each
 * was found by hand. SHADOW ONLY: the recorded causes feed consolidation (recurring cause → engineering rule) and grounded
 * fix proposals in later dream steps.
 */
export const FAILURE_CAUSES = ['infra', 'environment_noise', 'parse_error', 'scope_violation', 'wrong_approach', 'missing_context', 'flaky_check'] as const;

export const failureCause: JudgmentDef = {
  id: 'failure_cause',
  questions: {
    cause: {
      type: 'choice',
      instructions: 'What is the main reason the loop run in `run` failed or was blocked?',
      criteria: {
        infra: 'The platform could not do its job: permissions, missing worktree, service unreachable, expired approval, disk.',
        environment_noise: 'Unrelated changes appeared in the workspace (for example a lockfile rewritten by an install), not the intended change.',
        parse_error: 'A reviewer or tool produced an answer that could not be read (malformed or missing verdict, unreadable output).',
        scope_violation: 'The change touched files or behaviour outside what the task allowed.',
        wrong_approach: 'The change itself is wrong or incomplete for the task.',
        missing_context: 'A reviewer could not judge because evidence was missing (no diff, no logs, no source).',
        flaky_check: 'A check failed for reasons unrelated to the change and would likely pass on a retry.',
      },
    },
    platform_fault: { type: 'noul', instructions: 'Was the failure caused by the platform, environment or tooling rather than by the proposed change itself?' },
  },
  decide(a) {
    const cause = a.cause?.choice; const confidence = a.cause?.confidence ?? 0; const pf = a.platform_fault?.noul;
    const reason = `cause=${cause ?? 'none'} conf=${confidence.toFixed(2)} platform_fault=${pf === undefined ? 'na' : pf.toFixed(2)}`;
    if (!cause || confidence < CONFIDENCE_FLOOR) return { decision: 'uncertain', reason };
    return { decision: (pf ?? 0) > 0.5 ? 'yes' : 'no', reason }; // yes = platform fault
  },
};
