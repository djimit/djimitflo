import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { TypeSafeClient, prepareState, typesafeConfigured, typesafeModel, type TsAnswer, type TsQuestion, type TsResponse } from './typesafe-client';
import { isLocalShadowJudgment } from './local-shadow-queue';
import { recordEffortJudgment } from './effort-controller';
import { buildProvenance, provenanceJson, type JudgmentProvenance } from './judgment-provenance';

/**
 * Every System One judgment is written to `judgments` (state hash, typed answers, decision, cost, latency, model) so it can
 * be audited and calibrated against real outcomes. Modes per judgment: off (default) | shadow (runs and records, changes
 * nothing) | enforce (a caller may act on the decision). Fail-open: any error yields null and the caller keeps its own logic.
 */
export type JudgmentMode = 'off' | 'shadow' | 'enforce';
export type Decision = 'yes' | 'no' | 'uncertain';

export interface JudgmentDef {
  id: string;                                  // e.g. 'proposal_prescreen'
  questions: Record<string, TsQuestion>;
  /** Pure function of the answers (+ facts checked in code, never sent to the model): thresholds live next to the questions. */
  decide(answers: Record<string, TsAnswer>, facts?: Record<string, unknown>): { decision: Decision; reason: string };
  /** DI-001 B: the policy version this definition implements (bump when its meaning changes); recorded in provenance_json. */
  policyVersion?: string;
}

export const judgmentMode = (id: string, env: NodeJS.ProcessEnv = process.env): JudgmentMode => {
  const v = (env[`TYPESAFE_${id.toUpperCase()}_MODE`] || 'off').toLowerCase();
  return v === 'shadow' || v === 'enforce' ? v : 'off';
};

/** Three-tier band (cookbook): below lo = no, above hi = yes, in between = uncertain. */
export const band = (p: number | undefined, lo: number, hi: number): Decision => (p === undefined ? 'uncertain' : p < lo ? 'no' : p > hi ? 'yes' : 'uncertain');

/** A valid observation for one question: the typed field present and in range (noul/confidence in [0,1], a choice among the criteria). */
function validAnswer(q: TsQuestion, a: TsAnswer | undefined): boolean {
  if (!a || typeof a !== 'object') return false;
  const unit = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  if (a.confidence !== undefined && !unit(a.confidence)) return false;
  if (q.type === 'noul') return unit(a.noul);
  if (q.type === 'score') return typeof a.score === 'number' && Number.isFinite(a.score);
  const criteria = q.criteria && typeof q.criteria === 'object' ? Object.keys(q.criteria as Record<string, unknown>) : null;
  return typeof a.choice === 'string' && a.choice.length > 0 && (!criteria || criteria.includes(a.choice));
}

/**
 * E2 (no valid observation ≠ negative observation): the single place a jev response becomes a decision. Only valid answers
 * are kept and evaluated; if any question has no valid answer the response is not a full observation of the state, so the
 * decision is 'uncertain' (insufficient evidence) — never a 'yes' or 'no' read from a default for the missing answer.
 */
export function decideObserved(def: JudgmentDef, raw: Record<string, TsAnswer>, facts?: Record<string, unknown>): { decision: Decision; reason: string; answers: Record<string, TsAnswer> } {
  const answers: Record<string, TsAnswer> = {};
  const invalid: string[] = [];
  for (const [k, q] of Object.entries(def.questions)) {
    if (validAnswer(q, raw?.[k])) answers[k] = raw[k];
    else invalid.push(k);
  }
  if (invalid.length) return { decision: 'uncertain', reason: `insufficient_evidence: no valid answer for ${invalid.join(', ')}`.slice(0, 300), answers };
  return { ...def.decide(answers, facts), answers };
}

export interface JudgmentRecord { id: string; decision: Decision; reason: string; answers: Record<string, TsAnswer>; mode: JudgmentMode; provenance?: JudgmentProvenance | null }

/**
 * DI-001 B: one INSERT per judgment row, with provenance_json. On a database that predates the column (a reader/writer
 * from before the migration) the row is written without it — persistence stays fail-open, exactly as before.
 */
export function insertJudgmentRow(db: Database, cols: Record<string, unknown>): void {
  const run = (c: Record<string, unknown>) => db.prepare(`INSERT INTO judgments (${Object.keys(c).join(', ')}) VALUES (${Object.keys(c).map(() => '?').join(', ')})`).run(...Object.values(c));
  try { run(cols); } catch (err) {
    if (!('provenance_json' in cols) || !/provenance_json/.test(String(err))) throw err;
    const rest = { ...cols }; delete rest.provenance_json; run(rest);
  }
}


