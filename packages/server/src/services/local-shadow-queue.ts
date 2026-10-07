import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { judgmentMode, type JudgmentDef } from './judgment-service';
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
    if (!def || body.error || !body.answers || typeof body.answers !== 'object') {
      this.db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, error, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, 'shadow', 'error', ?, ?, ?)`)
        .run(randomUUID(), name, job.subject_type, job.subject_id, job.state_hash, String(body.error ?? (def ? 'no answers' : 'unknown judgment')).slice(0, 200), Number(body.latency_ms) || 0, at);
    } else {
      const { decision, reason } = def.decide(body.answers, job.facts_json ? JSON.parse(job.facts_json) : undefined);
      this.db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, input_tokens, output_tokens, latency_ms, model, created_at)
        VALUES (?, ?, ?, ?, ?, 'shadow', ?, ?, ?, ?, 0, ?, ?, ?)`).run(randomUUID(), name, job.subject_type, job.subject_id, job.state_hash, decision, reason,
        JSON.stringify(body.answers), Number(body.input_tokens) || 0, Number(body.latency_ms) || 0, String(body.model ?? 'local').slice(0, 60), at);
    }
    this.db.prepare(`UPDATE local_shadow_jobs SET status = 'done' WHERE id = ?`).run(id);
  }
}
