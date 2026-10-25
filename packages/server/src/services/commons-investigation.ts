import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { AgentCommunicationService } from './agent-communication-service';
import { candidateFiles, keywords, repoRoot } from './commons-grounding';
import { parseArtefact, redactDeep, type EvidenceArtefact } from './commons-evidence-room';
import { isInfrastructureFailure } from './commons-proposal-review-service';
import { parseOutcome, settlementState } from './merge-survival';
import { extraRepoBySlug, repoRefOf } from './repo-registry';
import { guardTick, markRun, noteScheduler } from './scheduler-registry';
import { redactSecrets } from './secret-patterns';
import { readTargetExcerpt } from './self-improvement-agent-review-service';

/**
 * Commons investigation loop (AC-04 / AC-06 / AC-07 of docs/audits/agent-commons/engineering-backlog.md), one flag:
 *   COMMONS_INVESTIGATION_MODE=off (default) | shadow | on
 *
 * AC-04 evidence: a Commons question anchored on a run (`run:<id>`) or a proposal (`proposal:<id>`) gets, from durable
 *   records and the repository only, the repo revision, a path, a symbol, a bounded secret-scrubbed code excerpt
 *   (readTargetExcerpt, the panel's reader), a test excerpt, the recorded run checks, a staleness verdict and one concrete
 *   uncertainty. Every missing piece is `null` with a reason in `unavailable`, never 0 or ''. Mechanical grounding (a declared
 *   target, maker-changed files or a keyword code search) is kept apart from executed evidence (recorded check exit codes).
 *   New citable refs (`source:`, `test_source:`, `loop_run:`, `evidence_room:`) are resolved here, each with its provenance;
 *   respondSocial's whitelist (refs on the question only) is unchanged.
 * AC-06 artefacts: on an investigation thread a reply may carry `artefact` — test / repro (the evidence room's parser) or a
 *   labeled retrieval example / sourced correction (source_ref must be a ref on the thread's question). With an artefact it is
 *   recorded `evidence_status: artefact`; plain text stays `unverified`. Nothing here executes anything: a test artefact is
 *   only listed for the falsifier, which keeps its own mode and COMMONS_FALSIFIER_AGENTS allowlist (unset = none).
 * AC-07 outcomes: a proposal a Commons learning created gets one structured post in its original thread per milestone —
 *   panel decision, goal, terminal run (technical vs substantive), verification, 14-day merge survival — built from records,
 *   no LLM, idempotent per (thread, milestone).
 * shadow: everything is computed and recorded as judgments (commons_investigation_evidence / _artefact / _outcome); no
 * question, reply or thread changes. on: delivered. No new LLM call in any mode; review/admission/approval paths untouched.
 */
export type InvestigationMode = 'off' | 'shadow' | 'on';
export const investigationMode = (env: NodeJS.ProcessEnv = process.env): InvestigationMode => {
  const v = env.COMMONS_INVESTIGATION_MODE;
  return v === 'on' ? 'on' : v === 'shadow' ? 'shadow' : 'off';
};
export const INVESTIGATION_OUTCOME_AUTHOR = 'djimitflo:commons-outcome';
export const isInvestigationTopic = (topicRef: string): boolean => /^(run|proposal):[^\s]+$/.test(topicRef);

const CODE_CHARS = 1_200;
const TEST_CHARS = 500;
export const BRIEF_CHARS = 3_000;
const OUTCOME_WINDOW_DAYS = 90;
const SWEEP_LIMIT = 200;

const json = (s: unknown): Record<string, unknown> => { try { const v = typeof s === 'string' ? JSON.parse(s) : s; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return {}; } };
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const short = (sha: string) => sha.slice(0, 12);
const git = (root: string, args: string[]): string | null => {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim(); } catch { return null; }
};

export interface RecordedCheck { name: string | null; status: string | null; exit_status: number | null }
export interface RecordedResult { run_id: string; run_status: string; loop_name: string | null; revision: string | null; checks: RecordedCheck[]; failed_gates: string[]; recorded_at: string | null }
export interface InvestigationEvidence {
  version: 1;
  topic_ref: string;
  repo: { slug: string | null; revision: string | null };
  path: string | null;
  symbol: string | null;
  code: { path: string; lines: [number, number]; total_lines: number; text: string } | null;
  test: { path: string; text: string } | null;
  recorded_result: RecordedResult | null;
  stale: { value: boolean | null; reason: string };
  grounding: {
    mechanical: { method: GroundingMethod; detail: string } | null;
    executed: { run_id: string; checks_executed: number; checks_failed: number } | null;
  };
  uncertainty: string;
  refs: Array<{ ref: string; provenance: string }>;
  /** field → why it is null */
  unavailable: Record<string, string>;
}

type GroundingMethod = 'proposal_grounding' | 'maker_changed_files' | 'code_search';
interface Anchor { path: string | null; test: string | null; method: GroundingMethod; detail: string; runId: string | null; slug: string | null; missing: string | null }

const isTestPath = (p: string) => /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

