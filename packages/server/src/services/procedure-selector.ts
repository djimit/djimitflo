import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import type { GymTask } from './gym-task-miner';

/**
 * PL-001 (docs/research/procedure-loop/PL-001_PROTOCOL.md): a procedure is a maker_genomes row (gene 'procedure', origin
 * 'procedure', status 'candidate' — never 'trial', so nextTrialAttempt and the holdout epoch never see it; never 'active',
 * so strategyGenomeFor and the dream's parent never pick it; origin is not 'dream', so it is no dream exposure) whose
 * lines_json holds its lines and whose evidence_sources_json holds `{ procedure: { version, applicability, sources } }`.
 *
 * PROCEDURE_SELECTOR_MODE=off (default) | shadow. shadow: every ordinary remote gym claim (not TG-001, trial, canary or a
 * holdout task) records one `procedure_selection` judgment (mode shadow, subject the loop run): applies / does_not_apply
 * under the applicability contract, the clause that failed, and the procedure's id, version and lines digest. Nothing is
 * delivered: the claim payload and the run row are byte-identical to off. There is no `on` mode.
 */
export type ProcedureSelectorMode = 'off' | 'shadow';
export const procedureSelectorMode = (env: NodeJS.ProcessEnv = process.env): ProcedureSelectorMode => (env.PROCEDURE_SELECTOR_MODE === 'shadow' ? 'shadow' : 'off');

export type TaskKind = 'repair' | 'write_test';
const TASK_KINDS: readonly string[] = ['repair', 'write_test'];
export interface ApplicabilityContract {
  task_kinds: TaskKind[];
  lanes: string[];
  /** globs over the file the maker changes (task.source) */
  file_patterns: string[];
  required_capabilities: string[];
  /** globs over the same file; a match never applies, whatever the file patterns say */
  exclusions: string[];
}
export interface Procedure { id: string; version: number; lines: string[]; contract: ApplicabilityContract; lines_sha256: string }

/** The one seeded procedure, frozen by the PL-001 protocol (lines, order and digest). */
export const PROCEDURE_ID = 'ts-build-error-repair-v1';
export const PROCEDURE_VERSION = 1;
export const PROCEDURE_LINES: readonly string[] = [
  'Before touching any file, run the named failing test once and keep its exact error output.',
  'Read the first error in full: the file, the line, the expected value and the actual value.',
  'Make the smallest local edit in the source file that explains that error, and leave every unrelated line as it was.',
  'Prefer a null guard, an import fix or a corrected condition over new logic, a rename or a refactor.',
  'After each edit, run the same named test again; stop editing as soon as it is green.',
];
export const PROCEDURE_CONTRACT: ApplicabilityContract = {
  task_kinds: ['repair'],
  lanes: ['gym-repair'],
  file_patterns: ['packages/server/src/services/**/*.ts'],
  required_capabilities: ['prod_gates'],
  exclusions: ['**/__tests__/**', '**/*.test.ts', '**/*.d.ts', '**/*.generated.ts'],
};
/** The idea is adapted (MIT); no text is copied. */
const PROCEDURE_SOURCES = [{ source: 'ecc', ref: 'agents/build-error-resolver.md + agents/tdd-guide.md @ e49479937753c8aca5a09aa76dbe2eea1b68f187', licence: 'MIT', use: 'idea only, own wording' }];

/** Content digest of the exact lines a maker would see: sha256 of the lines joined by '\n'. */
export const linesSha256 = (lines: readonly string[]): string => createHash('sha256').update(lines.join('\n')).digest('hex');