/** DI-001 C: a commit hook vetoed the write (e.g. its claim was taken over): nothing is recorded, not even an error row. */
class CommitVetoed extends Error {}

/**
 * `commit` (optional) runs in one transaction with the judgment insert: returning false rolls the insert back (no row, null
 * returned), throwing rolls both back and records an error row. Callers use it to write a decision exactly once.
 */
export async function runJudgment(db: Database, def: JudgmentDef, subject: { type: string; id: string }, state: unknown, client = new TypeSafeClient(), facts?: Record<string, unknown>,
  commit?: (record: JudgmentRecord) => boolean): Promise<JudgmentRecord | null> {
  const mode = judgmentMode(def.id);
  if (mode === 'off' || !typesafeConfigured()) return null;
  recordEffortJudgment(db, def.id, subject); // EVC effort controller: shadow only (run vs skip), changes nothing
  const started = Date.now();
  const stateHash = createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
  const id = randomUUID();
  try {
    // B8: a shadow judgment is fire-and-forget — retrying during a burst only deepens the queue; enforce keeps its retries
    const response = await client.systemOne(state, def.questions, mode === 'shadow' ? { retries: 0 } : {});
    const { decision, reason, answers } = decideObserved(def, response.answers, facts);
    localShadow(db, def, subject, stateHash, state, def.questions, facts);
    const at = new Date().toISOString();
    const provenance = buildProvenance({ writer: 'judgment-service.runJudgment', def, mode, state, subject, stateHash, at, model: response.model, decision, reason, answers });
    const record: JudgmentRecord = { id, decision, reason, answers, mode, provenance };
    // DI-001 C: the optional commit hook runs in the same transaction as the insert (veto = no row, throw = roll back)
    db.transaction(() => {
      insertJudgmentRow(db, { id, judgment: def.id, subject_type: subject.type, subject_id: subject.id, state_hash: stateHash, mode, decision, reason, answers_json: JSON.stringify(answers),
        input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0, latency_ms: Date.now() - started, model: response.model, created_at: at, provenance_json: provenanceJson(provenance) });
      if (commit && !commit(record)) throw new CommitVetoed();
    })();
    fireChallenger(db, [{ def, prefix: '', facts }], subject, state, stateHash, def.questions, client);
    return record;
  } catch (err) {
    if (err instanceof CommitVetoed) return null;
    try {
      const at = new Date().toISOString();
      insertJudgmentRow(db, { id, judgment: def.id, subject_type: subject.type, subject_id: subject.id, state_hash: stateHash, mode, decision: 'error',
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200), latency_ms: Date.now() - started, created_at: at,
        provenance_json: provenanceJson(buildProvenance({ writer: 'judgment-service.runJudgment', def, mode, state, subject, stateHash, at, decision: 'error' })) });
    } catch { /* recording must never break the caller */ }
    return null;
  }
}

/**
 * R1 (parallel questions cookbook: one request, many typed questions): several judgments about the same subject and state in
 * ONE System One call. Question keys are namespaced `<judgment>__<key>`; each judgment is still decided and recorded on its own
 * row (tokens split evenly), so audits and calibration are unchanged. Judgments in mode 'off' are left out.
 */
