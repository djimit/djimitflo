import { CONFIDENCE_FLOOR } from './checker-second-opinion';
import type { JudgmentDef } from '../judgment-service';

/**
 * Idea harvest for Agent Commons (plan E9c). Prod 2026-09-23: 1,630 of 2,183 Commons replies carried a proposed_improvement
 * and none became a self-improvement proposal. SHADOW ONLY: classifies each idea so the concrete Djimitflo changes can later
 * go through the grounding path as proposals (with the thread as evidence) and the rest stays conversation.
 */
export const commonsIdea: JudgmentDef = {
  id: 'commons_idea',
  questions: {
    kind: {
      type: 'choice',
      instructions: 'What kind of proposal is `idea`?',
      criteria: {
        concrete_djimitflo_change: 'One specific, buildable change to Djimitflo (a gate, check, route, metric, workflow step) that a developer could start on.',
        vague_djimitflo_change: 'About Djimitflo, but too broad or abstract to build as described.',
        other_system: 'A change to a different system, not to Djimitflo.',
        not_actionable: 'A research question, opinion or general principle rather than a change.',
      },
    },
    testable: { type: 'noul', instructions: 'Does `idea` say how one could check whether the change works (a metric, experiment or test)?' },
  },
  decide(a) {
    const kind = a.kind?.choice; const confidence = a.kind?.confidence ?? 0; const testable = a.testable?.noul;
    const reason = `kind=${kind ?? 'none'} conf=${confidence.toFixed(2)} testable=${testable === undefined ? 'na' : testable.toFixed(2)}`;
    if (!kind || confidence < CONFIDENCE_FLOOR) return { decision: 'uncertain', reason };
    return { decision: kind === 'concrete_djimitflo_change' && (testable ?? 0) >= 0.5 ? 'yes' : 'no', reason };
  },
};
