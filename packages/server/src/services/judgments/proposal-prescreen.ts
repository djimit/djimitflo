import { band, type JudgmentDef } from '../judgment-service';

/**
 * Cheap pre-screen of a self-improvement proposal BEFORE the (slow, inconsistent) LLM panel. Questions are narrow and
 * literal on purpose (Jev reads literally). Thresholds are a first guess: SHADOW MODE ONLY until calibrated against the
 * proposals' real outcomes (see the `judgments` table joined to self_improvements.status). No arithmetic here (weak in Jev).
 */
export const proposalPrescreen: JudgmentDef = {
  id: 'proposal_prescreen',
  questions: {
    names_file: { type: 'noul', instructions: 'Does `proposal.description` name a specific, existing source file or module path that the change would touch?' },
    verifiable: { type: 'noul', instructions: 'Could the change described in `proposal` be verified by running one command, for example a single test file?' },
    concrete: { type: 'noul', instructions: 'Does `proposal` describe one specific change to make, rather than a broad research direction or a vague aspiration?' },
    sensitive: { type: 'noul', instructions: 'Would the change described in `proposal` touch authentication, secrets, deployment, or production configuration?' },
  },
  decide(a) {
    const g = band(a.names_file?.noul, 0.3, 0.7), v = band(a.verifiable?.noul, 0.3, 0.6), c = band(a.concrete?.noul, 0.3, 0.6), s = band(a.sensitive?.noul, 0.3, 0.7);
    if (c === 'no' || g === 'no') return { decision: 'no', reason: c === 'no' ? 'not a concrete change' : 'names no concrete file' };
    if (s === 'yes') return { decision: 'uncertain', reason: 'touches a sensitive area: keep the full panel' };
    if (g === 'yes' && v === 'yes' && c === 'yes') return { decision: 'yes', reason: 'concrete, file-anchored and verifiable' };
    return { decision: 'uncertain', reason: 'mixed signals: keep the full panel' };
  },
};