export async function runJudgments(db: Database, defs: JudgmentDef[], subject: { type: string; id: string }, state: unknown, client = new TypeSafeClient()): Promise<Array<JudgmentRecord | null>> {
  const active = defs.filter((d) => judgmentMode(d.id) !== 'off');
  if (active.length <= 1 || !typesafeConfigured()) return Promise.all(defs.map((d) => (active.includes(d) ? runJudgment(db, d, subject, state, client) : Promise.resolve(null))));
  for (const d of active) recordEffortJudgment(db, d.id, subject); // EVC effort controller: shadow only
  const started = Date.now();
  const stateHash = createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
  const questions: Record<string, TsQuestion> = {};
  for (const d of active) for (const [k, q] of Object.entries(d.questions)) questions[`${d.id}__${k}`] = q;
  try {
    const response = await client.systemOne(state, questions, active.every((d) => judgmentMode(d.id) === 'shadow') ? { retries: 0 } : {});
    const share = (n: number | undefined) => Math.round((n ?? 0) / active.length);
    const out = new Map<JudgmentDef, JudgmentRecord>();
    for (const d of active) {
      const prefix = `${d.id}__`;
      const raw = Object.fromEntries(Object.entries(response.answers ?? {}).filter(([k]) => k.startsWith(prefix)).map(([k, a]) => [k.slice(prefix.length), a]));
      const { decision, reason, answers } = decideObserved(d, raw);
      localShadow(db, d, subject, stateHash, state, d.questions);
      const id = randomUUID(); const mode = judgmentMode(d.id); const at = new Date().toISOString();
      const provenance = buildProvenance({ writer: 'judgment-service.runJudgments', def: d, mode, state, subject, stateHash, at, model: response.model, decision, reason, answers });
      insertJudgmentRow(db, { id, judgment: d.id, subject_type: subject.type, subject_id: subject.id, state_hash: stateHash, mode, decision, reason, answers_json: JSON.stringify(answers),
        input_tokens: share(response.usage?.input_tokens), output_tokens: share(response.usage?.output_tokens), latency_ms: Date.now() - started, model: response.model, created_at: at,
        provenance_json: provenanceJson(provenance) });
      out.set(d, { id, decision, reason, answers, mode, provenance });
    }
    fireChallenger(db, active.map((d) => ({ def: d, prefix: `${d.id}__` })), subject, state, stateHash, questions, client);
    return defs.map((d) => out.get(d) ?? null);
  } catch (err) {
    for (const d of active) {
      try {
        const at = new Date().toISOString(); const mode = judgmentMode(d.id);
        insertJudgmentRow(db, { id: randomUUID(), judgment: d.id, subject_type: subject.type, subject_id: subject.id, state_hash: stateHash, mode, decision: 'error',
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200), latency_ms: Date.now() - started, created_at: at,
          provenance_json: provenanceJson(buildProvenance({ writer: 'judgment-service.runJudgments', def: d, mode, state, subject, stateHash, at, decision: 'error' })) });
      } catch { /* recording must never break the caller */ }
    }
    return defs.map(() => null);
  }
}

/**
 * JEV-114 (paired shadow): with JEV_CHALLENGER_MODEL set (default unset = off) a deterministic sample (JEV_CHALLENGER_SAMPLE,
 * default 0.2, of sha256(judgment | state_hash): a rerun picks the same subjects) of successful jev judgments is sent a second
 * time — the identical request (state, questions; the same decide() thresholds) — to the challenger model, AFTER the primary
 * was decided and recorded. Fire-and-forget: the caller never awaits it and every error is captured here. It is recorded as
 * `<judgment>@<model>` (mode 'shadow', same subject and state_hash) plus an llm_model_calls row tagged purpose 'jev:challenger'.
 * Every decision reader queries judgment = '<name>' exactly, so no `@` row feeds a decision, gate or forecaster (the `@local`
 * precedent); stall watch skips `@` rows. It shares the client's in-flight cap and breaker but never queues: with no free
 * slot it is dropped (ledger status dropped_busy, no judgment row). Evidence: evolution-evidence `jev_challenger`.
 */
export const challengerModel = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const m = env.JEV_CHALLENGER_MODEL?.trim();
  return m && /^[A-Za-z0-9._:-]{1,60}$/.test(m) && m !== typesafeModel() ? m : null;
};
export const challengerSample = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = env.JEV_CHALLENGER_SAMPLE === undefined || env.JEV_CHALLENGER_SAMPLE === '' ? 0.2 : Number(env.JEV_CHALLENGER_SAMPLE);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.2;
};
export const challengerSampled = (judgment: string, stateHash: string, rate: number): boolean =>
  rate > 0 && parseInt(createHash('sha256').update(`${judgment}|${stateHash}`).digest('hex').slice(0, 8), 16) / 0x1_0000_0000 < rate;

const inflightChallengers = new Set<Promise<void>>();
/** Tests (and shutdown): resolves once every challenger call started so far has been recorded. */
export async function settleChallengers(): Promise<void> { while (inflightChallengers.size) await Promise.all([...inflightChallengers]); }

