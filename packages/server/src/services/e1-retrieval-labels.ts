import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { ContextInjectionService, type ContextResult } from './context-injection-service';
import type { E1Candidate, E1Query } from './retrieval-eval';

/**
 * E1 (docs/research/eco/E1-RRF_PROTOCOL.md): the human QUERY-level labels the RRF / raw / min-max comparison needs.
 *
 * Generator (operator-triggered, manage:config): samples real retrieval queries already logged — task intake context
 * requests (tasks.metadata.context_snapshot, query = `${title} ${description}` as routes/tasks.ts sends it) and panel KB
 * lookups (kb_retrieval judgments on a specialist_panel, query = `${topic}\n${context}` as the review service sends it) —
 * in a seeded hash order, re-runs the merged multi-source candidate collection (ContextInjectionService.collectCandidates,
 * the exact list rankContextResults ranks) once, and FREEZES it: raw score, source and trust tier of every candidate at that
 * moment, sha256-pinned. Queries whose snapshot has < 2 sources are skipped (E1 cannot use them). At most 40 tasks, ever;
 * a later run only tops up to 40 with the recorded seed and never touches an existing task.
 *
 * Storage (judgments, like #835): a task is judgment 'e1_retrieval_task', subject_type 'e1_retrieval_query', state_hash
 * 'e1_retrieval', mode 'frozen'. A label is judgment 'operator_label', the same subject, state_hash 'e1_retrieval', mode
 * 'operator_label', decision yes (≥ 1 relevant) / no (none relevant). One label per task.
 *
 * Blind: the labelling payload carries the query and, per candidate, an opaque handle, a title and an excerpt in a per-task
 * hash order — never the source, score, trust tier or the candidate id. Only the manage:config export reads them back.
 * Nothing in a prod decision path reads these rows (pinned by e1-retrieval-labels.test.ts).
 */
export const E1_MAX_TASKS = 40;
export const E1_TARGET_LABELS = 30;
export const E1_DEFAULT_SEED = 20261021;
export const E1_LABEL_SOURCE = 'operator_e1_query_labels';
const SUBJECT = 'e1_retrieval_query';
const MAX_QUERY = 4_000;

export interface FrozenCandidate { id: string; source: string; score: number; trust_level?: string; title: string; excerpt: string }
export interface E1Task {
  seed: number; origin: { kind: 'task_context' | 'panel_kb'; id: string; at: string | null }; query: string; display: string;
  candidates: FrozenCandidate[]; snapshot_sha256: string; generated_at: string;
}
/** What the labeller sees (the tests pin these key sets). */
export interface BlindCandidate { handle: string; title: string; excerpt: string }
export interface BlindTask { task_id: string; query: string; candidates: BlindCandidate[] }
export interface E1LabelQueue { task: BlindTask | null; progress: { labelled: number; tasks: number; target: number; max_tasks: number } }

export type CandidateCollector = (query: string) => Promise<ContextResult[]>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const snapshotSha = (candidates: FrozenCandidate[]) => sha(JSON.stringify(candidates.map((c) => [c.id, c.source, c.score, c.trust_level ?? null, c.title, c.excerpt])));
export const candidateHandle = (taskId: string, id: string) => `h${sha(`${taskId}|e1-handle|${id}`).slice(0, 12)}`;
const exportId = (id: string) => `c${sha(`e1-export|${id}`).slice(0, 16)}`;

interface LoggedQuery { kind: E1Task['origin']['kind']; id: string; at: string | null; query: string; display: string }

