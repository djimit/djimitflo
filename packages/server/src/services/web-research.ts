import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { failureUnits, type FailureSignature } from './intelligence-metrics';
import { redactSecrets } from './secret-patterns';
import { checkNegativeEvidence, type NeEntry, recordNegativeEvidenceMatches } from './negative-evidence-check';
import { gateUntrustedForPrompt } from './content-safety';

/**
 * WEB-001 failure-driven research (operator 2026-11-08: web input made thousands of items and zero verified improvements —
 * no consumer, no executed check). WEB_RESEARCH_MODE=off|shadow|on (default off = nothing asked, nothing written).
 *
 *  1. Questions come from measured failures: the top ≤ 3 production maker failure signatures of the last 7 days (§16
 *     failureSignature via failureUnits; runs attributed reviewer/environment failure left out) whose gate + error class
 *     maps to a known failure class. The question is built ONLY from fixed text per class, the lane name, the runtime and
 *     the tech stack — never from the failure reason itself, so no path, secret or customer text can reach the web.
 *  2. Pull: the workstation's gym-worker (WEB_RESEARCH_MODE=on in ITS env, capability `research_jobs`) claims a job at
 *     POST /api/gym-worker/research/claim and answers ≤ 3 candidates (technique ≤ 600 chars, ≥ 1 source URL, one strategy
 *     line ≤ 200 chars). The job is created at claim time — no scheduler: ≤ 1 in flight (a claim older than 1 h expires),
 *     ≤ 3 per 24 h, one question at most once per 7 days.
 *  3. Everything returned is untrusted: size/shape, secrets, guardLines (dream-evolution), the NE registry and content
 *     safety screen each candidate; nothing is executed. One `web_research` judgments row per job records the question,
 *     what came back and every decision (shadow and on).
 *  4. on only: an accepted candidate becomes a `web_research_knowledge` judgment (ref `knowledge:web:<id>`, provenance: the
 *     source URLs, the question, the failure signature, the job). DREAM_EVIDENCE_SOURCES 'knowledge' puts the newest of
 *     them in the dream's pack; a mutant that cites one stores the ref (evidence_sources_json, knowledge_refs_json → K1).
 *     The paired gym trial on the frozen holdout and the promotion rule decide, unchanged.
 */
export type WebResearchMode = 'off' | 'shadow' | 'on';
export const webResearchMode = (env: NodeJS.ProcessEnv = process.env): WebResearchMode => {
  const v = (env.WEB_RESEARCH_MODE || '').trim().toLowerCase();
  return v === 'on' ? 'on' : v === 'shadow' ? 'shadow' : 'off';
};
export const MAX_JOBS_PER_DAY = 3;
export const MAX_CANDIDATES = 3;
export const MAX_TECHNIQUE_CHARS = 600;
export const MAX_LINE_CHARS = 200;
const WINDOW_DAYS = 7; // "recent" failures
const REASK_DAYS = 7; // the same question is not asked again sooner
const STALE_MS = 3_600_000;
const PACK_DAYS = 30;
export const WEB_PACK_MAX = 3;
const DAY = 86_400_000;
const STACK = 'TypeScript, vitest, Stryker, atomic-agent, opencode';

/** Fixed text per failure class: the only failure description that ever leaves the VPS. */
export const FAILURE_CLASSES = {
  mutation_check_failed: { phrase: 'the grounded Stryker mutation check fails (mutants survive) after the agent changes TypeScript code', query: 'Stryker surviving mutants strengthen vitest assertions TypeScript' },
  package_json_out_of_scope: { phrase: 'the agent edits package.json or lock files although only one source file is in scope', query: 'prevent AI coding agent editing package.json lockfile single file scope' },
  out_of_scope: { phrase: 'the agent changes files outside the one file it was allowed to change', query: 'constrain AI coding agent edits to one file' },
  check_timed_out: { phrase: 'a vitest check times out after the agent edited the code, even when the target test already passed', query: 'vitest test run timeout hangs after tests pass open handles' },
  runtime_exit_nonzero: { phrase: 'the coding-agent CLI exits with a non-zero status before it finishes the change', query: 'coding agent CLI non-zero exit headless run' },
  typecheck_failed: { phrase: 'tsc type-check fails after the agent changed the code', query: 'AI coding agent TypeScript type errors after edit tsc noEmit' },
  lint_failed: { phrase: 'eslint fails after the agent changed the code', query: 'AI coding agent eslint errors after edit' },
  no_change: { phrase: 'the agent gives up without changing any file', query: 'AI coding agent gives up without making changes' },
  tests_red: { phrase: 'the target vitest tests still fail after the agent changed the source file', query: 'AI coding agent make failing vitest tests pass fix source not tests' },
} as const;
export type FailureClass = keyof typeof FAILURE_CLASSES;

