import { CONFIDENCE_FLOOR } from './checker-second-opinion';
import type { JudgmentDef } from '../judgment-service';

/**
 * Intake triage for ungrounded proposals (status needs_grounding). Prod 2026-09-23: nothing consumes that status, and the
 * reflection source parks ~26 free-text proposals there per night (e.g. ideas for other ecosystem systems, research
 * directions). SHADOW ONLY: records which ones are concrete Djimitflo changes worth grounding vs archive candidates, so an
 * archive/ground rule can be calibrated before anything acts on it. One Choice; confidence-gated like the checker opinion.
 */
export const reflectionTriage: JudgmentDef = {
  id: 'reflection_triage',
  questions: {
    kind: {
      type: 'choice',
      instructions: 'What does `proposal` ask for?',
      criteria: {
        djimitflo_change: 'One concrete change to the Djimitflo code base itself (its server, dashboard, loops, approvals, tests or scripts).',
        other_system: 'A change to a different system (for example DjimitKBWiki, roborev, Qdrant, a wiki or an external service), not to the Djimitflo code base.',
        aspiration: 'A broad idea, research direction or capability wish without one concrete change to make.',
      },
    },
  },
  decide(a) {
    const kind = a.kind?.choice; const confidence = a.kind?.confidence ?? 0;
    const reason = `jev=${kind ?? 'none'} conf=${confidence.toFixed(2)}`;
    if (!kind || confidence < CONFIDENCE_FLOOR) return { decision: 'uncertain', reason };
    return { decision: kind === 'djimitflo_change' ? 'yes' : 'no', reason };
  },
};