/** Every logged retrieval query, one per distinct text. Malformed rows are skipped, never fatal. */
export function loggedQueries(db: Database): LoggedQuery[] {
  const all = <T>(sql: string): T[] => { try { return db.prepare(sql).all() as T[]; } catch { return []; } };
  const out: LoggedQuery[] = [];
  for (const t of all<{ id: string; title: string; description: string; metadata: string; created_at: string | null }>(`SELECT id, title, description, metadata, created_at
    FROM tasks WHERE json_valid(metadata) AND json_extract(metadata, '$.context_snapshot') IS NOT NULL ORDER BY created_at, rowid`)) {
    let swarm = ''; try { swarm = String((JSON.parse(t.metadata) as { swarm_context?: unknown }).swarm_context ?? ''); } catch { /* json_valid passed */ }
    // routes/tasks.ts stores `${description}\n\n${context}`; the retrieval query was `${title} ${description}` before that
    const description = swarm && t.description.endsWith(`\n\n${swarm}`) ? t.description.slice(0, -(swarm.length + 2)) : t.description;
    const query = `${t.title} ${description}`.slice(0, MAX_QUERY);
    if (query.trim()) out.push({ kind: 'task_context', id: t.id, at: t.created_at, query, display: `${t.title}\n\n${description}`.slice(0, MAX_QUERY) });
  }
  for (const p of all<{ id: string; topic: string; question: string; context_json: string; at: string | null }>(`SELECT p.id, p.topic, p.question, p.context_json, MIN(j.created_at) AS at
    FROM judgments j JOIN specialist_panels p ON p.id = j.subject_id WHERE j.judgment = 'kb_retrieval' AND j.subject_type = 'specialist_panel' GROUP BY p.id ORDER BY at, p.id`)) {
    let context: unknown = {}; try { context = JSON.parse(p.context_json); } catch { /* raw text */ context = p.context_json; }
    const query = `${p.topic}\n${JSON.stringify(context).slice(0, 2_000)}`.slice(0, MAX_QUERY);
    out.push({ kind: 'panel_kb', id: p.id, at: p.at, query, display: `${p.topic}\n\n${p.question}`.slice(0, MAX_QUERY) });
  }
  const seen = new Set<string>();
  return out.filter((q) => { const k = sha(q.query.trim().toLowerCase()); if (seen.has(k)) return false; seen.add(k); return true; });
}

interface TaskRow { id: string; answers_json: string; created_at: string }
function taskRows(db: Database): TaskRow[] {
  return db.prepare(`SELECT id, answers_json, created_at FROM judgments WHERE judgment = 'e1_retrieval_task' AND subject_type = ? AND state_hash = 'e1_retrieval'
    ORDER BY created_at, rowid`).all(SUBJECT) as TaskRow[];
}
/** A task as frozen; refuses one whose candidates no longer hash to the pinned snapshot sha. */
function loadTask(row: TaskRow): E1Task {
  const task = JSON.parse(row.answers_json) as E1Task;
  if (!Array.isArray(task.candidates) || snapshotSha(task.candidates) !== task.snapshot_sha256) throw new Error('E1_SNAPSHOT_SHA_MISMATCH');
  return task;
}
interface LabelRow { task_id: string; decision: string; answers_json: string }
function labelRows(db: Database): Map<string, LabelRow> {
  const rows = db.prepare(`SELECT subject_id AS task_id, decision, answers_json FROM judgments WHERE judgment = 'operator_label' AND subject_type = ? AND state_hash = 'e1_retrieval'
    ORDER BY created_at, rowid`).all(SUBJECT) as LabelRow[];
  return new Map(rows.map((r) => [r.task_id, r]));
}