/** The failure class of a signature from its gate + normalised error class (fixed rules, first match wins); null = unknown. */
export function failureClass(sig: Pick<FailureSignature, 'gate' | 'error_class'>): FailureClass | null {
  const t = `${sig.gate ?? ''} ${sig.error_class ?? ''}`.toLowerCase();
  if (/mutation|stryker|mutant/.test(t)) return 'mutation_check_failed';
  if (/scope/.test(t) && /package[._-]?json|lock ?file|package-lock/.test(t)) return 'package_json_out_of_scope';
  if (/out[ _]of[ _]scope|scope/.test(t)) return 'out_of_scope';
  if (/timed?[ _-]?out|timeout/.test(t)) return 'check_timed_out';
  if (/runtime[ _]exit|exit[ _]zero|exited with|exit code/.test(t)) return 'runtime_exit_nonzero';
  if (/type-?check|\btsc\b/.test(t)) return 'typecheck_failed';
  if (/\b(es)?lint\b/.test(t)) return 'lint_failed';
  if (/no[ _]change|gave up|nothing changed/.test(t)) return 'no_change';
  if (/still red|tests?[ _:](failed|red|changed)|assert/.test(t)) return 'tests_red';
  return null;
}

const RUNTIMES: Record<string, string> = { opencode: 'opencode', remote: 'atomic-agent', atomic: 'atomic-agent', codex: 'codex', claude: 'claude-code' };
const safe = (s: string | null | undefined, re: RegExp): string | null => (s && re.test(s) ? s : null);

export interface ResearchQuestion {
  signature: string; failure_class: FailureClass; lane: string; runtime: string; gate: string | null; occurrences: number;
  question: string; queries: string[];
}
/** Pure: the question for one signature, or null when its class is unknown or the text would carry anything but the allowed fields. */
export function researchQuestion(sig: FailureSignature, occurrences: number): ResearchQuestion | null {
  const cls = failureClass(sig);
  if (!cls) return null;
  const cut = sig.lane.lastIndexOf(':');
  const lane = safe(cut > 0 ? sig.lane.slice(0, cut) : sig.lane, /^[a-z0-9][a-z0-9-]{0,60}$/) ?? 'unknown';
  const rt = safe(cut > 0 ? sig.lane.slice(cut + 1) : null, /^[a-z0-9][a-z0-9._-]{0,30}$/);
  const runtime = rt ? RUNTIMES[rt] ?? rt : 'unknown';
  const gate = safe(sig.gate, /^[a-z0-9_]{1,40}$/);
  const { phrase, query } = FAILURE_CLASSES[cls];
  const question = `How can an autonomous coding agent avoid this failure: ${phrase}? Lane: ${lane.replace(/-/g, ' ')}; runtime: ${runtime}${gate ? `; failed gate: ${gate}` : ''}. `
    + `Stack: ${STACK}. Name concrete, sourced techniques.`;
  const queries = [query, `${runtime} ${query}`];
  // defence in depth: every part is fixed text or a matched name, but nothing that looks like a secret or a path may pass
  const all = [question, ...queries].join('\n');
  if (redactSecrets(all).count || /[/\\@]|https?:/.test(all.replace(/package\.json/g, ''))) return null;
  return { signature: sig.signature, failure_class: cls, lane, runtime, gate, occurrences, question, queries };
}

