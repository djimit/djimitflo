/**
 * Fitness for the evolve-loop (plan E13, docs/design/evolve-loop.md). Pure: maker results in, ranking out. Computed in
 * code only — no model decides the winner. Hard gates first; among the survivors: higher mutation score on the target,
 * then the smaller diff, then fewer tokens, then the earliest finisher.
 */
export interface EvolveCandidate {
  makerLeaseId: string;
  species: string;            // runtime and/or prompt variant, e.g. "opencode", "codex"
  exitZero: boolean;
  checksPassed: boolean;
  withinBudget: boolean;      // diff size and allowed paths
  mutationScore: number | null; // 0..100 on the grounding target; null when not measured
  diffLines: number;
  tokens: number | null;
  finishedAt: string;
}

export interface RankedCandidate extends EvolveCandidate { rank: number; eligible: boolean; reason: string }

export function rankEvolveCandidates(candidates: EvolveCandidate[]): RankedCandidate[] {
  const gate = (c: EvolveCandidate) => (!c.exitZero ? 'runtime exit != 0' : !c.checksPassed ? 'deterministic checks failed' : !c.withinBudget ? 'over budget or disallowed paths' : '');
  const scored = candidates.map((c) => ({ ...c, eligible: gate(c) === '', reason: gate(c) }));
  const cmp = (a: typeof scored[number], b: typeof scored[number]) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const ma = a.mutationScore ?? -1; const mb = b.mutationScore ?? -1;
    if (ma !== mb) return mb - ma;
    if (a.diffLines !== b.diffLines) return a.diffLines - b.diffLines;
    const ta = a.tokens ?? Number.MAX_SAFE_INTEGER; const tb = b.tokens ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.finishedAt.localeCompare(b.finishedAt);
  };
  return scored.sort(cmp).map((c, i) => ({
    ...c, rank: i + 1,
    reason: c.eligible ? (i === 0 ? 'winner' : `lost: ${c.mutationScore ?? 'n/a'} mutation score, ${c.diffLines} diff lines`) : c.reason,
  }));
}

/** The winner, or null when no candidate passes the hard gates (the run then fails like a single-maker run would). */
export function evolveWinner(ranked: RankedCandidate[]): RankedCandidate | null {
  return ranked[0]?.eligible ? ranked[0] : null;
}
