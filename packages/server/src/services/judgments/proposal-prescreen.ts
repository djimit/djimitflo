import { existsSync } from 'fs';
import { resolve, sep } from 'path';
import { band, type JudgmentDef } from '../judgment-service';

/**
 * Cheap pre-screen of a self-improvement proposal BEFORE the (slow, inconsistent) LLM panel. Questions are narrow and
 * literal on purpose (Jev reads literally). Thresholds are a first guess: SHADOW MODE ONLY until calibrated against the
 * proposals' real outcomes (see the `judgments` table joined to self_improvements.status). No arithmetic here (weak in Jev).
 * Whether a named file exists is a fact the model cannot see: it is checked in code (`namedPathsExist`) and passed as `facts`.
 */
export const proposalPrescreen: JudgmentDef = {
  id: 'proposal_prescreen',
  questions: {
    names_file: { type: 'noul', instructions: 'Does `proposal.description` name a specific source file or module path that the change would touch?' },
    verifiable: { type: 'noul', instructions: 'Could the change described in `proposal` be verified by running one command, for example a single test file?' },
    concrete: { type: 'noul', instructions: 'Does `proposal` describe one specific change to make, rather than a broad research direction or a vague aspiration?' },
    sensitive: { type: 'noul', instructions: 'Would the change described in `proposal` touch authentication, secrets, deployment, or production configuration?' },
  },
  decide(a, facts) {
    const g = band(a.names_file?.noul, 0.3, 0.7), v = band(a.verifiable?.noul, 0.3, 0.6), c = band(a.concrete?.noul, 0.3, 0.6), s = band(a.sensitive?.noul, 0.3, 0.7);
    if (c === 'no' || g === 'no') return { decision: 'no', reason: c === 'no' ? 'not a concrete change' : 'names no concrete file' };
    if (facts?.pathExists === false) return { decision: 'no', reason: 'named file does not exist in the repository' };
    if (s === 'yes') return { decision: 'uncertain', reason: 'touches a sensitive area: keep the full panel' };
    if (g === 'yes' && v === 'yes' && c === 'yes') return { decision: 'yes', reason: 'concrete, file-anchored and verifiable' };
    return { decision: 'uncertain', reason: 'mixed signals: keep the full panel' };
  },
};

const PATH_RE = /(?:[\w@.-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sh|ya?ml|sql)\b/g;

/** true if any path-like token in `text` exists under `root`, false if none do, undefined if the text names no path. */
export function namedPathsExist(text: string, root: string): boolean | undefined {
  const base = resolve(root);
  const paths = [...new Set(text.match(PATH_RE) ?? [])];
  if (paths.length === 0) return undefined;
  return paths.some((p) => { const full = resolve(base, p); return (full === base || full.startsWith(base + sep)) && existsSync(full); });
}
