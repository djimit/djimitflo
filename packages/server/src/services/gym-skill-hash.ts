import { createHash } from 'crypto';

/**
 * §16 step 9 for gym outcomes: the same canonical shape as maker-genome skillContentHash ({ examples, genome_id, rules,
 * template_hash }). A gym attempt gets no K1 examples and no memory rules; what shapes it is the task kind's assignment and the
 * trial genome's strategy lines, so the hash changes exactly when the genome or the task kind changes. Leaf module on purpose:
 * maker-genome imports loop-service, which the gym services must not load.
 */
export function gymSkillContentHash(kind: string | undefined, genomeId: string | null | undefined): string {
  return createHash('sha256').update(JSON.stringify({ examples: [], genome_id: genomeId ?? null, rules: [], template_hash: `gym:${kind || 'repair'}` })).digest('hex');
}
