import type { JudgmentDef } from '../judgment-service';

/**
 * Independent second opinion on a maker diff, next to the LLM checker (which today often is the same model family as the
 * maker). One Choice question; the answer's own confidence gates it (docs: confidence-gated routing, floor 0.6).
 * SHADOW ONLY: the reason records agreement with the real checker verdict so the `judgments` table measures it
 * (`SELECT reason FROM judgments WHERE judgment = 'checker_second_opinion'`). Never a merge or security gate.
 * The checker's own notes are deliberately NOT in the state: the opinion must be independent.
 */
export const CONFIDENCE_FLOOR = 0.6;
const MAX_DIFF_CHARS = 24_000;  // jaggedness: large state full of irrelevant detail hurts — send the task and the diff only
const MAX_TASK_CHARS = 4_000;

export const checkerSecondOpinion: JudgmentDef = {
  id: 'checker_second_opinion',
  questions: {
    verdict: {
      type: 'choice',
      instructions: 'Does the change in `diff` correctly and completely do what `task` asks, without unrelated edits?',
      criteria: {
        accepted: 'The diff does what the task asks, stays within its scope, and `checks` show no failure.',
        needs_revision: 'The diff goes in the right direction but is incomplete, has a visible bug, or `checks` show a failure.',
        rejected: 'The diff does not address the task, is empty, or makes unrelated or harmful changes.',
      },
    },
    // S2 (System One review 2026-10-01, "ask atomic questions"): the holistic verdict hides several judgments. These three are
    // the semantic ones code cannot answer; file scope is checked in code (evolve on-target gate #569, auto_approved_scope).
    tests_named_behaviour: { type: 'noul', instructions: 'Do the tests added or changed in `diff` call and assert on the functions or behaviour that `task` names?' },
    weakens_assertions: { type: 'noul', instructions: 'Does `diff` delete, skip, loosen or comment out existing assertions or tests?' },
    trivial_tests: { type: 'noul', instructions: 'Are the tests added in `diff` trivial — they only check that code runs, or assert on constants or mocks instead of real outputs?' },
  },
  decide(a, facts) {
    const choice = a.verdict?.choice;
    const confidence = a.verdict?.confidence ?? 0;
    const checker = typeof facts?.checkerVerdict === 'string' ? facts.checkerVerdict : 'unknown';
    const agree = choice === checker ? 'agree' : 'disagree';
    const p = (k: string) => a[k]?.noul;
    const atomic = ['tests_named_behaviour', 'weakens_assertions', 'trivial_tests'].filter((k) => p(k) !== undefined).map((k) => `${k}=${p(k)!.toFixed(2)}`);
    const tail = `jev=${choice ?? 'none'} conf=${confidence.toFixed(2)} checker=${checker} ${agree}${atomic.length ? ` | ${atomic.join(' ')}` : ''}`;
    if (!choice || confidence < CONFIDENCE_FLOOR) return { decision: 'uncertain', reason: tail };
    // a confident 'accepted' that weakens assertions or adds only trivial tests is not an acceptance (shadow: measured, not acted on)
    const flagged = (p('weakens_assertions') ?? 0) > 0.7 || (p('trivial_tests') ?? 0) > 0.7 || (p('tests_named_behaviour') ?? 1) < 0.3;
    return { decision: choice === 'accepted' && !flagged ? 'yes' : 'no', reason: flagged && choice === 'accepted' ? `${tail} | atomic veto` : tail };
  },
};

export function checkerSecondOpinionState(task: string, diff: string, checks: unknown): { task: string; diff: string; checks: unknown } {
  return { task: task.slice(0, MAX_TASK_CHARS), diff: diff ? diff.slice(0, MAX_DIFF_CHARS) : '(empty diff)', checks };
}