function freeze(results: ContextResult[]): FrozenCandidate[] {
  const ids = new Map<string, number>();
  return results.map((r) => {
    const key = r.concept_id || r.title || sha(r.excerpt ?? '').slice(0, 16);
    const base = `${r.source}:${key}`; const n = (ids.get(base) ?? 0) + 1; ids.set(base, n);
    const c: FrozenCandidate = { id: n > 1 ? `${base}#${n}` : base, source: r.source, score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0,
      title: clip((r.title ?? '').replace(/ \(related\)$/, ''), 200), excerpt: clip((r.excerpt ?? '').replace(/^\s*#{1,6} [^\n]*\n+/, ''), 1_500) }; // a leading section heading names the source
    if (r.trust_level) c.trust_level = r.trust_level;
    return c;
  });
}

/**
 * Samples logged queries in seeded hash order and freezes each one's merged candidate list, until E1_MAX_TASKS tasks exist.
 * The seed of the first batch is binding: a top-up reuses it whatever is passed. Network reads only through `collect`.
 */
let generating = false;
export type E1GenerateResult = { created: number; tasks: number; seed: number; pool: number; skipped_single_source: number; failed: number };
export async function generateE1Tasks(db: Database, opts: { seed?: number; collect?: CandidateCollector; now?: number } = {}): Promise<E1GenerateResult> {
  if (generating) throw new Error('E1_GENERATION_RUNNING');
  generating = true;
  try { return await generate(db, opts); } finally { generating = false; }
}
async function generate(db: Database, opts: { seed?: number; collect?: CandidateCollector; now?: number }): Promise<E1GenerateResult> {
  const existing = taskRows(db).map(loadTask);
  const seed = existing[0]?.seed ?? (Number.isSafeInteger(opts.seed) ? opts.seed! : E1_DEFAULT_SEED);
  const collect = opts.collect ?? ((q: string) => new ContextInjectionService(db).collectCandidates(q));
  const taken = new Set(existing.map((t) => `${t.origin.kind}:${t.origin.id}`));
  const pool = loggedQueries(db);
  const order = pool.filter((q) => !taken.has(`${q.kind}:${q.id}`)).map((q) => ({ q, h: sha(`${seed}:e1-sample:${q.kind}:${q.id}`) })).sort((a, b) => (a.h < b.h ? -1 : 1)).map((x) => x.q);
  let created = 0, single = 0, failed = 0;
  for (const q of order) {
    if (existing.length + created >= E1_MAX_TASKS) break;
    let results: ContextResult[];
    try { results = await collect(q.query); } catch { failed++; continue; }
    const candidates = freeze(results);
    if (new Set(candidates.map((c) => c.source)).size < 2) { single++; continue; }
    const at = new Date(opts.now ?? Date.now()).toISOString();
    const task: E1Task = { seed, origin: { kind: q.kind, id: q.id, at: q.at }, query: q.query, display: q.display, candidates, snapshot_sha256: snapshotSha(candidates), generated_at: at };
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
      VALUES (?, 'e1_retrieval_task', ?, ?, 'e1_retrieval', 'frozen', 'frozen', ?, ?, ?)`)
      .run(randomUUID(), SUBJECT, `${q.kind}:${q.id}`, `E1 frozen candidate snapshot (${candidates.length} candidates, seed ${seed})`, JSON.stringify(task), at);
    created++;
  }
  return { created, tasks: existing.length + created, seed, pool: pool.length, skipped_single_source: single, failed };
}

/** Per-task hash order of the candidates (not their score order), as opaque handles with title and excerpt only. */
function blind(taskId: string, task: E1Task): BlindTask {
  const candidates = task.candidates.map((c) => ({ c, h: sha(`${taskId}|e1-order|${c.id}`) })).sort((a, b) => (a.h < b.h ? -1 : 1))
    .map(({ c }) => ({ handle: candidateHandle(taskId, c.id), title: c.title, excerpt: c.excerpt }));
  return { task_id: taskId, query: task.display, candidates };
}

/** The next unlabelled task, blind, plus progress. Reading never writes. */
export function e1LabelQueue(db: Database): E1LabelQueue {
  const rows = taskRows(db); const labels = labelRows(db);
  const next = rows.find((r) => !labels.has(r.id));
  return { task: next ? blind(next.id, loadTask(next)) : null,
    progress: { labelled: rows.filter((r) => labels.has(r.id)).length, tasks: rows.length, target: E1_TARGET_LABELS, max_tasks: E1_MAX_TASKS } };
}

export interface E1LabelInput { task_id: unknown; relevant: unknown; none_relevant?: unknown; seconds?: unknown }
/** Validates at the trust boundary (E1_* codes → 400 / 404 / 409). One label per task; an identical repeat is a no-op. */
export function recordE1Label(db: Database, input: E1LabelInput, actor: string, now = Date.now()): { recorded: boolean; task_id: string; relevant: number } {
  const { task_id: taskId, relevant, none_relevant: none, seconds } = input;
  if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/.test(taskId)) throw new Error('E1_TASK_INVALID');
  if (!Array.isArray(relevant) || relevant.length > 100 || relevant.some((h) => typeof h !== 'string')) throw new Error('E1_RELEVANT_INVALID');
  if (none !== undefined && typeof none !== 'boolean') throw new Error('E1_NONE_INVALID');
  // 'none relevant' is an explicit answer, never an empty default
  if ((none === true) !== (relevant.length === 0)) throw new Error('E1_NONE_MISMATCH');
  if (seconds !== undefined && seconds !== null && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600)) throw new Error('E1_SECONDS_INVALID');
  const secs = typeof seconds === 'number' ? Math.round(seconds * 10) / 10 : null;
  return db.transaction(() => {
    const row = taskRows(db).find((r) => r.id === taskId);
    if (!row) throw new Error('E1_TASK_UNKNOWN');
    const task = loadTask(row);
    const byHandle = new Map(task.candidates.map((c) => [candidateHandle(taskId, c.id), c.id]));
    const handles = [...new Set(relevant as string[])];
    if (handles.some((h) => !byHandle.has(h))) throw new Error('E1_HANDLE_UNKNOWN');
    const ids = handles.map((h) => byHandle.get(h)!).sort();
    const prior = labelRows(db).get(taskId);
    if (prior) {
      const before = (JSON.parse(prior.answers_json) as { relevant: string[] }).relevant;
      if (JSON.stringify([...before].sort()) !== JSON.stringify(ids)) throw new Error('E1_ALREADY_LABELLED');
      return { recorded: false, task_id: taskId, relevant: ids.length };
    }
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, latency_ms, created_at)
      VALUES (?, 'operator_label', ?, ?, 'e1_retrieval', 'operator_label', ?, ?, ?, ?, ?)`)
      .run(randomUUID(), SUBJECT, taskId, ids.length ? 'yes' : 'no', `E1 query label: ${ids.length} of ${task.candidates.length} relevant, by ${actor}`,
        JSON.stringify({ relevant: ids, none_relevant: ids.length === 0, actor, seconds: secs, snapshot_sha256: task.snapshot_sha256, label_source: E1_LABEL_SOURCE }),
        secs === null ? 0 : Math.round(secs * 1000), new Date(now).toISOString());
    return { recorded: true, task_id: taskId, relevant: ids.length };
  })();
}

/** Exactly the input scripts/e1-rrf-score.mjs reads: one human label source, labelled tasks only, opaque ids (no prod text). */
export function exportE1Labels(db: Database): { label_source: string; protocol: string; seed: number | null; tasks: number; queries: E1Query[] } {
  const rows = taskRows(db); const labels = labelRows(db);
  const queries: E1Query[] = [];
  let seed: number | null = null;
  for (const row of rows) {
    const task = loadTask(row); seed ??= task.seed;
    const label = labels.get(row.id); if (!label) continue;
    const relevant = (JSON.parse(label.answers_json) as { relevant: string[] }).relevant.map(exportId);
    queries.push({ id: row.id, relevant, candidates: task.candidates.map((c): E1Candidate => ({ id: exportId(c.id), source: c.source, score: c.score, ...(c.trust_level ? { trust_level: c.trust_level } : {}) })) });
  }
  return { label_source: E1_LABEL_SOURCE, protocol: 'docs/research/eco/E1-RRF_PROTOCOL.md', seed, tasks: rows.length, queries };
}
