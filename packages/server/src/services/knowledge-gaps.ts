import type { Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { failureUnits } from './intelligence-metrics';
import { CapabilityAcquisitionService } from './capability-acquisition';
import { tokenize } from './expert-resolver-service';

/**
 * K2 (batch EVO-K, 16-10): failures and expert abstentions become knowledge gaps. Before this, emitCapabilityGap had no
 * caller, resolver abstentions (no_capability_match) had no consumer and 55 regressed / maker-failure runs produced 0 gaps.
 *   KNOWLEDGE_GAP_MODE=off|shadow (default off; shadow = record only)
 * - failure recurrence: a production maker failure signature (§16 failureSignature, via failureUnits) that occurs
 *   ≥ MIN_RECURRENCES times in WINDOW_DAYS — runs attributed reviewer_failure / environment_failure left out — is recorded
 *   ONCE per signature per window as a `knowledge_gap` judgment (signature, lane, files, example runs) and announced with
 *   CapabilityAcquisitionService.emitCapabilityGap, which creates a `candidate` skill capability (skill candidates are never
 *   auto-promoted: autoPromoteFromEvidence refuses kind 'skill').
 * - expert abstention: a resolver abstention with reason no_capability_match records the same gap (source
 *   'expert_abstention', the question's tokens as capability terms — data only, never instructions).
 * Open gaps (the window) feed interest-feedback's gap trial slot only as `gap_trial_candidates` (never published terms).
 */
export type KnowledgeGapMode = 'off' | 'shadow';
export const knowledgeGapMode = (env: NodeJS.ProcessEnv = process.env): KnowledgeGapMode => (env.KNOWLEDGE_GAP_MODE === 'shadow' ? 'shadow' : 'off');
export const WINDOW_DAYS = 14;
export const MIN_RECURRENCES = 3;
const DAY = 86_400_000;

export type GapSource = 'failure_recurrence' | 'expert_abstention';
export interface KnowledgeGap {
  id: string; source: GapSource; signature: string; created_at: string;
  key?: string; lane?: string | null; gate?: string | null; error_class?: string | null; files?: string[]; example_runs?: string[];
  occurrences?: number; terms?: string[]; capability_id: string;
}

const capabilityId = (signature: string) => `knowledge-gap:${signature}`;

function hasOpenGap(db: Database, signature: string, now: number): boolean {
  return !!db.prepare("SELECT 1 FROM judgments WHERE judgment = 'knowledge_gap' AND subject_id = ? AND created_at >= ? LIMIT 1")
    .get(signature, new Date(now - WINDOW_DAYS * DAY).toISOString());
}

function recordGap(db: Database, subjectType: string, signature: string, reason: string, answers: Record<string, unknown>, exampleRun: string | null, now: number): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'knowledge_gap', ?, ?, ?, 'shadow', 'open', ?, ?, ?)`)
    .run(id, subjectType, signature, `gap:${signature}`, reason.slice(0, 300), JSON.stringify({ ...answers, capability_id: capabilityId(signature) }), new Date(now).toISOString());
  CapabilityAcquisitionService.emitCapabilityGap(`knowledge_gap:${id}`, exampleRun ?? `knowledge_gap:${id}`, capabilityId(signature), reason.slice(0, 300));
  return id;
}

/** Scan the window's production maker failures; record one gap per signature recurring ≥ MIN_RECURRENCES. Never throws. */
export function recordFailureGaps(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string[] {
  if (knowledgeGapMode(env) === 'off') return [];
  try {
    const since = new Date(now - WINDOW_DAYS * DAY).toISOString();
    let nonMaker = new Set<string>();
    try {
      nonMaker = new Set((db.prepare(`SELECT subject_id FROM judgments WHERE judgment = 'outcome_attribution' AND subject_type = 'loop_run'
        AND decision IN ('reviewer_failure', 'environment_failure')`).all() as Array<{ subject_id: string }>).map((r) => r.subject_id));
    } catch { /* no judgments: nothing to leave out */ }
    const bySig = new Map<string, { sig: NonNullable<ReturnType<typeof failureUnits>[number]['signature']>; runs: string[] }>();
    for (const u of failureUnits(db, since)) {
      if (!u.failed || !u.signature || (u.run && nonMaker.has(u.run))) continue;
      const c = bySig.get(u.signature.signature) ?? { sig: u.signature, runs: [] };
      if (u.run) c.runs.push(u.run); else c.runs.push(`at:${u.at}`);
      bySig.set(u.signature.signature, c);
    }
    const created: string[] = [];
    for (const { sig, runs } of bySig.values()) {
      if (runs.length < MIN_RECURRENCES || hasOpenGap(db, sig.signature, now)) continue;
      const examples = runs.slice(-5).filter((r) => !r.startsWith('at:'));
      const files = [...new Set(examples.flatMap((run) => {
        try {
          return (db.prepare("SELECT json_extract(metadata, '$.changed_files') AS f FROM worker_leases WHERE loop_run_id = ? AND role = 'maker'").all(run) as Array<{ f: string | null }>)
            .flatMap((r) => { try { const v = JSON.parse(r.f || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; } });
        } catch { return []; }
      }))].slice(0, 20);
      created.push(recordGap(db, 'failure_signature', sig.signature, `failure signature recurred ${runs.length}x in ${WINDOW_DAYS} d: ${sig.key}`,
        { source: 'failure_recurrence', signature: sig.signature, key: sig.key, lane: sig.lane, gate: sig.gate, error_class: sig.error_class, files, example_runs: examples, occurrences: runs.length },
        examples[examples.length - 1] ?? null, now));
    }
    return created;
  } catch (e) {
    console.warn('knowledge gaps (failures) failed:', e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** A resolver abstention with no_capability_match → one gap per term set per window. Never throws. */
export function recordAbstentionGap(db: Database, result: { question: string; abstained: boolean; reason: string | null }, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | null {
  if (knowledgeGapMode(env) === 'off' || !result.abstained || result.reason !== 'no_capability_match') return null;
  try {
    const terms = [...new Set(tokenize(result.question).filter((t) => !/\d/.test(t)))].slice(0, 12);
    if (!terms.length) return null;
    const signature = createHash('sha256').update(`expert_abstention|${[...terms].sort().join(' ')}`).digest('hex').slice(0, 16);
    if (hasOpenGap(db, signature, now)) return null;
    return recordGap(db, 'expert_question', signature, `expert resolver abstained (no_capability_match) on terms: ${terms.join(', ')}`,
      { source: 'expert_abstention', signature, terms }, null, now);
  } catch (e) {
    console.warn('knowledge gaps (abstention) failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Gaps recorded in the window, oldest first (fail-soft: no judgments table → []). */
export function openKnowledgeGaps(db: Database, now = Date.now()): KnowledgeGap[] {
  try {
    return (db.prepare("SELECT id, answers_json, created_at FROM judgments WHERE judgment = 'knowledge_gap' AND created_at >= ? ORDER BY created_at, id")
      .all(new Date(now - WINDOW_DAYS * DAY).toISOString()) as Array<{ id: string; answers_json: string | null; created_at: string }>)
      .flatMap((r) => { try { return [{ ...(JSON.parse(r.answers_json || '{}') as Omit<KnowledgeGap, 'id' | 'created_at'>), id: r.id, created_at: r.created_at }]; } catch { return []; } });
  } catch { return []; }
}

/** evolution-evidence `knowledge_gaps`: insufficient (nulls, not zeros) while the mode is off. */
export function knowledgeGapEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const mode = knowledgeGapMode(env);
  const note = `knowledge_gap judgments of the last ${WINDOW_DAYS} d: failure signatures recurring >= ${MIN_RECURRENCES}x (maker failures / regressed) and expert abstentions (no_capability_match); each announces a candidate capability (never promoted)`;
  if (mode === 'off') return { mode, status: 'insufficient' as const, window_days: WINDOW_DAYS, open: null, open_by_source: null, recurrences: null, oldest_age_days: null, capability_candidates: null, note };
  const gaps = openKnowledgeGaps(db, now);
  const bySource: Record<GapSource, number> = { failure_recurrence: 0, expert_abstention: 0 };
  for (const g of gaps) if (g.source in bySource) bySource[g.source]++;
  const failures = gaps.filter((g) => g.source === 'failure_recurrence');
  let candidates: number | null = null;
  try { candidates = (db.prepare("SELECT COUNT(*) AS n FROM swarm_capabilities WHERE id LIKE 'knowledge-gap:%' AND status = 'candidate'").get() as { n: number }).n; } catch { /* table absent: unknown */ }
  return { mode, status: 'ok' as const, window_days: WINDOW_DAYS, open: gaps.length, open_by_source: bySource,
    recurrences: failures.reduce((a, g) => a + (g.occurrences ?? 0), 0),
    oldest_age_days: gaps.length ? +((now - Date.parse(gaps[0].created_at)) / DAY).toFixed(1) : null,
    capability_candidates: candidates, note };
}
