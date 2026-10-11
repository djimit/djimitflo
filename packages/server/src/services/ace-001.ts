import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { cosine } from './proposal-dedupe';
import { wilson } from './evolution-estimators';

/**
 * ACE-001 (operator 10-10, protocol docs/research/ace/ACE-001_PROTOCOL.md): a 2×2 factorial on real oracle-lane maker goals
 * (test-gap, exports, mutation). Two factors change only what the maker reads; gates, checkers and the scope gate are the same
 * in every arm.
 *   R (retrieval): 0 = today's context; 1 = + top-3 KB pages by cosine of the goal's proposal embedding (>= 0.3)
 *   S (examples):  0 = today's K1 examples (2 most recent verified tests of the lane; mutation gets none); 1 = the 2 verified
 *                  tests of the same lane whose proposal embedding is closest to this goal's proposal
 * Arm = sha256('ace-001:' + goal id) mod 4, so every run of a goal lands in one arm. Retrieval is synchronous: it uses vectors
 * already stored at proposal insert (proposal_embeddings) and KB ingest (kb_pages) — no network call on the assignment path.
 * A goal whose proposal has no stored vector keeps the control context in that factor and records `fallback` (intent to treat).
 * MEMORY_HOLDOUT_RATE stays independent (own salt): rules are withheld orthogonally, analysis stratifies by it.
 *   ACE_001_MODE=on (default off)
 */
export const ace001On = (env: NodeJS.ProcessEnv = process.env): boolean => env.ACE_001_MODE === 'on';
export const ACE_001_TARGET_PER_ARM = 50;
export const ACE_ARMS = ['00', '01', '10', '11'] as const;
export type AceArm = typeof ACE_ARMS[number];
export interface AceContext { arm: AceArm; lane: AceLane; examples_source: 'recency' | 'similarity' | 'fallback_recency'; kb_paths: string[]; fallback: Array<'r' | 's'> }
export type AceLane = 'test-gap' | 'mutation';

export function aceArm(goalId: string): { r: 0 | 1; s: 0 | 1; code: AceArm } {
  const x = parseInt(createHash('sha256').update(`ace-001:${goalId}`).digest('hex').slice(0, 8), 16) % 4;
  const r = (x >> 1) as 0 | 1; const s = (x & 1) as 0 | 1;
  return { r, s, code: `${r}${s}` as AceArm };
}

