/**
 * SelfImprovementAutoReviewScheduler — closes the proposal -> reviewed ->
 * authorized-as-goal loop without a human in it, end to end.
 *
 * Ties together three pieces built for this: SelfImprovementAgentReviewService
 * (generates real, non-rubber-stamp specialist reviews per role),
 * SpecialistPanelService's consensus computation (now allows a 'goal' outcome
 * regardless of risk class — an explicit, deliberate policy change made at
 * operator request, see specialist-panel-service.ts), and
 * SelfImprovementService.agentApproveIfReady (the autonomous counterpart to
 * the human-only approveImprovement()).
 *
 * Each tick: for every 'proposed' self-improvement with a panel that isn't
 * consensus_ready yet, generate the missing specialist reviews; then, for
 * every 'proposed' self-improvement, attempt an agent approval (a no-op
 * unless its panel just reached consensus_ready with decision 'goal').
 *
 * Default-off. Arm with:
 *   SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED=true
 *   SELF_IMPROVEMENT_AUTO_REVIEW_INTERVAL_MINUTES=15   (default 15 — LLM
 *                                                        calls are slower
 *                                                        than a DB query)
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService, type ImprovementProposal } from './self-improvement-service';
import { SelfImprovementAgentReviewService } from './self-improvement-agent-review-service';
import { SpecialistPanelService } from './specialist-panel-service';

const MINUTE_MS = 60 * 1000;

export interface AutoReviewTickResult {
  reviewed: string[];
  approved: string[];
  parked: string[];
  failed: Array<{ id: string; error: string }>;
}

export class SelfImprovementAutoReviewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly improvements: SelfImprovementService;
  private readonly reviewer: SelfImprovementAgentReviewService;
  private readonly panels: SpecialistPanelService;

  constructor(db: Database, reviewer?: SelfImprovementAgentReviewService) {
    this.improvements = new SelfImprovementService(db);
    this.reviewer = reviewer ?? new SelfImprovementAgentReviewService(db);
    this.panels = new SpecialistPanelService(db);
  }

  /** Arm the scheduler. Returns false (no-op) unless explicitly enabled. */
  start(): boolean {
    if (process.env.SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED !== 'true') return false;
    const intervalMs = this.intervalMinutes() * MINUTE_MS;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
    void this.tick(); // catch-up on boot
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  intervalMinutes(): number {
    const minutes = Number(process.env.SELF_IMPROVEMENT_AUTO_REVIEW_INTERVAL_MINUTES ?? '15');
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
  }

  /**
   * Guarded against overlap: unlike the other in-process schedulers (pure
   * sync DB queries, effectively instant), this tick makes real LLM calls
   * against a shared fleet Ollama host and can run longer than the poll
   * interval. Without this guard, a slow tick would still be in flight when
   * the next interval fires, and two concurrent reviewMissingSpecialists()
   * calls on the same panel would race — same pattern as BoardHandoffService
   * in bootstrap/autonomous-services.ts.
   */
  async tick(): Promise<AutoReviewTickResult> {
    if (this.running) return { reviewed: [], approved: [], parked: [], failed: [] };
    this.running = true;
    try {
      const runId = randomUUID();
      const result: AutoReviewTickResult = { reviewed: [], approved: [], parked: [], failed: [] };
      const proposed = this.improvements.listImprovements('proposed');

      for (const proposal of proposed) {
        try {
          await this.reviewIfNeeded(proposal, runId, result);
        } catch (err) {
          result.failed.push({ id: proposal.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      for (const proposal of proposed) {
        try {
          const updated = this.improvements.agentApproveIfReady(proposal.id, runId);
          if (updated?.status === 'scheduled') result.approved.push(proposal.id);
          else if (updated?.status === 'needs_more_evidence') result.parked.push(proposal.id);
        } catch (err) {
          result.failed.push({ id: proposal.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Observability: this scheduler ran silently since it was deployed —
      // a 6-day, 104-proposal backlog of dead-ended reviews went unnoticed
      // as a result. Only log when something actually happened this tick.
      if (result.reviewed.length || result.approved.length || result.parked.length || result.failed.length) {
        console.log(`🧭 self-improvement auto-review tick: reviewed=${result.reviewed.length} approved=${result.approved.length} parked=${result.parked.length} failed=${result.failed.length}`);
      }

      return result;
    } finally {
      this.running = false;
    }
  }

  private async reviewIfNeeded(proposal: ImprovementProposal, runId: string, result: AutoReviewTickResult): Promise<void> {
    if (!proposal.panelId) return;
    const panel = this.panels.getPanel(proposal.panelId);
    if (panel.status === 'consensus_ready' || panel.status === 'cancelled'
      || panel.status === 'backlog_created' || panel.status === 'goal_created') return;
    await this.reviewer.reviewMissingSpecialists(proposal.panelId, runId);
    result.reviewed.push(proposal.id);
  }
}