function recordedResult(db: Database, runId: string): RecordedResult | null {
  let run: { id: string; status: string; loop_name: string | null; gates_json: string | null; updated_at: string | null } | undefined;
  try { run = db.prepare('SELECT id, status, loop_name, gates_json, updated_at FROM loop_runs WHERE id = ?').get(runId) as typeof run; } catch { return null; }
  if (!run) return null;
  let lease: { metadata: string | null; updated_at: string | null } | undefined;
  try { lease = db.prepare("SELECT metadata, updated_at FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(runId) as typeof lease; } catch { lease = undefined; }
  const lm = json(lease?.metadata);
  const checks = (Array.isArray(lm.deterministic_checks) ? lm.deterministic_checks : []).map((c) => {
    const o = json(c);
    return { name: str(o.name), status: str(o.status), exit_status: typeof o.exit_status === 'number' ? o.exit_status : null };
  });
  let gates: unknown = [];
  try { gates = JSON.parse(run.gates_json || '[]'); } catch { gates = []; }
  const failedGates = (Array.isArray(gates) ? gates : []).map(json).filter((g) => g.status === 'fail' && str(g.name)).map((g) => String(g.name));
  if (!checks.length && !failedGates.length) return null;
  const rev = str(json(lm.evidence_read_set).base);
  return { run_id: run.id, run_status: run.status, loop_name: run.loop_name, revision: rev && /^[0-9a-f]{7,40}$/i.test(rev) ? rev : null,
    checks, failed_gates: failedGates, recorded_at: lease?.updated_at ?? run.updated_at ?? null };
}

/** A test file in the repo that names the module (mechanical: a filename match, nothing ran). */
function testFor(root: string, file: string): string | null {
  const base = /([A-Za-z0-9_.-]+)\.[cm]?[jt]sx?$/.exec(file)?.[1];
  if (!base) return null;
  const out = git(root, ['ls-files', '--', `*__tests__/${base}.test.ts`, `*__tests__/${base}*.test.ts`]);
  return out ? out.split('\n').filter(Boolean).sort((a, b) => a.length - b.length)[0] ?? null : null;
}

function anchorFor(db: Database, topicRef: string, root: string): Anchor {
  const none = (missing: string): Anchor => ({ path: null, test: null, method: 'proposal_grounding', detail: '', runId: null, slug: null, missing });
  const [kind, id] = [topicRef.slice(0, topicRef.indexOf(':')), topicRef.slice(topicRef.indexOf(':') + 1)];
  if (kind === 'run') {
    let row: { improvement_id: string | null; grounding_json: string | null; refs: string | null } | undefined;
    try {
      row = db.prepare(`SELECT s.id AS improvement_id, s.grounding_json, s.evidence_refs_json AS refs FROM loop_runs r LEFT JOIN goals g ON g.id = r.goal_id
        LEFT JOIN self_improvements s ON s.id = COALESCE(g.improvement_id, json_extract(g.metadata, '$.improvement_id')) WHERE r.id = ?`).get(id) as typeof row;
    } catch { row = undefined; }
    if (!row) return none(`loop run ${id} not found`);
    const grounding = json(row.grounding_json);
    const slug = repoRefOf(row.refs);
    if (str(grounding.target)) return { path: str(grounding.target), test: str(grounding.acceptanceTest), method: 'proposal_grounding', detail: `grounded target of proposal ${row.improvement_id}`, runId: id, slug, missing: null };
    let changed: unknown = [];
    try { changed = json((db.prepare("SELECT metadata FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id) as { metadata: string } | undefined)?.metadata).changed_files; } catch { changed = []; }
    const files = (Array.isArray(changed) ? changed : []).filter((f): f is string => typeof f === 'string');
    const src = files.find((f) => !isTestPath(f));
    if (src) return { path: src, test: files.find(isTestPath) ?? null, method: 'maker_changed_files', detail: `first source file the maker of run ${id} changed`, runId: id, slug, missing: null };
    return { ...none(row.improvement_id ? `proposal ${row.improvement_id} has no grounded target and the maker recorded no changed files` : `run ${id} has no goal proposal and the maker recorded no changed files`), runId: id, slug };
  }
  let p: { id: string; title: string; description: string; grounding_json: string | null; refs: string | null } | undefined;
  try { p = db.prepare('SELECT id, title, description, grounding_json, evidence_refs_json AS refs FROM self_improvements WHERE id = ?').get(id) as typeof p; } catch { p = undefined; }
  if (!p) return none(`proposal ${id} not found`);
  let runId: string | null = null;
  try {
    runId = (db.prepare(`SELECT r.id FROM loop_runs r JOIN goals g ON g.id = r.goal_id WHERE g.improvement_id = ? OR json_extract(g.metadata, '$.improvement_id') = ?
      ORDER BY r.updated_at DESC, r.rowid DESC LIMIT 1`).get(id, id) as { id: string } | undefined)?.id ?? null;
  } catch { runId = null; }
  const slug = repoRefOf(p.refs);
  const grounding = json(p.grounding_json);
  if (str(grounding.target)) return { path: str(grounding.target), test: str(grounding.acceptanceTest), method: 'proposal_grounding', detail: `grounded target of proposal ${p.id}`, runId, slug, missing: null };
  if (slug) return { ...none(`proposal ${p.id} names repo ${slug} and has no grounded target; this checkout is not searched for it`), runId, slug };
  const text = `${p.title} ${p.description}`;
  const found = candidateFiles(text, root, 1)[0];
  if (!found) return { ...none(`a keyword code search for proposal ${p.id} found no candidate file`), runId };
  return { path: found, test: null, method: 'code_search', detail: `keyword code search (${keywords(text).join(', ')})`, runId, slug: null, missing: null };
}

const EXPORT = /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Evidence for a run/proposal-anchored Commons question; null for any other topic (curiosity seeds, gaps, lessons). */
export function buildInvestigationEvidence(db: Database, input: { topicRef: string; topic: string }, primaryRoot: string = repoRoot(), env: NodeJS.ProcessEnv = process.env): InvestigationEvidence | null {
  if (!isInvestigationTopic(input.topicRef)) return null;
  const unavailable: Record<string, string> = {};
  const anchor = anchorFor(db, input.topicRef, primaryRoot);
  // repo scope as the panel: a registered, enabled extra repo is read from its own checkout; any other named repo is not read
  const extra = anchor.slug ? extraRepoBySlug(anchor.slug, env) : null;
  const root = extra ? extra.path : anchor.slug ? null : primaryRoot;
  const revision = root ? git(root, ['rev-parse', 'HEAD']) : null;
  if (!revision) unavailable.revision = root ? 'repository revision unresolvable (not a git checkout)' : `repository ${anchor.slug} is not a registered, enabled repo here`;

  const path = anchor.path;
  if (!path) unavailable.path = anchor.missing ?? 'no path';
  let code: InvestigationEvidence['code'] = null; let symbol: string | null = null;
  if (path) {
    const excerpt = root ? readTargetExcerpt(path, root) : null;
    if (!excerpt) unavailable.code = root ? `no readable excerpt for ${path} (missing, too large, sensitive or outside the repository)` : `repository ${anchor.slug} is not a registered, enabled repo here`;
    else {
      const [header, ...body] = excerpt.split('\n');
      const total = Number(/\((\d+) lines/.exec(header)?.[1]) || body.length;
      const words = new Set(keywords(input.topic, 12).map((w) => w.toLowerCase()));
      const exports = body.map((l, i) => ({ i, name: EXPORT.exec(l)?.[1] })).filter((e): e is { i: number; name: string } => !!e.name);
      const pick = exports.find((e) => words.has(e.name.toLowerCase()) || input.topic.includes(e.name)) ?? exports[0];
      symbol = pick?.name ?? null;
      if (!symbol) unavailable.symbol = `no exported symbol in the first lines of ${path}`;
      let start = pick ? Math.max(0, pick.i - 3) : 0;
      while (start > 0 && body[start - 1]?.trim()) start -= 1; // keep a doc comment attached
      let text = ''; let end = start;
      for (; end < body.length && (text + body[end]).length + 1 <= CODE_CHARS; end += 1) text += `${body[end]}\n`;
      code = { path, lines: [start + 1, Math.max(start + 1, end)], total_lines: total, text: redactSecrets(text.trimEnd()).redacted };
    }
  } else { unavailable.code = 'no path to read'; }
  if (path && !symbol && !unavailable.symbol) unavailable.symbol = unavailable.code ?? 'no excerpt';
  if (!path) unavailable.symbol = 'no path to read';

  const testPath = anchor.test ?? (path && root ? testFor(root, path) : null);
  let test: InvestigationEvidence['test'] = null;
  const testExcerpt = testPath && root ? readTargetExcerpt(testPath, root) : null;
  if (testPath && testExcerpt) test = { path: testPath, text: redactSecrets(testExcerpt.split('\n').slice(1).join('\n').slice(0, TEST_CHARS).trimEnd()).redacted };
  else unavailable.test = testPath ? `test ${testPath} is not in the checkout (a new test, not yet written)` : `no test file found for ${path ?? 'the topic'}`;

  const recorded = anchor.runId ? recordedResult(db, anchor.runId) : null;
  if (!recorded) unavailable.recorded_result = anchor.runId ? `run ${anchor.runId} recorded no deterministic checks or failed gates` : 'no loop run is recorded for this topic';

  let stale: InvestigationEvidence['stale'];
  const dirty = root && path && revision ? git(root, ['status', '--porcelain', '--', path]) : null;
  if (!revision) stale = { value: null, reason: 'repository revision unresolvable' };
  else if (dirty) stale = { value: true, reason: `the working tree differs from ${short(revision)} for ${path}` };
  else if (!recorded) stale = { value: null, reason: 'no recorded result to compare' };
  else if (!recorded.revision) stale = { value: null, reason: `run ${recorded.run_id} recorded no base revision` };
  else if (revision.startsWith(recorded.revision) || recorded.revision.startsWith(revision)) stale = { value: false, reason: 'recorded at the current revision' };
  else {
    const changed = root ? git(root, ['diff', '--name-only', recorded.revision, revision, '--', ...[path, test?.path].filter((p): p is string => !!p)]) : null;
    stale = changed === null ? { value: null, reason: `recorded revision ${short(recorded.revision)} is not in this checkout` }
      : changed ? { value: true, reason: `${changed.split('\n').join(', ')} changed between the recorded ${short(recorded.revision)} and ${short(revision)}` }
        : { value: false, reason: `${path ?? 'the anchor'} unchanged since the recorded ${short(recorded.revision)}` };
  }

  const executedChecks = recorded?.checks.filter((c) => c.exit_status !== null) ?? [];
  const grounding: InvestigationEvidence['grounding'] = {
    mechanical: path ? { method: anchor.method, detail: anchor.detail } : null,
    executed: recorded && executedChecks.length ? { run_id: recorded.run_id, checks_executed: executedChecks.length, checks_failed: executedChecks.filter((c) => c.exit_status !== 0).length } : null,
  };

  // one concrete uncertainty, the most decisive first
  const uncertainty = !path ? `No code location is known for ${input.topicRef}; any file a reply names is unverified.`
    : stale.value === true && recorded?.revision ? `The recorded result of run ${recorded.run_id} is from ${short(recorded.revision)}, but ${stale.reason}; it may not hold at ${short(revision!)}.`
      : !recorded ? `No executed run or test result is recorded for ${path}; whether ${symbol ?? 'it'} behaves as the topic claims is not established.`
        : anchor.method === 'code_search' ? `${path} was matched by keyword search only, not by an executed check; it may be unrelated to the topic.`
          : !test ? `No test covering ${path} was found; a fix could not yet be checked against an existing test.`
            : code && code.lines[1] < code.total_lines ? `The excerpt shows lines ${code.lines[0]}-${code.lines[1]} of ${code.total_lines}; behaviour outside it is unseen.`
              : `Whether the recorded ${recorded.checks.length ? 'checks' : 'gates'} of run ${recorded.run_id} fail because of ${symbol ?? path} or for another reason is not established.`;

  const refs: InvestigationEvidence['refs'] = [];
  if (code && revision) refs.push({ ref: `source:${path}@${short(revision)}`, provenance: `git rev-parse HEAD + readTargetExcerpt(${path}), lines ${code.lines[0]}-${code.lines[1]}` });
  if (test && revision) refs.push({ ref: `test_source:${test.path}@${short(revision)}`, provenance: `git rev-parse HEAD + readTargetExcerpt(${test.path})` });
  if (recorded) refs.push({ ref: `loop_run:${recorded.run_id}`, provenance: `loop_runs.gates_json + maker worker_leases.metadata.deterministic_checks of run ${recorded.run_id}` });
  if (recorded) {
    try {
      const room = db.prepare("SELECT 1 FROM agent_messages WHERE from_agent = 'djimitflo:evidence-room' AND json_extract(payload_json, '$.thread_id') = ? LIMIT 1").get(`evidence-room:${recorded.run_id}`);
      if (room) refs.push({ ref: `evidence_room:evidence-room:${recorded.run_id}`, provenance: 'commons-evidence-room summary thread of this run' });
    } catch { /* no agent_messages */ }
  }
  const out = redactDeep({ version: 1 as const, topic_ref: input.topicRef, repo: { slug: anchor.slug, revision }, path, symbol, code, test, recorded_result: recorded, stale, grounding, uncertainty, refs, unavailable });
  // commit shas are git/regex-validated hex, not secrets (redactSecrets' entropy rule would otherwise mask them)
  out.repo.revision = revision;
  if (out.recorded_result && recorded) out.recorded_result.revision = recorded.revision;
  return out;
}

/** The plain text a runtime sees (structured_content.investigation_brief), ≤ BRIEF_CHARS. Deterministic. */
export function investigationBrief(ev: InvestigationEvidence): string {
  const u = (k: string) => `unavailable (${ev.unavailable[k] ?? 'not recorded'})`;
  const rec = ev.recorded_result;
  const head = [
    'Investigation evidence, built by Djimitflo from its repository and run records (read-only):',
    `Repository: ${ev.repo.slug ?? 'primary'} @ ${ev.repo.revision ? short(ev.repo.revision) : u('revision')}.`,
    `Path: ${ev.path ?? u('path')}. Symbol: ${ev.symbol ?? u('symbol')}.`,
    `Recorded result: ${rec ? `run ${rec.run_id} (${rec.run_status}) at ${rec.revision ? short(rec.revision) : 'an unrecorded revision'}: ${rec.checks.map((c) => `${c.name ?? '?'} exit ${c.exit_status ?? '?'}`).join(', ') || 'no checks'}${rec.failed_gates.length ? `; failed gates ${rec.failed_gates.join(', ')}` : ''}` : u('recorded_result')}.`,
    `Freshness: ${ev.stale.value === true ? 'STALE' : ev.stale.value === false ? 'current' : 'unknown'} (${ev.stale.reason}).`,
    `Grounding: mechanical = ${ev.grounding.mechanical ? `${ev.grounding.mechanical.method} (${ev.grounding.mechanical.detail}), not executed` : 'none'}; executed = ${ev.grounding.executed ? `${ev.grounding.executed.checks_executed} recorded check(s), ${ev.grounding.executed.checks_failed} failed (run ${ev.grounding.executed.run_id})` : 'none'}.`,
    `Uncertainty: ${ev.uncertainty}`,
    `Citable refs: ${ev.refs.map((r) => r.ref).join(', ') || 'none beyond the topic'}.`,
    'Optional artefact (else your reply is recorded unverified): "artefact": {"kind":"test","test_file":"packages/<pkg>/src/__tests__/<name>.test.ts","command":"…","content":"…"} | {"kind":"repro","command":"…"} | {"kind":"retrieval_example","query":"…","source_ref":"<citable ref>","label":"relevant|irrelevant"} | {"kind":"correction","claim":"…","correction":"…","source_ref":"<citable ref>"}. Artefacts are stored, not executed here.',
  ].join('\n');
  const room = Math.max(0, BRIEF_CHARS - head.length - 80);
  const code = ev.code ? `\nCode ${ev.code.path} lines ${ev.code.lines[0]}-${ev.code.lines[1]} of ${ev.code.total_lines}:\n${ev.code.text}`.slice(0, Math.max(0, room - (ev.test ? Math.min(room / 3, TEST_CHARS + 60) : 0))) : `\nCode: ${u('code')}`;
  const test = ev.test ? `\nTest ${ev.test.path}:\n${ev.test.text}` : `\nTest: ${u('test')}`;
  return `${head}${code}${test}`.slice(0, BRIEF_CHARS);
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function recordJudgment(db: Database, row: { judgment: string; subjectType: string; subjectId: string; stateHash: string; mode: InvestigationMode; decision: string; reason: string; answers: unknown }): boolean {
  try {
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), row.judgment, row.subjectType, row.subjectId, row.stateHash, row.mode, row.decision, row.reason.slice(0, 500), JSON.stringify(row.answers), new Date().toISOString());
    return true;
  } catch { return false; } // a judgments table is absent on minimal schemas: the round never breaks on a record
}

/** Records what an investigation question carries (shadow: would_attach) or carried (on: attached). Best-effort. */
export function recordInvestigationEvidence(db: Database, threadId: string, mode: InvestigationMode, ev: InvestigationEvidence, brief: string): void {
  recordJudgment(db, { judgment: 'commons_investigation_evidence', subjectType: 'social_thread', subjectId: threadId, stateHash: hash(ev), mode,
    decision: mode === 'on' ? 'attached' : 'would_attach',
    reason: `topic=${ev.topic_ref} path=${ev.path ?? 'none'} symbol=${ev.symbol ?? 'none'} recorded=${ev.recorded_result ? ev.recorded_result.run_id : 'none'} stale=${ev.stale.value} grounding=${ev.grounding.executed ? 'executed' : ev.grounding.mechanical ? 'mechanical' : 'none'} unavailable=${Object.keys(ev.unavailable).join(',') || 'none'}`,
    answers: { evidence: ev, brief_chars: brief.length } });
}

/** True for a thread whose question carried (on) or would have carried (shadow) investigation evidence. */
export function isInvestigationThread(db: Database, threadId: string): boolean {
  try { return !!db.prepare("SELECT 1 FROM judgments WHERE judgment = 'commons_investigation_evidence' AND subject_id = ? LIMIT 1").get(threadId); } catch { return false; }
}

export type InvestigationArtefact = EvidenceArtefact
  | { kind: 'retrieval_example'; query: string; source_ref: string; label: 'relevant' | 'irrelevant'; note?: string }
  | { kind: 'correction'; claim: string; correction: string; source_ref: string };

/** The typed artefact of an investigation reply, null when none; an invalid one throws its error code. Never executed. */
export function parseInvestigationArtefact(raw: unknown, allowedRefs: string[]): InvestigationArtefact | null {
  if (raw === undefined || raw === null) return null;
  const a = json(raw);
  if (a.kind === 'test' || a.kind === 'repro') return parseArtefact(raw);
  const text = (v: unknown, max: number, code: string): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0')) throw new Error(code);
    return v.trim();
  };
  if (a.kind !== 'retrieval_example' && a.kind !== 'correction') throw new Error('INVESTIGATION_ARTEFACT_KIND_INVALID');
  const source = text(a.source_ref, 200, 'INVESTIGATION_ARTEFACT_SOURCE_REQUIRED');
  if (!allowedRefs.includes(source)) throw new Error('INVESTIGATION_ARTEFACT_SOURCE_NOT_ALLOWED');
  if (a.kind === 'correction') return redactDeep({ kind: 'correction', claim: text(a.claim, 500, 'INVESTIGATION_ARTEFACT_CLAIM_REQUIRED'), correction: text(a.correction, 1_000, 'INVESTIGATION_ARTEFACT_CORRECTION_REQUIRED'), source_ref: source });
  if (a.label !== 'relevant' && a.label !== 'irrelevant') throw new Error('INVESTIGATION_ARTEFACT_LABEL_INVALID');
  const note = a.note === undefined || a.note === null ? undefined : text(a.note, 500, 'INVESTIGATION_ARTEFACT_NOTE_INVALID');
  return redactDeep({ kind: 'retrieval_example', query: text(a.query, 500, 'INVESTIGATION_ARTEFACT_QUERY_REQUIRED'), source_ref: source, label: a.label, ...(note ? { note } : {}) });
}

export interface InvestigationReply { evidence_status: 'artefact' | 'unverified'; artefact: InvestigationArtefact | null; rejected: string | null }

/**
 * The classification of a reply on an investigation thread, or null (mode off, or not an investigation thread: unchanged).
 * Allowed source refs = the refs on the thread's questions (the existing whitelist).
 */
export function classifyInvestigationReply(db: Database, threadId: string, raw: unknown, env: NodeJS.ProcessEnv = process.env): InvestigationReply | null {
  if (investigationMode(env) === 'off' || !isInvestigationThread(db, threadId)) return null;
  let allowed: string[] = [];
  try {
    allowed = (db.prepare("SELECT DISTINCT e.value AS ref FROM agent_messages m, json_each(m.payload_json, '$.evidence') e WHERE json_extract(m.payload_json, '$.thread_id') = ? AND json_extract(m.payload_json, '$.action') = 'social.question'")
      .all(threadId) as Array<{ ref: string }>).map((r) => r.ref);
  } catch { allowed = []; }
  try {
    const artefact = parseInvestigationArtefact(raw, allowed);
    return { evidence_status: artefact ? 'artefact' : 'unverified', artefact, rejected: null };
  } catch (e) { return { evidence_status: 'unverified', artefact: null, rejected: e instanceof Error ? e.message.slice(0, 100) : 'INVESTIGATION_ARTEFACT_INVALID' }; }
}

/** on: the params a reply message carries; evidence: the typed artefact ref. */
export function investigationReplyParams(r: InvestigationReply): Record<string, unknown> {
  return { evidence_status: r.evidence_status, artefact: r.artefact, ...(r.rejected ? { artefact_rejected: r.rejected } : {}), artefact_origin: 'investigation' };
}
export const investigationArtefactRef = (a: InvestigationArtefact): string => (a.kind === 'test' ? `test:${a.test_file}` : `artefact:${a.kind}`);

export function recordInvestigationReply(db: Database, messageId: string, mode: InvestigationMode, r: InvestigationReply): void {
  recordJudgment(db, { judgment: 'commons_investigation_artefact', subjectType: 'agent_message', subjectId: messageId, stateHash: hash(r), mode, decision: r.evidence_status,
    reason: r.artefact ? `kind=${r.artefact.kind}` : r.rejected ? `rejected=${r.rejected}` : 'no artefact', answers: r });
}

// ---- AC-07 ------------------------------------------------------------------------------------------------------------

type OutcomeKind = 'panel_decision' | 'goal' | 'run_outcome' | 'verification' | 'survival';
interface Milestone { key: string; kind: OutcomeKind; improvementId: string; ref: string; record: Record<string, unknown>; text: string }
const TERMINAL_RUN = ['completed', 'failed', 'blocked', 'escalated', 'cancelled'];
const VERIFICATION = ['verified', 'regressed', 'no_change', 'infra_failed'];

/** Proposals a Commons learning created (not the parked proposal a grounding thread discussed), with their thread. */
function originated(db: Database, since: string): Array<{ thread_id: string; message_id: string; improvement_id: string; topic: string | null; topic_ref: string | null }> {
  try {
    return db.prepare(`SELECT json_extract(payload_json, '$.thread_id') AS thread_id, id AS message_id, json_extract(payload_json, '$.params.improvement_id') AS improvement_id,
        json_extract(payload_json, '$.params.topic') AS topic, json_extract(payload_json, '$.params.topic_ref') AS topic_ref
      FROM agent_messages WHERE json_extract(payload_json, '$.action') = 'social.learning' AND json_type(payload_json, '$.params.improvement_id') = 'text'
        AND json_type(payload_json, '$.thread_id') = 'text' AND json_extract(payload_json, '$.thread_id') NOT LIKE 'evidence-room:%' AND timestamp >= ?
        AND COALESCE(json_extract(payload_json, '$.params.topic_ref'), '') <> 'proposal:' || json_extract(payload_json, '$.params.improvement_id')
      ORDER BY timestamp ASC, rowid ASC LIMIT ?`).all(since, SWEEP_LIMIT) as Array<{ thread_id: string; message_id: string; improvement_id: string; topic: string | null; topic_ref: string | null }>;
  } catch { return []; }
}

/** The proposal and its refinements (refined_from_id), depth ≤ 3. */
function lineage(db: Database, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length && out.length < 10; i += 1) {
    try { for (const r of db.prepare('SELECT id FROM self_improvements WHERE refined_from_id = ? ORDER BY created_at').all(out[i]) as Array<{ id: string }>) if (!out.includes(r.id)) out.push(r.id); } catch { break; }
  }
  return out;
}

function milestones(db: Database, improvementId: string, now: number): Milestone[] {
  const out: Milestone[] = [];
  let imp: { id: string; status: string; panel_id: string | null; title: string } | undefined;
  try { imp = db.prepare('SELECT id, status, panel_id, title FROM self_improvements WHERE id = ?').get(improvementId) as typeof imp; } catch { return out; }
  if (!imp) return out;
  if (imp.panel_id) {
    const panel = db.prepare('SELECT id, status, consensus_json FROM specialist_panels WHERE id = ?').get(imp.panel_id) as { id: string; status: string; consensus_json: string } | undefined;
    const c = json(panel?.consensus_json);
    const decision = str(c.decision);
    if (panel && decision && ['consensus_ready', 'backlog_created', 'goal_created', 'cancelled'].includes(panel.status)) {
      const n = (k: string) => (typeof c[k] === 'number' ? c[k] as number : null);
      const record = { panel_id: panel.id, panel_status: panel.status, decision, consensus_level: str(c.consensus_level), support_count: n('support_count'), oppose_count: n('oppose_count'),
        needs_evidence_count: n('needs_evidence_count'), submitted_reviews: n('submitted_reviews'), required_reviews: n('required_reviews') };
      out.push({ key: `panel:${panel.id}:${decision}`, kind: 'panel_decision', improvementId, ref: `panel:${panel.id}`, record,
        text: `Panel ${panel.id} decided "${decision}" for proposal ${improvementId} (support ${record.support_count ?? '?'}, oppose ${record.oppose_count ?? '?'}, needs evidence ${record.needs_evidence_count ?? '?'} of ${record.submitted_reviews ?? '?'} reviews).` });
    }
  }
  const goals = db.prepare("SELECT id, objective, status, created_at FROM goals WHERE improvement_id = ? OR json_extract(metadata, '$.improvement_id') = ? ORDER BY created_at, rowid").all(improvementId, improvementId) as Array<{ id: string; objective: string; status: string; created_at: string }>;
  for (const g of goals) {
    out.push({ key: `goal:${g.id}`, kind: 'goal', improvementId, ref: `goal:${g.id}`, record: { goal_id: g.id, objective: g.objective.slice(0, 200), created_at: g.created_at },
      text: `Goal ${g.id} was created for proposal ${improvementId}: ${g.objective.slice(0, 160)}.` });
    const runs = db.prepare(`SELECT id, status, gates_json, metadata, created_at FROM loop_runs WHERE goal_id = ? AND status IN (${TERMINAL_RUN.map(() => '?').join(',')}) ORDER BY created_at, rowid`)
      .all(g.id, ...TERMINAL_RUN) as Array<{ id: string; status: string; gates_json: string | null; metadata: string | null; created_at: string }>;
    for (const r of runs) {
      let gates: unknown = [];
      try { gates = JSON.parse(r.gates_json || '[]'); } catch { gates = []; }
      const failed = (Array.isArray(gates) ? gates : []).map(json).filter((x) => x.status === 'fail');
      const lease = json((db.prepare("SELECT metadata FROM worker_leases WHERE loop_run_id = ? AND role = 'maker' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(r.id) as { metadata: string } | undefined)?.metadata);
      const failureText = [...failed.map((x) => `${x.name ?? ''} ${x.evidence ?? ''}`), str(lease.failure_reason) ?? '', str(json(r.metadata).failure_reason) ?? ''].join(' ');
      const failureClass = r.status === 'completed' ? null : isInfrastructureFailure(failureText) ? 'technical' : 'substantive';
      out.push({ key: `run:${r.id}:${r.status}`, kind: 'run_outcome', improvementId, ref: `loop_run:${r.id}`,
        record: { run_id: r.id, goal_id: g.id, status: r.status, failure_class: failureClass, failed_gates: failed.map((x) => String(x.name ?? '?')) },
        text: `Run ${r.id} of goal ${g.id} ended ${r.status}${failureClass ? ` (${failureClass} failure${failed.length ? `: ${failed.map((x) => x.name).join(', ')}` : ''}${failureClass === 'technical' ? '; says nothing about the proposal' : ''})` : ''}.` });
      const meta = json(r.metadata);
      const prUrl = str(meta.pr_url);
      if (prUrl) {
        const s = settlementState(r.created_at, parseOutcome(meta.pr_outcome === undefined ? null : JSON.stringify(meta.pr_outcome)), now);
        if (s.state === 'SETTLED_SURVIVED' || s.state === 'SETTLED_REGRESSED') {
          out.push({ key: `survival:${r.id}:${s.state}`, kind: 'survival', improvementId, ref: `pr_settlement:${s.state}`,
            record: { run_id: r.id, pr_url: prUrl, state: s.state, survived: s.state === 'SETTLED_SURVIVED', settled_at: s.since },
            text: `Merge survival settled for run ${r.id}: ${s.state === 'SETTLED_SURVIVED' ? 'survived' : 'did not survive'} 14 days on main (${s.state}). PR: ${prUrl}.` });
        }
      }
    }
  }
  if (VERIFICATION.includes(imp.status)) {
    out.push({ key: `verification:${improvementId}:${imp.status}`, kind: 'verification', improvementId, ref: `improvement:${improvementId}`, record: { improvement_id: improvementId, status: imp.status },
      text: `Proposal ${improvementId} was recorded ${imp.status}${imp.status === 'infra_failed' ? ' (technical failure, not a verdict on the idea)' : ''}.` });
  }
  return out;
}

export interface OutcomeSweep { mode: InvestigationMode; posted: number; recorded: number }

/** One pass over Commons-originated proposals: post (on) or record (shadow) each new milestone once per thread. */
export function sweepInvestigationOutcomes(db: Database, now = Date.now(), env: NodeJS.ProcessEnv = process.env): OutcomeSweep {
  const mode = investigationMode(env);
  const result: OutcomeSweep = { mode, posted: 0, recorded: 0 };
  if (mode === 'off') return result;
  const comms = mode === 'on' ? new AgentCommunicationService(db) : null;
  const posted = (threadId: string, key: string) => !!db.prepare("SELECT 1 FROM agent_messages WHERE from_agent = ? AND json_extract(payload_json, '$.thread_id') = ? AND json_extract(payload_json, '$.params.outcome_key') = ? LIMIT 1")
    .get(INVESTIGATION_OUTCOME_AUTHOR, threadId, key);
  const shadowed = (threadId: string, key: string) => { try { return !!db.prepare("SELECT 1 FROM judgments WHERE judgment = 'commons_investigation_outcome' AND subject_id = ? AND state_hash = ? LIMIT 1").get(threadId, key); } catch { return true; } };
  for (const origin of originated(db, new Date(now - OUTCOME_WINDOW_DAYS * 86_400_000).toISOString())) {
    const chain = lineage(db, origin.improvement_id);
    for (const improvementId of chain) {
      let list: Milestone[] = [];
      try { list = milestones(db, improvementId, now); } catch { list = []; }
      for (const m of list) {
        const outcome = redactDeep({ kind: m.kind, improvement_id: m.improvementId, origin_improvement_id: origin.improvement_id, lineage: chain.slice(0, chain.indexOf(improvementId) + 1),
          source_message_id: origin.message_id, record: m.record });
        const text = redactSecrets(`Outcome update (from records, no model): ${m.text}${improvementId !== origin.improvement_id ? ` Refinement of ${origin.improvement_id}, which this thread proposed.` : ''}`).redacted.slice(0, 1_000);
        if (mode === 'shadow') {
          if (shadowed(origin.thread_id, m.key)) continue;
          if (recordJudgment(db, { judgment: 'commons_investigation_outcome', subjectType: 'social_thread', subjectId: origin.thread_id, stateHash: m.key, mode, decision: 'would_post', reason: text, answers: { ...outcome, text } })) result.recorded += 1;
          continue;
        }
        if (posted(origin.thread_id, m.key)) continue;
        try {
          const message = comms!.send({ from: INVESTIGATION_OUTCOME_AUTHOR, to: 'commons', type: 'result', action: 'social.response', context: text,
            evidence: [`improvement:${m.improvementId}`, `message:${origin.message_id}`, m.ref], threadId: origin.thread_id, epistemicRole: 'outcome', ttl: 86_400,
            idempotencyKey: `${origin.thread_id}:outcome:${m.key}`,
            params: { topic: origin.topic ?? '', topic_ref: origin.topic_ref ?? '', effect_scope: 'isolated', facilitated_by: 'commons-outcome', commons_outcome_kind: m.kind, outcome_key: m.key, outcome, board_summary: text.slice(0, 500) } });
          // nobody consumes the 'commons' inbox: the post is a record, not a delivery (no inference anywhere)
          db.prepare("UPDATE agent_messages SET status = 'read' WHERE id = ?").run(message.id);
          result.posted += 1;
        } catch (e) { console.warn('commons outcome post failed:', e instanceof Error ? e.message : String(e)); }
      }
    }
  }
  return result;
}

export function startInvestigationOutcomes(db: Database): (() => void) | null {
  const intervalMs = 900_000;
  if (!noteScheduler('commons_investigation_outcomes', 'COMMONS_INVESTIGATION_MODE', investigationMode() !== 'off', 900_000)) return null;
  const tick = guardTick('commons_investigation_outcomes', () => {
    const r = sweepInvestigationOutcomes(db);
    markRun('commons_investigation_outcomes');
    if (r.posted || r.recorded) console.log(`🔁 commons outcomes (${r.mode}): ${r.posted} posted, ${r.recorded} recorded`);
  });
  const first = setTimeout(tick, 60_000); first.unref?.();
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
