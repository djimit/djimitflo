import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { insertJudgmentRow, judgmentMode, type JudgmentDef } from './judgment-service';
import { buildProvenance, provenanceJson } from './judgment-provenance';
import type { TsAnswer } from './typesafe-client';
import { checkerSecondOpinion } from './judgments/checker-second-opinion';
import { commonsContribution } from './judgments/commons-contribution';
import { commonsIdea } from './judgments/commons-idea';
import { discoveryRelevance } from './judgments/discovery-relevance';
import { failureCause } from './judgments/failure-cause';
import { proposalPrescreen } from './judgments/proposal-prescreen';
import { reflectionTriage } from './judgments/reflection-triage';

/** T1 pull: the workstation claims queued shadow judgments and posts local answers; the server decides with the same rules. */
export const DEFS = new Map<string, JudgmentDef>([checkerSecondOpinion, commonsContribution, commonsIdea, discoveryRelevance, failureCause, proposalPrescreen, reflectionTriage].map((d) => [d.id, d]));

/** Judgments the local shadow can decide; others (e.g. R2's per-panel kb_passage_relevance) are not queued. */
export const isLocalShadowJudgment = (id: string): boolean => DEFS.has(id);

interface Job { id: string; judgment: string; subject_type: string; subject_id: string; state_hash: string; state_json: string; questions_json: string; facts_json: string | null; host: string | null; status: string; created_at: string }

export class LocalShadowQueue {
  constructor(private readonly db: Database) {}

  claim(host: string, limit = 4): Array<{ id: string; state: unknown; questions: unknown }> {
    const at = new Date().toISOString();
    // a claim not answered within 30 min goes back to the queue (the worker restarted)
    this.db.prepare(`UPDATE local_shadow_jobs SET status = 'queued', host = NULL, claimed_at = NULL WHERE status = 'claimed' AND claimed_at < ?`).run(new Date(Date.now() - 30 * 60_000).toISOString());
    // 'off' means no call and no row (prod 10-07: TYPESAFE_COMMONS_*_MODE=off, yet ~50/week each still landed as <judgment>@local
    // from jobs queued while the mode was on): a waiting job of a judgment switched off is dropped, never handed out.
    const off = [...DEFS.keys()].filter((id) => judgmentMode(id) === 'off');
    if (off.length) this.db.prepare(`UPDATE local_shadow_jobs SET status = 'skipped' WHERE status = 'queued' AND judgment IN (SELECT value FROM json_each(?))`).run(JSON.stringify(off));
    const jobs = this.db.prepare(`SELECT * FROM local_shadow_jobs WHERE status = 'queued' ORDER BY created_at LIMIT ?`).all(Math.max(1, Math.min(limit, 16))) as Job[];
    const take = this.db.prepare(`UPDATE local_shadow_jobs SET status = 'claimed', host = ?, claimed_at = ? WHERE id = ? AND status = 'queued'`);
    return jobs.filter((j) => take.run(host, at, j.id).changes === 1).map((j) => ({ id: j.id, state: JSON.parse(j.state_json), questions: JSON.parse(j.questions_json) }));
  }

  record(id: string, host: string, body: { answers?: Record<string, TsAnswer>; model?: string; input_tokens?: number; latency_ms?: number; error?: string }): void {
    const job = this.db.prepare('SELECT * FROM local_shadow_jobs WHERE id = ?').get(id) as Job | undefined;
    if (!job || job.host !== host) throw new Error('SHADOW_JOB_NOT_FOUND');
    if (job.status !== 'claimed') throw new Error('SHADOW_JOB_NOT_CLAIMED');
    const def = DEFS.get(job.judgment);
    if (def && judgmentMode(def.id) === 'off') { this.db.prepare(`UPDATE local_shadow_jobs SET status = 'skipped' WHERE id = ?`).run(id); return; }
    const at = new Date().toISOString();
    const name = `${job.judgment}@local`;
    const subject = { type: job.subject_type, id: job.subject_id };
    // DI-001 B: the queued state is already scrubbed, so its digest equals the jev row's (join @local to its original on input_digest)
    const prov = (decision: string, extra: { model?: string; reason?: string; answers?: Record<string, TsAnswer> } = {}) => (def
      ? provenanceJson(buildProvenance({ writer: 'local-shadow-queue', def: { ...def, id: name }, mode: 'shadow', state: (() => { try { return JSON.parse(job.state_json) as unknown; } catch { return null; } })(),
        subject, stateHash: job.state_hash, at, decision, evaluator: 'def.decide/v1', ...extra }))
      : null);
    if (!def || body.error || !body.answers || typeof body.answers !== 'object') {
      insertJudgmentRow(this.db, { id: randomUUID(), judgment: name, subject_type: job.subject_type, subject_id: job.subject_id, state_hash: job.state_hash, mode: 'shadow', decision: 'error',
        error: String(body.error ?? (def ? 'no answers' : 'unknown judgment')).slice(0, 200), latency_ms: Number(body.latency_ms) || 0, created_at: at, provenance_json: prov('error') });
    } else {
      const { decision, reason } = def.decide(body.answers, job.facts_json ? JSON.parse(job.facts_json) : undefined);
      const model = String(body.model ?? 'local').slice(0, 60);
      insertJudgmentRow(this.db, { id: randomUUID(), judgment: name, subject_type: job.subject_type, subject_id: job.subject_id, state_hash: job.state_hash, mode: 'shadow', decision, reason,
        answers_json: JSON.stringify(body.answers), input_tokens: Number(body.input_tokens) || 0, output_tokens: 0, latency_ms: Number(body.latency_ms) || 0, model, created_at: at,
        provenance_json: prov(decision, { model, reason, answers: body.answers }) });
    }
    this.db.prepare(`UPDATE local_shadow_jobs SET status = 'done' WHERE id = ?`).run(id);
  }
}
