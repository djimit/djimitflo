/**
 * Grounding gate for self-improvement proposals.
 *
 * Production (2026-09-20): 91% of panel decisions were needs_more_evidence and
 * refinement converted 0.4%, because reflection/gap proposals were free text with
 * no target, so reviewers (correctly) asked for specifics nobody could supply.
 * A proposal is grounded when it names a concrete target (explicit or a repo path
 * found in its text) and carries at least one evidence ref.
 */

export interface Grounding {
  target: string;
  acceptanceTest?: string;
  baselineMetric?: string;
  derived: boolean;
}

export const GROUNDING_REQUIRED_SOURCES = new Set(['reflection', 'gap_analysis']);

const REPO_PATH = /\b(?:packages|scripts|docs|src)\/[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+|\bpackages\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*/;

export function groundingRequired(): boolean {
  return process.env.PROPOSAL_GROUNDING_REQUIRED === 'true';
}

export function assessGrounding(input: {
  description: string;
  rationale: string;
  evidenceRefs?: string[];
  grounding?: Partial<Grounding>;
}): Grounding | null {
  if (!input.evidenceRefs?.length) return null;
  const explicit = input.grounding?.target?.trim();
  if (explicit) {
    return { target: explicit, acceptanceTest: input.grounding?.acceptanceTest, baselineMetric: input.grounding?.baselineMetric, derived: false };
  }
  const match = `${input.description}\n${input.rationale}`.match(REPO_PATH);
  return match ? { target: match[0], derived: true } : null;
}
