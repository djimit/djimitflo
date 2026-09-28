import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { TypeSafeClient, typesafeConfigured, type TsAnswer, type TsQuestion } from './typesafe-client';

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
}

export const judgmentMode = (id: string): JudgmentMode => {
  const v = (process.env[`TYPESAFE_${id.toUpperCase()}_MODE`] || 'off').toLowerCase();
  return v === 'shadow' || v === 'enforce' ? v : 'off';
};

/** Three-tier band (cookbook): below lo = no, above hi = yes, in between = uncertain. */
export const band = (p: number | undefined, lo: number, hi: number): Decision => (p === undefined ? 'uncertain' : p < lo ? 'no' : p > hi ? 'yes' : 'uncertain');

export interface JudgmentRecord { id: string; decision: Decision; reason: string; answers: Record<string, TsAnswer>; mode: JudgmentMode }

export async function runJudgment(db: Database, def: JudgmentDef, subject: { type: string; id: string }, state: unknown, client = new TypeSafeClient(), facts?: Record<string, unknown>): Promise<JudgmentRecord | null> {
  const mode = judgmentMode(def.id);
  if (mode === 'off' || !typesafeConfigured()) return null;
  const started = Date.now();
  const stateHash = createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
  const id = randomUUID();
  try {
    const response = await client.systemOne(state, def.questions);
    const { decision, reason } = def.decide(response.answers, facts);
    db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, input_tokens, output_tokens, latency_ms, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, def.id, subject.type, subject.id, stateHash, mode, decision, reason, JSON.stringify(response.answers),
      response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, Date.now() - started, response.model, new Date().toISOString());
    return { id, decision, reason, answers: response.answers, mode };
  } catch (err) {
    try {
      db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, error, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, 'error', ?, ?, ?)`)
        .run(id, def.id, subject.type, subject.id, stateHash, mode, (err instanceof Error ? err.message : String(err)).slice(0, 200), Date.now() - started, new Date().toISOString());
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
  const started = Date.now();
  const stateHash = createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
  const questions: Record<string, TsQuestion> = {};
  for (const d of active) for (const [k, q] of Object.entries(d.questions)) questions[`${d.id}__${k}`] = q;
  const insertOk = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, input_tokens, output_tokens, latency_ms, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
    const response = await client.systemOne(state, questions);
    const share = (n: number | undefined) => Math.round((n ?? 0) / active.length);
    const out = new Map<JudgmentDef, JudgmentRecord>();
    for (const d of active) {
      const prefix = `${d.id}__`;
      const answers = Object.fromEntries(Object.entries(response.answers).filter(([k]) => k.startsWith(prefix)).map(([k, a]) => [k.slice(prefix.length), a]));
      const { decision, reason } = d.decide(answers);
      const id = randomUUID(); const mode = judgmentMode(d.id);
      insertOk.run(id, d.id, subject.type, subject.id, stateHash, mode, decision, reason, JSON.stringify(answers), share(response.usage?.input_tokens), share(response.usage?.output_tokens), Date.now() - started, response.model, new Date().toISOString());
      out.set(d, { id, decision, reason, answers, mode });
    }
    return defs.map((d) => out.get(d) ?? null);
  } catch (err) {
    for (const d of active) {
      try {
        db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, error, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, 'error', ?, ?, ?)`)
          .run(randomUUID(), d.id, subject.type, subject.id, stateHash, judgmentMode(d.id), (err instanceof Error ? err.message : String(err)).slice(0, 200), Date.now() - started, new Date().toISOString());
      } catch { /* recording must never break the caller */ }
    }
    return defs.map(() => null);
  }
}