function fireChallenger(db: Database, parts: Array<{ def: JudgmentDef; prefix: string; facts?: Record<string, unknown> }>, subject: { type: string; id: string },
  state: unknown, stateHash: string, questions: Record<string, TsQuestion>, client: TypeSafeClient): void {
  const model = challengerModel();
  if (!model || !challengerSampled(parts.map((p) => p.def.id).join('+'), stateHash, challengerSample())) return;
  let frozen: unknown; try { frozen = JSON.parse(JSON.stringify(state)); } catch { return; } // the identical state, even if the caller mutates it later
  const run = (async () => {
    const started = Date.now();
    let response: TsResponse | null = null; let error = '';
    try { response = await client.systemOne(frozen, questions, { retries: 0, model, purpose: 'jev:challenger', noWait: true }); }
    catch (err) { error = (err instanceof Error ? err.message : String(err)).slice(0, 200); }
    if (!response && /^TYPESAFE_(?:DROPPED_BUSY|BREAKER_OPEN)/.test(error)) return; // not attempted: the ledger row says why, no pair
    const share = (n: number | undefined) => Math.round((n ?? 0) / parts.length);
    for (const { def, prefix, facts } of parts) {
      try {
        const name = `${def.id}@${model}`; const at = new Date().toISOString(); const shadowDef = { ...def, id: name };
        if (!response) {
          insertJudgmentRow(db, { id: randomUUID(), judgment: name, subject_type: subject.type, subject_id: subject.id, state_hash: stateHash, mode: 'shadow', decision: 'error',
            error, latency_ms: Date.now() - started, model, created_at: at,
            provenance_json: provenanceJson(buildProvenance({ writer: 'judgment-service.challenger', def: shadowDef, mode: 'shadow', state, subject, stateHash, at, decision: 'error' })) });
          continue;
        }
        const raw = prefix ? Object.fromEntries(Object.entries(response.answers ?? {}).filter(([k]) => k.startsWith(prefix)).map(([k, a]) => [k.slice(prefix.length), a])) : response.answers;
        const { decision, reason, answers } = decideObserved(def, raw, facts);
        const used = response.model || model;
        insertJudgmentRow(db, { id: randomUUID(), judgment: name, subject_type: subject.type, subject_id: subject.id, state_hash: stateHash, mode: 'shadow', decision, reason,
          answers_json: JSON.stringify(answers), input_tokens: share(response.usage?.input_tokens), output_tokens: share(response.usage?.output_tokens), latency_ms: Date.now() - started,
          model: used, created_at: at,
          provenance_json: provenanceJson(buildProvenance({ writer: 'judgment-service.challenger', def: shadowDef, mode: 'shadow', state, subject, stateHash, at, model: used, decision, reason, answers })) });
      } catch { /* the challenger must never break anything */ }
    }
  })().catch(() => undefined);
  inflightChallengers.add(run);
  void run.finally(() => inflightChallengers.delete(run));
}

/**
 * T1 (plan Phase T), pull variant (operator rule 2026-09-29: the VPS never calls the workstation): a sample
 * (TYPESAFE_LOCAL_SHADOW_SAMPLE, default 0.2) of successful jev judgments is queued in local_shadow_jobs with the same scrubbed
 * state and questions; the workstation claims them (/api/host-agent/shadow/claim), answers with its local System One and posts
 * the answers back, and local-shadow-queue records them as `<judgment>@local`. No decision reads those rows; stall watch skips
 * them. Off unless TYPESAFE_LOCAL_SHADOW_ENABLED=true; at most 500 jobs wait (older judgments are not worth a backlog).
 */
export function localShadow(db: Database, def: JudgmentDef, subject: { type: string; id: string }, stateHash: string, state: unknown,
  questions: Record<string, TsQuestion>, facts?: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, random = Math.random): void {
  if (env.TYPESAFE_LOCAL_SHADOW_ENABLED !== 'true' || !isLocalShadowJudgment(def.id) || random() >= (Number(env.TYPESAFE_LOCAL_SHADOW_SAMPLE) || 0.2)) return;
  try {
    const waiting = (db.prepare("SELECT COUNT(*) n FROM local_shadow_jobs WHERE status = 'queued'").get() as { n: number }).n;
    if (waiting >= 500) return;
    db.prepare(`INSERT INTO local_shadow_jobs (id, judgment, subject_type, subject_id, state_hash, state_json, questions_json, facts_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), def.id, subject.type, subject.id, stateHash, JSON.stringify(prepareState(state)),
      JSON.stringify(questions), facts ? JSON.stringify(facts) : null, new Date().toISOString());
  } catch { /* the shadow must never break the judgment */ }
}
