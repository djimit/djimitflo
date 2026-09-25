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
  },
  decide(a, facts) {
    const choice = a.verdict?.choice;
    const confidence = a.verdict?.confidence ?? 0;
    const checker = typeof facts?.checkerVerdict === 'string' ? facts.checkerVerdict : 'unknown';
    const agree = choice === checker ? 'agree' : 'disagree';
    const tail = `jev=${choice ?? 'none'} conf=${confidence.toFixed(2)} checker=${checker} ${agree}`;
    if (!choice || confidence < CONFIDENCE_FLOOR) return { decision: 'uncertain', reason: tail };
    return { decision: choice === 'accepted' ? 'yes' : 'no', reason: tail };
  },
};

export function checkerSecondOpinionState(task: string, diff: string, checks: unknown): { task: string; diff: string; checks: unknown } {
  return { task: task.slice(0, MAX_TASK_CHARS), diff: diff ? diff.slice(0, MAX_DIFF_CHARS) : '(empty diff)', checks };
}
