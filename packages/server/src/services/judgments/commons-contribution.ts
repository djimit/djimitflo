import { CONFIDENCE_FLOOR } from './checker-second-opinion';
import type { JudgmentDef } from '../judgment-service';

/**
 * Guardrail for Agent Commons replies (WS-G / E9). Prod 2026-09-23: ~250 messages/day, 1,079 `social.learning` messages and
 * only 67 promoted memories; threads restate each other and drift off topic. SHADOW ONLY: records what each reply
 * contributes and whether it adds anything new, so a rule (end the thread on restatement/off_topic, turn evidence and
 * next steps into claims) can be calibrated before anything acts on it. One call, two questions (docs: parallel questions).
 */
export const commonsContribution: JudgmentDef = {
  id: 'commons_contribution',
  questions: {
    contribution: {
      type: 'choice',
      instructions: 'What does `message` mainly contribute to the discussion of `topic`?',
      criteria: {
        evidence: 'Concrete evidence: an observed fact, measurement, file, log or result that bears on the topic.',
        falsifiable_next_step: 'A specific experiment or check that could show the idea is wrong.',
        counterargument: 'A reasoned challenge to an earlier claim in `earlier`.',
        restatement: 'Mostly repeats what `earlier` already says, in other words.',
        off_topic: 'Not about `topic`.',
      },
    },
    novel: { type: 'noul', instructions: 'Does `message` state something that none of the messages in `earlier` already states?' },
  },
  decide(a) {
    const kind = a.contribution?.choice; const confidence = a.contribution?.confidence ?? 0; const novel = a.novel?.noul;
    const reason = `jev=${kind ?? 'none'} conf=${confidence.toFixed(2)} novel=${novel === undefined ? 'na' : novel.toFixed(2)}`;
    if (!kind || confidence < CONFIDENCE_FLOOR) return { decision: 'uncertain', reason };
    const useful = (kind === 'evidence' || kind === 'falsifiable_next_step' || kind === 'counterargument') && (novel ?? 0) >= 0.5;
    return { decision: useful ? 'yes' : 'no', reason };
  },
};