/** Seeds the procedure row once (INSERT OR IGNORE: an existing row, and so its digest, is never rewritten). */
export function ensureProcedures(db: Database, now = new Date().toISOString()): void {
  db.prepare(`INSERT OR IGNORE INTO maker_genomes (id, parent_id, gene, lines_json, origin, status, note, created_at, updated_at, evidence_sources_json)
    VALUES (?, NULL, 'procedure', ?, 'procedure', 'candidate', ?, ?, ?, ?)`).run(PROCEDURE_ID, JSON.stringify(PROCEDURE_LINES),
    'PL-001 procedure: shadow selection (PROCEDURE_SELECTOR_MODE); its lines reach only PL-001 gym arm B (PL_001_MODE), never a production maker', now, now,
    JSON.stringify({ procedure: { version: PROCEDURE_VERSION, applicability: PROCEDURE_CONTRACT, sources: PROCEDURE_SOURCES } }));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** A procedure as stored (the digest is of the stored lines); null when absent, not a procedure, or its contract is unreadable. */
export function procedure(db: Database, id: string): Procedure | null {
  const row = db.prepare("SELECT id, lines_json, evidence_sources_json FROM maker_genomes WHERE id = ? AND gene = 'procedure'").get(id) as
    { id: string; lines_json: string; evidence_sources_json: string | null } | undefined;
  if (!row) return null;
  try {
    const lines = strings(JSON.parse(row.lines_json));
    const p = (JSON.parse(row.evidence_sources_json ?? 'null') as { procedure?: { version?: unknown; applicability?: Record<string, unknown> } } | null)?.procedure;
    const a = p?.applicability;
    if (!lines.length || !a || !Number.isInteger(p?.version)) return null;
    const contract: ApplicabilityContract = { task_kinds: strings(a.task_kinds) as TaskKind[], lanes: strings(a.lanes), file_patterns: strings(a.file_patterns),
      required_capabilities: strings(a.required_capabilities), exclusions: strings(a.exclusions) };
    return { id: row.id, version: Number(p!.version), lines, contract, lines_sha256: linesSha256(lines) };
  } catch { return null; }
}

/** A path glob: `**` any number of segments, `*` within a segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (file: string, globs: string[]): string | null => globs.find((g) => globToRegExp(g).test(file)) ?? null;

export interface TaskFeatures { kind: string; lane: string | null; file: string; capabilities: string[] }
/** What the contract is judged on: kind (none = repair), lane (a repair task's is 'gym-repair'), the maker's file, worker capabilities. */
export function taskFeatures(task: GymTask, capabilities: string[]): TaskFeatures {
  const t = task as GymTask & { kind?: unknown; lane?: unknown };
  const kind = t.kind === undefined ? 'repair' : String(t.kind);
  const lane = typeof t.lane === 'string' ? t.lane : kind === 'repair' ? 'gym-repair' : null;
  return { kind, lane, file: String(task.source ?? ''), capabilities: [...new Set(capabilities.map(String))].sort() };
}

export type ClauseName = 'task_kind' | 'lane' | 'exclusions' | 'file_patterns' | 'required_capabilities';
export interface Clause { clause: ClauseName; ok: boolean; detail: string }
export interface Selection { decision: 'applies' | 'does_not_apply'; reason: string; failed_clause: ClauseName | null; clauses: Clause[] }
/**
 * Deterministic: every clause is evaluated in this order and the first one that fails is the reason. An unknown task kind
 * never applies; an exclusion wins over a matching file pattern; every required capability must be announced.
 */
export function selectProcedure(contract: ApplicabilityContract, f: TaskFeatures): Selection {
  const excluded = matchesAny(f.file, contract.exclusions);
  const pattern = matchesAny(f.file, contract.file_patterns);
  const missing = contract.required_capabilities.filter((c) => !f.capabilities.includes(c));
  const clauses: Clause[] = [
    { clause: 'task_kind', ok: TASK_KINDS.includes(f.kind) && (contract.task_kinds as string[]).includes(f.kind),
      detail: TASK_KINDS.includes(f.kind) ? `kind ${f.kind}` : `unknown kind ${f.kind.slice(0, 40)}` },
    { clause: 'lane', ok: f.lane !== null && contract.lanes.includes(f.lane), detail: `lane ${f.lane ?? 'none'}` },
    { clause: 'exclusions', ok: !excluded, detail: excluded ? `excluded by ${excluded}` : 'no exclusion matched' },
    { clause: 'file_patterns', ok: Boolean(pattern), detail: pattern ? `matched ${pattern}` : `no pattern matched ${f.file.slice(0, 120)}` },
    { clause: 'required_capabilities', ok: !missing.length, detail: missing.length ? `missing ${missing.join(', ')}` : 'all announced' },
  ];
  const failed = clauses.find((c) => !c.ok) ?? null;
  return { decision: failed ? 'does_not_apply' : 'applies', reason: failed ? `${failed.clause}: ${failed.detail}` : 'all clauses matched', failed_clause: failed?.clause ?? null, clauses };
}

/** Shadow record for one claimed run. Never throws: a failure here must not break the claim. */
export function recordProcedureSelection(db: Database, runId: string, task: GymTask, capabilities: string[], species: string, now = new Date().toISOString()): void {
  try {
    ensureProcedures(db, now);
    const p = procedure(db, PROCEDURE_ID);
    if (!p) return;
    const features = taskFeatures(task, capabilities);
    const s = selectProcedure(p.contract, features);
    const answers = { procedure_id: p.id, procedure_version: p.version, lines_sha256: p.lines_sha256, task_key: task.commit, species, features,
      failed_clause: s.failed_clause, clauses: s.clauses, delivered: false, deterministic: true };
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
      VALUES (?, 'procedure_selection', 'loop_run', ?, ?, 'shadow', ?, ?, ?, 'policy', ?)`)
      .run(randomUUID(), runId, createHash('sha256').update(JSON.stringify(features)).digest('hex').slice(0, 16), s.decision, s.reason.slice(0, 300), JSON.stringify(answers), now);
  } catch { /* shadow bookkeeping */ }
}

/**
 * Evidence `procedure_selection`: applies / does_not_apply per window (24 h, 7 d) and the most frequent failed clauses (7 d).
 * A window without a recorded decision is null, never 0 (the selector may simply not have run).
 */
export function procedureSelectionEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const mode = procedureSelectorMode(env);
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const window = (since: string): { applies: number | null; does_not_apply: number | null } => {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(decision = 'applies'), 0) AS a, COALESCE(SUM(decision = 'does_not_apply'), 0) AS d
        FROM judgments WHERE judgment = 'procedure_selection' AND created_at >= ? AND created_at <= ?`).get(since, iso(0)) as { n: number; a: number; d: number };
      return r.n ? { applies: r.a, does_not_apply: r.d } : { applies: null, does_not_apply: null };
    } catch { return { applies: null, does_not_apply: null }; }
  };
  const window_7d = window(iso(7 * 86_400_000));
  // null without a decision in 7 d; [] when every decision applied
  let top: Array<{ clause: string; n: number }> | null = null;
  if (window_7d.applies !== null) {
    try {
      top = (db.prepare(`SELECT json_extract(answers_json, '$.failed_clause') AS clause, COUNT(*) AS n FROM judgments
        WHERE judgment = 'procedure_selection' AND decision = 'does_not_apply' AND created_at >= ? AND created_at <= ? GROUP BY 1 ORDER BY n DESC, clause LIMIT 5`)
        .all(iso(7 * 86_400_000), iso(0)) as Array<{ clause: string | null; n: number }>).map((r) => ({ clause: r.clause ?? 'unknown', n: r.n }));
    } catch { /* unreadable: null */ }
  }
  let p: Procedure | null = null;
  try { p = procedure(db, PROCEDURE_ID); } catch { /* table absent: null */ }
  return { mode, delivered: false, procedure: p ? { id: p.id, version: p.version, lines_sha256: p.lines_sha256 } : null,
    window_24h: window(iso(86_400_000)), window_7d, top_failed_clauses_7d: top };
}
