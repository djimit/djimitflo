import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { AgentCommunicationService } from './agent-communication-service';
import { MemoryCandidateService } from './memory-candidate-service';

/**
 * Agent Commons review of parked self-improvement proposals.
 *
 * Advisory only: the specialist panel stays the gate. The residents' concrete
 * answers (next step, alternative, stop condition) are stored in
 * commons_proposal_reviews and fed into the one refinement attempt; reviewed
 * proposals are refined first. Outcomes of the resulting goals become memory
 * candidates (always review-gated by MemoryCandidateService).
 */

const ASKER = 'commons-scout';
const REVIEWERS = ['commons-muse', 'commons-archivist', 'commons-oracle'] as const;

export function commonsReviewEnabled(): boolean {
  return process.env.COMMONS_PROPOSAL_REVIEW_ENABLED === 'true';
}

interface ReplyParams { answer?: string; falsifiable_next_step?: string; creative_alternative?: string; stop_condition?: string }
export type CommentsPort = Pick<AgentCommunicationService, 'send'>;
export type MemoryPort = Pick<MemoryCandidateService, 'create'>;

export interface CommonsReviewTick { collected: number; timedOut: number; posted: number }

export class CommonsProposalReviewService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database,
    private readonly deps: { comms?: CommentsPort; memory?: MemoryPort } = {},
  ) {}

  private get comms(): CommentsPort { return this.deps.comms ?? new AgentCommunicationService(this.db); }
  private get memory(): MemoryPort { return this.deps.memory ?? new MemoryCandidateService(this.db); }
  private maxOpen(): number { return Math.max(1, Number(process.env.COMMONS_PROPOSAL_REVIEW_MAX_OPEN) || 1); }
  private timeoutMs(): number { return Number(process.env.COMMONS_PROPOSAL_REVIEW_TIMEOUT_MS) || 2 * 3600_000; }

  start(intervalMs = Number(process.env.COMMONS_PROPOSAL_REVIEW_INTERVAL_MS) || 5 * 60_000): void {
    if (this.timer || !commonsReviewEnabled()) return;
    this.timer = setInterval(() => {
      try {
        const r = this.tick();
        if (r.collected || r.timedOut || r.posted) console.log(`🪐 commons proposal review tick: collected=${r.collected} timedOut=${r.timedOut} posted=${r.posted}`);
      } catch (err) { console.warn('Commons proposal review tick failed:', err instanceof Error ? err.message : String(err)); }
    }, intervalMs);
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  tick(now = Date.now()): CommonsReviewTick {
    const result: CommonsReviewTick = { collected: 0, timedOut: 0, posted: 0 };
    const pending = this.db.prepare("SELECT improvement_id, thread_id, posted_at FROM commons_proposal_reviews WHERE status = 'pending'")
      .all() as Array<{ improvement_id: string; thread_id: string; posted_at: string }>;
    for (const review of pending) {
      const replies = this.replies(review.thread_id);
      const expired = now - Date.parse(review.posted_at) > this.timeoutMs();
      if (replies.length < REVIEWERS.length && !expired) continue;
      const status = replies.length >= REVIEWERS.length ? 'completed' : 'timeout';
      this.db.prepare('UPDATE commons_proposal_reviews SET status = ?, summary = ?, reply_count = ?, completed_at = ? WHERE improvement_id = ?')
        .run(status, this.summarize(replies), replies.length, new Date(now).toISOString(), review.improvement_id);
      if (status === 'completed') result.collected++; else result.timedOut++;
    }
    const open = pending.length - result.collected - result.timedOut;
    for (let slot = open; slot < this.maxOpen(); slot++) {
      if (this.postNext(now)) result.posted++; else break;
    }
    return result;
  }

  /** Reviewers' latest-first summary for a proposal, or null when not (yet) reviewed. */
  getReviewSummary(improvementId: string): string | null {
    const row = this.db.prepare("SELECT summary FROM commons_proposal_reviews WHERE improvement_id = ? AND status IN ('completed','timeout')")
      .get(improvementId) as { summary: string } | undefined;
    return row?.summary || null;
  }

  /**
   * Goal outcome → learning. Always un-sticks a proposal left in 'executing'
   * by a failed goal; memory candidates only when the feature is enabled.
   */
  recordGoalOutcome(goalId: string, outcome: 'completed' | 'failed', detail: string): void {
    const goal = this.db.prepare('SELECT improvement_id FROM goals WHERE id = ?').get(goalId) as { improvement_id: string | null } | undefined;
    if (!goal?.improvement_id) return;
    const imp = this.db.prepare('SELECT id, title, description FROM self_improvements WHERE id = ?').get(goal.improvement_id) as { id: string; title: string; description: string } | undefined;
    if (!imp) return;
    if (outcome === 'failed') {
      this.db.prepare("UPDATE self_improvements SET status = 'needs_more_evidence', updated_at = ? WHERE id = ? AND status = 'executing'")
        .run(new Date().toISOString(), imp.id);
    }
    if (!commonsReviewEnabled()) return;
    const review = this.getReviewSummary(imp.id);
    const common = { source_ref: `improvement:${imp.id}`, metadata: { improvement_id: imp.id, goal_id: goalId, origin: 'commons-proposal-review' } };
    if (outcome === 'failed') {
      this.memory.create({ ...common, title: `Failed self-improvement: ${imp.title}`.slice(0, 200), memory_type: 'operational_memory',
        content: `Goal ${goalId} for improvement "${imp.title}" failed: ${detail}${review ? `\nCommons review had advised:\n${review}` : ''}` });
    } else if (review) {
      // A reviewed proposal that shipped: the residents' next-step/stop-condition is a reusable how-to (procedural).
      this.memory.create({ ...common, title: `How-to (commons-reviewed): ${imp.title}`.slice(0, 200), memory_type: 'engineering_rule', store: 'procedural',
        content: `${imp.description}\nOutcome: ${detail}\nCommons guidance:\n${review}` });
    }
  }

  private postNext(now: number): boolean {
    const next = this.db.prepare(`
      SELECT s.id, s.title, s.description, s.rationale FROM self_improvements s
      WHERE s.status = 'needs_more_evidence' AND s.refined_at IS NULL AND s.refined_from_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM commons_proposal_reviews r WHERE r.improvement_id = s.id)
      ORDER BY s.priority DESC, s.created_at ASC LIMIT 1
    `).get() as { id: string; title: string; description: string; rationale: string } | undefined;
    if (!next) return false;
    const threadId = `social:${randomUUID()}`;
    const ref = `improvement:${next.id}`;
    const prompt = `Review this self-improvement proposal. Is it worth pursuing? Give a concrete falsifiable next step, a creative alternative and a stop condition.\nTitle: ${next.title}\nDescription: ${next.description.slice(0, 800)}\nRationale: ${next.rationale.slice(0, 500)}`;
    this.db.transaction(() => {
      for (const to of REVIEWERS) {
        this.comms.send({
          from: ASKER, to, type: 'question', action: 'social.question', context: prompt.slice(0, 1_800),
          evidence: [ref], threadId, epistemicRole: 'question', ttl: 86_400,
          params: { topic: `Proposal review: ${next.title}`.slice(0, 300), topic_ref: ref, effect_scope: 'isolated', facilitated_by: 'commons-proposal-review', board_summary: next.title.slice(0, 300) },
        });
      }
      this.db.prepare("INSERT INTO commons_proposal_reviews (improvement_id, thread_id, status, posted_at) VALUES (?, ?, 'pending', ?)")
        .run(next.id, threadId, new Date(now).toISOString());
    })();
    return true;
  }

  private replies(threadId: string): ReplyParams[] {
    const rows = this.db.prepare(`SELECT from_agent, payload_json FROM agent_messages
      WHERE json_extract(payload_json, '$.thread_id') = ? AND json_extract(payload_json, '$.action') = 'social.response'`).all(threadId) as Array<{ from_agent: string; payload_json: string }>;
    return rows.filter(r => (REVIEWERS as readonly string[]).includes(r.from_agent)).map(r => {
      const params = (JSON.parse(r.payload_json).params ?? {}) as ReplyParams;
      return { ...params, answer: `${r.from_agent}: ${params.answer ?? ''}` };
    });
  }

  private summarize(replies: ReplyParams[]): string {
    return replies.map(r => `- ${String(r.answer).slice(0, 400)} | next: ${String(r.falsifiable_next_step ?? '').slice(0, 250)} | alternative: ${String(r.creative_alternative ?? '').slice(0, 250)} | stop: ${String(r.stop_condition ?? '').slice(0, 200)}`).join('\n');
  }
}
