import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Intervention 3 (outcome-engineering audit 13-10): memory candidates written from a boilerplate template
 * (e.g. KnowledgeRuntimeService.closeLoopLearning's "Loop X closed with score S; preserve checker evidence…")
 * differ only in ids and numbers. A template fingerprint makes them comparable; MEMORY_TEMPLATE_DEDUP_MODE
 * decides what happens at creation. This module never deletes, promotes, retires or edits a memory row.
 */
export type MemoryTemplateDedupMode = 'off' | 'shadow' | 'enforce';

export function memoryTemplateDedupMode(env: NodeJS.ProcessEnv = process.env): MemoryTemplateDedupMode {
  const v = (env.MEMORY_TEMPLATE_DEDUP_MODE || '').trim().toLowerCase();
  return v === 'shadow' || v === 'enforce' ? v : 'off';
}

/**
 * The text with its variable parts replaced by placeholders, original casing kept. Order matters: uuids, then
 * ISO dates/timestamps, then hex ids (≥ 7 chars, at least one digit and one letter: git shas, short run ids), then
 * signed/decimal numbers and percentages; whitespace collapsed.
 */
export function templateSkeleton(content: string): string {
  return content
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, '<date>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<id>')
    .replace(/[+-]?\d+(?:\.\d+)?%?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deterministic: sha256 of the lowercased skeleton, first 16 hex chars. */
export function templateFingerprint(content: string): string {
  return createHash('sha256').update(templateSkeleton(content).toLowerCase()).digest('hex').slice(0, 16);
}

interface Row { id: string; content: string; status: string; source_ref: string | null; metadata: string | null; created_at: string }

const SCAN_LIMIT = 5000;

function scan(db: Database): Row[] {
  return db.prepare('SELECT id, content, status, source_ref, metadata, created_at FROM memory_candidates ORDER BY created_at DESC LIMIT ?').all(SCAN_LIMIT) as Row[];
}

/** Ids of existing candidates / promoted memories (any status) whose content has this fingerprint, newest first. */
export function findTemplateMatches(db: Database, fingerprint: string): Array<{ id: string; status: string }> {
  return scan(db).filter((r) => templateFingerprint(r.content) === fingerprint).map((r) => ({ id: r.id, status: r.status }));
}

/** Records the `memory_template_duplicate` judgment; subject = the new candidate (or, under enforce, the skipped content's fingerprint). */
export function recordTemplateDuplicate(db: Database, input: { subjectId: string; fingerprint: string; mode: MemoryTemplateDedupMode; matches: Array<{ id: string; status: string }>; sourceRef: string | null }): void {
  try {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'memory_template_duplicate', 'memory_candidate', ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), input.subjectId, `tpl:${input.fingerprint}`, input.mode, input.mode === 'enforce' ? 'skipped' : 'would_skip',
        `template fingerprint ${input.fingerprint} matches ${input.matches.length} existing memory row(s)`,
        JSON.stringify({ fingerprint: input.fingerprint, source_ref: input.sourceRef, refs: input.matches.map((m) => m.id), ref_statuses: input.matches }),
        new Date().toISOString());
  } catch { /* judgments table absent: candidate creation is unaffected */ }
}

/** Logs and (best effort) records a `memory_template_dedup_error` judgment; never throws, so candidate creation always proceeds. */
export function recordTemplateDedupError(db: Database, input: { mode: MemoryTemplateDedupMode; stage: 'lookup' | 'enforce' | 'record'; error: unknown; subjectId?: string; sourceRef: string | null }): void {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  try { console.warn(`[memory-template-dedup] ${input.stage} failed (${input.mode}), creating candidate normally: ${message}`); } catch { /* logging must not throw */ }
  try {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, error, answers_json, created_at)
      VALUES (?, 'memory_template_dedup_error', 'memory_candidate', ?, '', ?, 'fail_open', ?, ?, ?, ?)`)
      .run(randomUUID(), input.subjectId ?? 'pending', input.mode, `dedup ${input.stage} failed; candidate created normally`, message.slice(0, 500),
        JSON.stringify({ stage: input.stage, source_ref: input.sourceRef }), new Date().toISOString());
  } catch { /* judgments table unavailable: the log line is the record */ }
}

function sourceRun(r: Row): string | null {
  try {
    const m = r.metadata ? JSON.parse(r.metadata) : {};
    if (typeof m.loop_run_id === 'string' && m.loop_run_id) return m.loop_run_id;
  } catch { /* malformed metadata */ }
  return r.source_ref ? r.source_ref.replace(/^loop:/, '') : null;
}

/**
 * Read-only offline analysis: template groups (≥ 2 rows sharing a fingerprint) among candidates and promoted memories,
 * largest first, each with a consolidation PROPOSAL (one text + supporting runs). The proposal is never applied.
 */
export function memoryTemplateAnalysis(db: Database, opts: { minSize?: number; limit?: number } = {}) {
  const minSize = Math.max(2, opts.minSize ?? 2);
  let rows: Row[] = [];
  try { rows = scan(db); } catch { /* memory_candidates absent */ }
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const fp = templateFingerprint(r.content);
    const g = groups.get(fp); if (g) g.push(r); else groups.set(fp, [r]);
  }
  let shadowJudgments = 0;
  try { shadowJudgments = (db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'memory_template_duplicate'").get() as { n: number }).n; } catch { /* no judgments table */ }
  const out = [...groups.entries()].filter(([, g]) => g.length >= minSize).map(([fingerprint, g]) => {
    const sorted = [...g].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const runs = [...new Set(sorted.map(sourceRun).filter((x): x is string => !!x))];
    const byStatus: Record<string, number> = {};
    for (const r of sorted) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const latest = sorted[sorted.length - 1];
    const skeleton = templateSkeleton(latest.content);
    return {
      fingerprint, size: g.length, ids: sorted.map((r) => r.id),
      promoted_ids: sorted.filter((r) => r.status === 'promoted').map((r) => r.id),
      candidate_ids: sorted.filter((r) => r.status !== 'promoted').map((r) => r.id),
      by_status: byStatus, first_created_at: sorted[0].created_at, last_created_at: latest.created_at,
      distinct_source_runs: runs.length, template: skeleton,
      proposal: {
        applied: false,
        consolidated_text: `Recurring lesson (${g.length} occurrences across ${runs.length} runs, ${sorted[0].created_at.slice(0, 10)} to ${latest.created_at.slice(0, 10)}): ${skeleton}`,
        supporting_runs: runs, evidence_ids: sorted.map((r) => r.id),
      },
    };
  }).sort((a, b) => b.size - a.size || a.fingerprint.localeCompare(b.fingerprint));
  return {
    mode: memoryTemplateDedupMode(),
    scanned: rows.length, scan_limit: SCAN_LIMIT,
    rows_in_groups: out.reduce((s, g) => s + g.size, 0), group_count: out.length,
    shadow_judgments: shadowJudgments,
    groups: out.slice(0, Math.max(1, Math.min(opts.limit ?? 50, 200))),
    note: 'read-only: proposals are never applied; no memory row is deleted, promoted, retired or edited by this analysis',
  };
}
