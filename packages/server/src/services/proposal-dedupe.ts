import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { nvidiaFetch } from './content-safety';

/**
 * Plan K2a: the same improvement idea keeps arriving in other words (the fingerprint only catches exact repeats), which
 * swells the parked stock. Each new proposal is embedded (NVIDIA nemotron-3-embed-1b, ~0.2 s, 2048 dims, measured
 * 2026-09-27) and compared with the last 30 days; a cosine >= PROPOSAL_DEDUPE_THRESHOLD (0.92) records a
 * 'proposal_near_duplicate' judgment. SHADOW ONLY: nothing is merged or archived. Fail-open.
 *   PROPOSAL_DEDUPE_MODE=shadow + NVIDIA_API_KEY (default off)
 */
export const proposalDedupeEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.PROPOSAL_DEDUPE_MODE === 'shadow' && Boolean(env.NVIDIA_API_KEY);

export async function embed(text: string, fetchFn: typeof fetch = fetch, inputType: 'passage' | 'query' = 'passage'): Promise<Float32Array | null> {
  try {
    const res = await nvidiaFetch(`${(process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/embeddings`, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL || 'nvidia/nemotron-3-embed-1b', input: [text.slice(0, 8_000)], input_type: inputType, encoding_format: 'float' }),
    }, fetchFn);
    if (!res.ok) return null;
    const v = ((await res.json()) as { data?: Array<{ embedding?: number[] }> }).data?.[0]?.embedding;
    return Array.isArray(v) && v.length ? Float32Array.from(v) : null;
  } catch { return null; }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export async function checkProposalDuplicate(db: Database, proposal: { id: string; title: string; description: string }, fetchFn: typeof fetch = fetch): Promise<{ id: string; score: number } | null> {
  if (!proposalDedupeEnabled()) return null;
  db.exec('CREATE TABLE IF NOT EXISTS proposal_embeddings (proposal_id TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)');
  const v = await embed(`${proposal.title}\n${proposal.description}`, fetchFn);
  if (!v) return null;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  // a refinement / grounded child repeats its parent's text on purpose (prod 2026-09-27: commons grounding adds target +
  // test to an identical proposal → cosine 1.000); lineage is not duplication
  const refsOf = (id: string) => (db.prepare('SELECT evidence_refs_json AS r FROM self_improvements WHERE id = ?').get(id) as { r: string | null } | undefined)?.r ?? '';
  const mine = refsOf(proposal.id);
  const related = (other: string) => mine.includes(`refinement-of:${other}`) || refsOf(other).includes(`refinement-of:${proposal.id}`);
  let best: { id: string; score: number } | null = null;
  for (const row of db.prepare('SELECT proposal_id, vector FROM proposal_embeddings WHERE created_at >= ? AND proposal_id != ?').all(since, proposal.id) as Array<{ proposal_id: string; vector: Buffer }>) {
    if (related(row.proposal_id)) continue;
    const other = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4);
    const score = cosine(v, other);
    if (!best || score > best.score) best = { id: row.proposal_id, score };
  }
  const now = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO proposal_embeddings (proposal_id, model, vector, created_at) VALUES (?, ?, ?, ?)')
    .run(proposal.id, process.env.EMBEDDING_MODEL || 'nvidia/nemotron-3-embed-1b', Buffer.from(v.buffer, v.byteOffset, v.byteLength), now);
  const threshold = Number(process.env.PROPOSAL_DEDUPE_THRESHOLD) || 0.92;
  if (!best || best.score < threshold) return null;
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, model, created_at)
    VALUES (?, 'proposal_near_duplicate', 'self_improvement', ?, ?, 'shadow', 'yes', ?, ?, ?)`)
    .run(randomUUID(), proposal.id, best.id.slice(0, 16), `similar_to=${best.id} cosine=${best.score.toFixed(3)}`, process.env.EMBEDDING_MODEL || 'nvidia/nemotron-3-embed-1b', now);
  return best;
}
