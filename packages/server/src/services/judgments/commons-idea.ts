import { CONFIDENCE_FLOOR } from './checker-second-opinion';
import type { JudgmentDef } from '../judgment-service';

/**
 * Idea harvest for Agent Commons (plan E9c). Prod 2026-09-23: 1,630 of 2,183 Commons replies carried a proposed_improvement
 * and none became a self-improvement proposal. SHADOW ONLY: classifies each idea so the concrete Djimitflo changes can later
 * go through the grounding path as proposals (with the thread as evidence) and the rest stays conversation.
 */
// Prod 2026-09-24: 59/64 'yes'. `testable` was ~0.98 on every idea (residents are prompted to name a metric), and ideas for
// DjimitKBWiki/GraphStore were read as Djimitflo changes. So: Djimitflo is spelled out, and `grounded` replaces `testable`.
export const commonsIdea: JudgmentDef = {
  id: 'commons_idea',
  questions: {
    kind: {
      type: 'choice',
      instructions: 'What kind of proposal is `idea`? Djimitflo is the agent orchestration control plane: its self-improvement loop, gates, approvals, proposals, judgments, Agent Commons, daemon and dashboard.',
      criteria: {
        concrete_djimitflo_change: 'One specific, buildable change to Djimitflo itself (a gate, check, route, metric, workflow step) that a developer could start on.',
        vague_djimitflo_change: 'About Djimitflo, but too broad or abstract to build as described.',
        other_system: 'A change to a different system — DjimitKBWiki, Qdrant/GraphStore, roborev or any other Djimit or external system — not to Djimitflo.',
        not_actionable: 'A research question, opinion or general principle rather than a change.',
      },
    },
    grounded: { type: 'noul', instructions: 'Does `idea` respond to a concrete problem observed in Djimitflo itself (a failing gate, a stuck or parked proposal, a funnel or outcome number, a repeated error), rather than to a general topic?' },
  },
  decide(a) {
    const kind = a.kind?.choice; const confidence = a.kind?.confidence ?? 0; const grounded = a.grounded?.noul;
    const reason = `kind=${kind ?? 'none'} conf=${confidence.toFixed(2)} grounded=${grounded === undefined ? 'na' : grounded.toFixed(2)}`;
    if (!kind || confidence < CONFIDENCE_FLOOR) return { decision: 'uncertain', reason };
    return { decision: kind === 'concrete_djimitflo_change' && (grounded ?? 0) >= 0.5 ? 'yes' : 'no', reason };
  },
};