/** The oracle lane of a goal and its proposal id, or null when the goal is not an oracle-lane goal. */
export function aceLane(db: Database, goalId: string | null): { lane: AceLane; improvementId: string } | null {
  if (!goalId) return null;
  const row = db.prepare('SELECT s.id, s.evidence_refs_json AS r FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as { id: string; r: string | null } | undefined;
  const refs = row?.r ?? '';
  if (refs.includes('"mutation-gap:')) return { lane: 'mutation', improvementId: row!.id };
  if (refs.includes('"test-gap:')) return { lane: 'test-gap', improvementId: row!.id };
  return null;
}

const vec = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
function proposalVector(db: Database, id: string): Float32Array | null {
  try {
    const row = db.prepare('SELECT vector FROM proposal_embeddings WHERE proposal_id = ?').get(id) as { vector: Buffer } | undefined;
    return row ? vec(row.vector) : null;
  } catch { return null; }
}

/** S=1: the k verified tests of the same lane whose proposal vector is closest to this goal's proposal (artifact must exist). */
export function similarExamples(db: Database, improvementId: string, lane: AceLane, checkoutPath: string, k = 2): string[] | null {
  const q = proposalVector(db, improvementId);
  if (!q) return null;
  const ref = lane === 'mutation' ? '%"mutation-gap:%' : '%"test-gap:%';
  const rows = db.prepare(`SELECT s.title, json_extract(s.grounding_json, '$.artifactPath') AS artifact, e.vector FROM self_improvements s
    JOIN proposal_embeddings e ON e.proposal_id = s.id
    WHERE s.status = 'verified' AND s.id <> ? AND s.evidence_refs_json LIKE ? AND s.grounding_json IS NOT NULL`).all(improvementId, ref) as Array<{ title: string; artifact: string | null; vector: Buffer }>;
  const hits = rows.map((r) => ({ r, v: vec(r.vector) })).filter((x) => x.v.length === q.length && x.r.artifact && fs.existsSync(path.join(checkoutPath, x.r.artifact)))
    .map((x) => ({ r: x.r, score: cosine(q, x.v) })).sort((a, b) => b.score - a.score).slice(0, k);
  return hits.length ? hits.map((h) => `${h.r.artifact} — ${h.r.title}`) : null;
}

/** R=1: top-k KB pages by cosine to the goal's proposal (P1: a page whose body no longer matches its ingest sha is skipped). */
export function similarKbPages(db: Database, improvementId: string, k = 3, min = 0.3): Array<{ path: string; title: string; body: string; score: number }> | null {
  const q = proposalVector(db, improvementId);
  if (!q) return null;
  let rows: Array<{ path: string; title: string; body: string; sha: string; vector: Buffer }> = [];
  try { rows = db.prepare('SELECT path, title, body, sha, vector FROM kb_pages').all() as typeof rows; } catch { return []; }
  // ponytail: full scan (~1.3k pages × 2048 dims per maker assignment, a few ms); move to Qdrant when the corpus passes ~20k pages
  return rows.filter((r) => createHash('sha256').update(r.body).digest('hex') === r.sha)
    .map((r) => ({ r, v: vec(r.vector) })).filter((x) => x.v.length === q.length)
    .map((x) => ({ path: x.r.path, title: x.r.title, body: x.r.body, score: cosine(q, x.v) }))
    .filter((h) => h.score >= min).sort((a, b) => b.score - a.score).slice(0, k);
}

/** Per-arm evidence (production maker outcomes carrying `ace-001-arm:<RS>`): n, verified, graded mean, tokens, Wilson 95 %. */
export function ace001Evidence(db: Database, since: string, env: NodeJS.ProcessEnv = process.env) {
  let rows: Array<{ arm: string; success: number; tokens: number; graded: number | null }> = [];
  try {
    rows = db.prepare(`SELECT substr(r.value, 13) AS arm, o.success, o.tokens_used AS tokens,
        (SELECT CAST(substr(g.value, 8) AS REAL) FROM json_each(o.evidence_refs_json) g WHERE g.value LIKE 'graded:%' LIMIT 1) AS graded
      FROM skill_outcomes o, json_each(o.evidence_refs_json) r
      WHERE r.value LIKE 'ace-001-arm:%' AND o.skill_id NOT LIKE 'loop-maker:gym:%' AND o.created_at >= ?`).all(since) as typeof rows;
  } catch { /* skill_outcomes absent */ }
  const arms = Object.fromEntries(ACE_ARMS.map((a) => {
    const r = rows.filter((x) => x.arm === a); const v = r.filter((x) => x.success).length;
    const g = r.map((x) => x.graded).filter((x): x is number => x !== null && Number.isFinite(x));
    return [a, { n: r.length, verified: v, verified_rate: r.length ? +(v / r.length).toFixed(3) : null, ci: r.length ? wilson(v, r.length) : null,
      graded_n: g.length, graded_mean: g.length ? +(g.reduce((s, x) => s + x, 0) / g.length).toFixed(3) : null,
      tokens_mean: r.length ? Math.round(r.reduce((s, x) => s + (x.tokens || 0), 0) / r.length) : null }];
  })) as Record<AceArm, { n: number; verified: number; verified_rate: number | null; ci: [number, number] | null; graded_n: number; graded_mean: number | null; tokens_mean: number | null }>;
  const reached = ACE_ARMS.every((a) => arms[a].n >= ACE_001_TARGET_PER_ARM);
  const main = (pick: (a: AceArm) => boolean) => {
    const on = ACE_ARMS.filter(pick); const off = ACE_ARMS.filter((a) => !pick(a));
    const sum = (as: readonly AceArm[], f: 'n' | 'verified') => as.reduce((s, a) => s + arms[a][f], 0);
    const pOn = sum(on, 'n') ? sum(on, 'verified') / sum(on, 'n') : null; const pOff = sum(off, 'n') ? sum(off, 'verified') / sum(off, 'n') : null;
    return { on_n: sum(on, 'n'), off_n: sum(off, 'n'), diff: pOn !== null && pOff !== null ? +(pOn - pOff).toFixed(3) : null };
  };
  return { mode: env.ACE_001_MODE ?? null, target_per_arm: ACE_001_TARGET_PER_ARM, arms,
    main_effects: { retrieval: main((a) => a[0] === '1'), examples: main((a) => a[1] === '1') },
    status: reached ? 'analysable' as const : 'collecting' as const,
    note: 'Production maker outcomes of oracle-lane goals by ACE-001 arm (R = KB retrieval, S = similarity examples). Interim diffs are descriptive only; the pre-registered analysis (docs/research/ace/ACE-001_PROTOCOL.md) runs once every arm reaches the target.' };
}