/** The top ≤ max distinct questions by recent count (7 d of production maker failures). Read-only, fail-soft. */
export function researchQuestions(db: Database, now = Date.now(), max = MAX_JOBS_PER_DAY): ResearchQuestion[] {
  let nonMaker = new Set<string>();
  try {
    nonMaker = new Set((db.prepare(`SELECT subject_id FROM judgments WHERE judgment = 'outcome_attribution' AND subject_type = 'loop_run'
      AND decision IN ('reviewer_failure', 'environment_failure')`).all() as Array<{ subject_id: string }>).map((r) => r.subject_id));
  } catch { /* no judgments: nothing to leave out */ }
  const bySig = new Map<string, { sig: FailureSignature; n: number }>();
  for (const u of failureUnits(db, new Date(now - WINDOW_DAYS * DAY).toISOString())) {
    if (!u.failed || !u.signature || (u.run && nonMaker.has(u.run))) continue;
    const c = bySig.get(u.signature.signature) ?? { sig: u.signature, n: 0 };
    c.n++; bySig.set(u.signature.signature, c);
  }
  const out: ResearchQuestion[] = [];
  for (const { sig, n } of [...bySig.values()].sort((a, b) => b.n - a.n || a.sig.signature.localeCompare(b.sig.signature))) {
    const q = researchQuestion(sig, n);
    if (q && !out.some((o) => o.question === q.question)) out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

const qhash = (q: string) => createHash('sha256').update(q).digest('hex').slice(0, 16);
const parse = (s: string | null | undefined): Record<string, any> => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export interface ResearchJob { jobId: string; question: string; queries: string[]; max_candidates: number; max_technique_chars: number; max_line_chars: number }
/** Workstation pull: the next question as a claimed job, or null (off, one in flight, 3 in 24 h, nothing new to ask). */
export function claimWebResearch(db: Database, host: string, now = new Date(), env: NodeJS.ProcessEnv = process.env): ResearchJob | null {
  const mode = webResearchMode(env);
  if (mode === 'off') return null;
  const iso = now.toISOString(); const t = now.getTime();
  db.prepare("UPDATE judgments SET decision = 'expired' WHERE judgment = 'web_research' AND decision = 'claimed' AND created_at < ?").run(new Date(t - STALE_MS).toISOString());
  if (db.prepare("SELECT 1 FROM judgments WHERE judgment = 'web_research' AND decision = 'claimed' LIMIT 1").get()) return null;
  if ((db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE judgment = 'web_research' AND created_at >= ?").get(new Date(t - DAY).toISOString()) as { n: number }).n >= MAX_JOBS_PER_DAY) return null;
  const asked = new Set((db.prepare("SELECT state_hash AS h FROM judgments WHERE judgment = 'web_research' AND created_at >= ?").all(new Date(t - REASK_DAYS * DAY).toISOString()) as Array<{ h: string }>).map((r) => r.h));
  const q = researchQuestions(db, t).find((x) => !asked.has(qhash(x.question)));
  if (!q) return null;
  const id = randomUUID();
  db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'web_research', 'failure_signature', ?, ?, ?, 'claimed', ?, ?, ?)`).run(id, q.signature, qhash(q.question), mode, q.question.slice(0, 300),
    JSON.stringify({ question: q.question, queries: q.queries, failure_class: q.failure_class, lane: q.lane, runtime: q.runtime, gate: q.gate, occurrences: q.occurrences, host, claimed_at: iso }), iso);
  return { jobId: id, question: q.question, queries: q.queries, max_candidates: MAX_CANDIDATES, max_technique_chars: MAX_TECHNIQUE_CHARS, max_line_chars: MAX_LINE_CHARS };
}

export type RejectReason = 'malformed' | 'no_source' | 'secret' | 'guard' | 'negative_evidence' | 'duplicate' | 'content_safety' | 'over_cap';
interface Screened { technique: string; sources: string[]; strategy_line: string; decision: 'accepted' | 'rejected'; reason: RejectReason | null; knowledge_ref: string | null }
const httpUrl = (u: unknown): u is string => { if (typeof u !== 'string' || u.length > 500) return false; try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

/**
 * A worker's answer: each of the first ≤ 3 candidates is screened (data, never instructions; nothing executed). Under `on`
 * (env AND the job's own mode) an accepted one is written as knowledge; the job row records everything either way.
 */
export async function recordWebResearch(db: Database, jobId: string, host: string, body: { status?: unknown; reason?: unknown; candidates?: unknown; model?: unknown; search?: unknown },
  env: NodeJS.ProcessEnv = process.env, now = new Date(), opts: { guard?: (lines: unknown) => string[] | null; neEntries?: NeEntry[] | null; fetchFn?: typeof fetch } = {}): Promise<{ returned: number; accepted: number; rejected: Partial<Record<RejectReason, number>>; routed: number }> {
  const row = db.prepare("SELECT id, subject_id, mode, decision, answers_json FROM judgments WHERE id = ? AND judgment = 'web_research'").get(jobId) as
    { id: string; subject_id: string; mode: string; decision: string; answers_json: string } | undefined;
  const job = parse(row?.answers_json);
  if (!row || job.host !== host) throw new Error('RESEARCH_JOB_NOT_FOUND');
  if (row.decision !== 'claimed') throw new Error('RESEARCH_JOB_NOT_CLAIMED');
  const iso = now.toISOString();
  const update = (decision: string, reason: string, extra: Record<string, unknown>) => db.prepare("UPDATE judgments SET decision = ?, reason = ?, answers_json = ?, model = ? WHERE id = ? AND decision = 'claimed'")
    .run(decision, reason.slice(0, 300), JSON.stringify({ ...job, ...extra, finished_at: iso }), typeof body.model === 'string' ? body.model.slice(0, 80) : `remote:${host}`, jobId);
  const search = body.search && typeof body.search === 'object' ? { provider: String((body.search as { provider?: unknown }).provider ?? '').slice(0, 40) || null, results: Number((body.search as { results?: unknown }).results) || 0 } : null;
  if (body.status !== 'done') {
    update('failed', `failed: ${String(body.reason ?? 'no reason').slice(0, 200)}`, { error: redactSecrets(String(body.reason ?? '')).redacted.slice(0, 200), search });
    return { returned: 0, accepted: 0, rejected: {}, routed: 0 };
  }
  const raw = Array.isArray(body.candidates) ? body.candidates : [];
  // dream-evolution's guardLines comes from the caller: dream-evolution's own import graph (genome-promotion → evolution-evidence)
  // reaches this module, so a static import would be a cycle. No guard given = every line refused (fail closed).
  const guardLines = opts.guard ?? (() => null);
  const route = webResearchMode(env) === 'on' && row.mode === 'on';
  const seen = new Set((db.prepare("SELECT reason FROM judgments WHERE judgment = 'web_research_knowledge'").all() as Array<{ reason: string }>).map((r) => r.reason));
  const out: Screened[] = []; const rejected: Partial<Record<RejectReason, number>> = {};
  const reject = (s: Omit<Screened, 'decision' | 'reason' | 'knowledge_ref'>, reason: RejectReason) => { rejected[reason] = (rejected[reason] ?? 0) + 1; out.push({ ...s, decision: 'rejected', reason, knowledge_ref: null }); };
  for (const [i, c] of raw.entries()) {
    const o = c && typeof c === 'object' ? c as { technique?: unknown; sources?: unknown; strategy_line?: unknown } : {};
    const technique = typeof o.technique === 'string' ? o.technique.replace(/\s+/g, ' ').trim() : '';
    const line = typeof o.strategy_line === 'string' ? o.strategy_line.replace(/\s+/g, ' ').trim() : '';
    const sources = (Array.isArray(o.sources) ? o.sources : []).filter(httpUrl).slice(0, 5);
    // what is stored is capped and redacted, whatever the decision
    const s = { technique: redactSecrets(technique.slice(0, MAX_TECHNIQUE_CHARS)).redacted, sources: sources.map((u) => redactSecrets(u).redacted), strategy_line: redactSecrets(line.slice(0, MAX_LINE_CHARS)).redacted };
    if (i >= MAX_CANDIDATES) { rejected.over_cap = (rejected.over_cap ?? 0) + 1; continue; } // never screened, never stored
    if (!technique || !line || technique.length > MAX_TECHNIQUE_CHARS || line.length > MAX_LINE_CHARS) { reject(s, 'malformed'); continue; }
    if (!sources.length) { reject(s, 'no_source'); continue; }
    const text = `${technique}\n${line}\n${sources.join('\n')}`;
    if (redactSecrets(text).count) { reject(s, 'secret'); continue; }
    if (!guardLines([line])) { reject(s, 'guard'); continue; }
    if (checkNegativeEvidence(text, { source: 'web_research', entries: opts.neEntries }).length) {
      recordNegativeEvidenceMatches(db, { type: 'web_research', id: jobId }, text, 'web_research', env, opts.neEntries); // K3 shadow record
      reject(s, 'negative_evidence'); continue;
    }
    if (seen.has(line) || out.some((x) => x.decision === 'accepted' && x.strategy_line === line)) { reject(s, 'duplicate'); continue; }
    const gate = await gateUntrustedForPrompt(db, { type: 'web_research', id: `${jobId}:${i}` }, `${technique}\n${line}`, opts.fetchFn ?? fetch).catch(() => ({ include: process.env.CONTENT_SAFETY_MODE !== 'enforce', verdict: null }));
    if (!gate.include || gate.verdict === 'unsafe') { reject(s, 'content_safety'); continue; }
    out.push({ ...s, decision: 'accepted', reason: null, knowledge_ref: null });
  }
  let routed = 0;
  if (route) {
    const ins = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, model, created_at)
      VALUES (?, 'web_research_knowledge', 'failure_signature', ?, ?, 'on', 'accepted', ?, ?, ?, ?)`);
    for (const s of out.filter((x) => x.decision === 'accepted')) {
      const id = randomUUID(); s.knowledge_ref = `knowledge:web:${id}`;
      ins.run(id, row.subject_id, qhash(s.strategy_line), s.strategy_line, JSON.stringify({ ref: s.knowledge_ref, technique: s.technique, sources: s.sources, strategy_line: s.strategy_line,
        question: job.question, failure_signature: row.subject_id, failure_class: job.failure_class, lane: job.lane, runtime: job.runtime, job_id: jobId }),
      typeof body.model === 'string' ? body.model.slice(0, 80) : `remote:${host}`, iso);
      routed++;
    }
  }
  const accepted = out.filter((x) => x.decision === 'accepted').length;
  update('done', `${raw.length} returned, ${accepted} accepted, ${routed} routed`, { returned: raw.length, accepted, rejected, routed, candidates: out, search });
  return { returned: raw.length, accepted, rejected, routed };
}

/** The pack items for DREAM_EVIDENCE_SOURCES 'knowledge' (on only): the newest accepted web knowledge, the failing lanes' first. */
export function webResearchKnowledge(db: Database, lanes: string[], now = Date.now(), env: NodeJS.ProcessEnv = process.env): Array<{ ref: string; text: string }> {
  if (webResearchMode(env) !== 'on') return [];
  let rows: Array<{ a: string }> = [];
  try {
    rows = db.prepare("SELECT answers_json AS a FROM judgments WHERE judgment = 'web_research_knowledge' AND decision = 'accepted' AND created_at >= ? ORDER BY created_at DESC, id LIMIT 50")
      .all(new Date(now - PACK_DAYS * DAY).toISOString()) as typeof rows;
  } catch { return []; }
  const want = new Set(lanes);
  return rows.map((r) => parse(r.a)).filter((k) => typeof k.ref === 'string' && typeof k.strategy_line === 'string')
    .sort((a, b) => Number(!want.has(a.lane)) - Number(!want.has(b.lane))) // stable: newest first within each group
    .slice(0, WEB_PACK_MAX)
    .map((k) => ({ ref: k.ref as string, text: `unverified web technique for ${k.failure_class ?? 'a failure'} (lane ${k.lane ?? 'unknown'}): ${k.strategy_line}` }));
}

/**
 * Evidence `web_research` — the measurable path "web → verified change or not": questions asked (by status), candidates
 * returned / accepted / rejected by reason, knowledge routed, dream genomes citing it and their trial result. null = no job
 * yet (unknown, never 0); cited null while nothing was routed.
 */
export function webResearchEvidence(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const mode = webResearchMode(env);
  const note = 'WEB-001: questions from the top failure signatures (class, lane, runtime, stack only); candidates screened (shape, secrets, guardLines, NE registry, content safety); '
    + 'on: accepted → web_research_knowledge (knowledge:web:<id>) in the DREAM_EVIDENCE_SOURCES knowledge pack; cited = dream genomes citing it, trial from maker_genomes.status (active = promoted) and genome_trial_results';
  const empty = { mode, window_days: PACK_DAYS, questions: null, candidates: null, routed: null, cited: null, note };
  let jobs: Array<{ decision: string; a: string; created_at: string }> = [];
  try {
    jobs = db.prepare("SELECT decision, answers_json AS a, created_at FROM judgments WHERE judgment = 'web_research' AND created_at >= ? ORDER BY created_at DESC, id")
      .all(new Date(now - PACK_DAYS * DAY).toISOString()) as typeof jobs;
  } catch { return empty; }
  if (!jobs.length) return empty;
  const by_status: Record<string, number> = { claimed: 0, done: 0, failed: 0, expired: 0 };
  let returned = 0; let accepted = 0; const rejected_by_reason: Record<string, number> = {};
  for (const j of jobs) {
    by_status[j.decision] = (by_status[j.decision] ?? 0) + 1;
    if (j.decision !== 'done') continue;
    const a = parse(j.a); returned += Number(a.returned) || 0; accepted += Number(a.accepted) || 0;
    for (const [k, v] of Object.entries(a.rejected ?? {})) rejected_by_reason[k] = (rejected_by_reason[k] ?? 0) + (Number(v) || 0);
  }
  const done = by_status.done > 0;
  const recent = jobs.slice(0, 5).map((j) => { const a = parse(j.a); return { at: j.created_at, status: j.decision, failure_class: a.failure_class ?? null, lane: a.lane ?? null, runtime: a.runtime ?? null, question: a.question ?? null }; });
  let refs: string[] = [];
  try { refs = (db.prepare("SELECT json_extract(answers_json, '$.ref') AS r FROM judgments WHERE judgment = 'web_research_knowledge'").all() as Array<{ r: string | null }>).map((r) => r.r).filter((r): r is string => Boolean(r)); } catch { /* unknown */ }
  let cited = null;
  if (refs.length) {
    const own = new Set(refs);
    let genomes: Array<{ id: string; status: string; s: string | null }> = [];
    try { genomes = db.prepare("SELECT id, status, evidence_sources_json AS s FROM maker_genomes WHERE evidence_sources_json LIKE '%knowledge:web:%' ORDER BY created_at, id").all() as typeof genomes; } catch { /* unknown */ }
    const list = genomes.map((g) => {
      let cites: string[] = [];
      try { cites = (JSON.parse(g.s ?? '[]') as Array<{ id?: unknown }>).map((c) => String(c.id)).filter((id) => own.has(id)); } catch { /* malformed */ }
      let trial: { state: string; b: number | null; c: number | null; p: number | null; deciding_n: number | null } | null = null;
      try { trial = (db.prepare('SELECT state, b, c, p, deciding_n FROM genome_trial_results WHERE trial_id = ?').get(g.id) as typeof trial) ?? null; } catch { /* no table */ }
      return { genome: g.id, status: g.status, knowledge: cites, trial };
    }).filter((g) => g.knowledge.length);
    const n = (st: string) => list.filter((g) => g.status === st).length;
    cited = { genomes: list.length, promoted: n('active'), retired: n('retired'), inconclusive: n('inconclusive'), pending: n('trial'), list };
  }
  return { mode, window_days: PACK_DAYS, questions: { asked: jobs.length, by_status, recent },
    candidates: done ? { returned, accepted, rejected_by_reason } : null, routed: refs.length, cited, note };
}
