import { CONFIDENCE_FLOOR } from './checker-second-opinion';
import type { JudgmentDef } from '../judgment-service';

/**
 * G3: is a paper or repository that a fleet agent discovered worth Djimitflo's attention? The taxonomy match in
 * ingestDiscovery is only a topic gate; this asks whether the discovery touches an open Djimitflo problem (the evidence
 * pack's failing gates and failure causes) or a technique a loop lane could try. SHADOW ONLY: nothing acts on it yet;
 * the goal is to measure how much fleet input is relevant (plan G3: >= 50% of carded discoveries).
 */
export const discoveryRelevance: JudgmentDef = {
  id: 'discovery_relevance',
  questions: {
    relevance: {
      type: 'choice',
      instructions: 'How does the discovery (`title`, `note`) relate to Djimitflo, an agent orchestration control plane that improves its own code through a self-improvement loop (test-gap, mutation-gap and export lanes, maker/checker agents, expert panels, an evolution gym)? `open_problems` lists what currently fails.',
      criteria: {
        open_problem: 'Directly addresses one of `open_problems`.',
        lane_technique: 'A concrete technique a lane or agent could try: test generation, mutation testing, program repair, code review, agent evaluation, prompt or tool-use strategy for coding agents.',
        adjacent: 'About AI or agents in general, but with no concrete use for Djimitflo.',
        off_topic: 'Unrelated to Djimitflo (other domains, pure theory, hardware, quantum, clinical, ...).',
      },
    },
    actionable: { type: 'noul', instructions: 'Could a developer turn this discovery into a testable change or a gym experiment for Djimitflo within a week?' },
  },
  decide(a) {
    const relevance = a.relevance?.choice; const confidence = a.relevance?.confidence ?? 0; const actionable = a.actionable?.noul;
    const reason = `relevance=${relevance ?? 'none'} conf=${confidence.toFixed(2)} actionable=${actionable === undefined ? 'na' : actionable.toFixed(2)}`;
    if (!relevance || confidence < CONFIDENCE_FLOOR) return { decision: 'uncertain', reason };
    return { decision: (relevance === 'open_problem' || relevance === 'lane_technique') && (actionable ?? 0) >= 0.5 ? 'yes' : 'no', reason };
  },
};
