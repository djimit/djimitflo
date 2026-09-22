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
 * every 'proposed' self-improvement, attempt an agent approval (parks it as
 * 'needs_more_evidence' if its panel reached consensus_ready without 'goal');
 * then, a bounded refinement pass — see SELF_IMPROVEMENT_REFINEMENT_ENABLED
 * below.
 *
 * Default-off. Arm with:
 *   SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED=true
 *   SELF_IMPROVEMENT_AUTO_REVIEW_INTERVAL_MINUTES=15   (default 15 — LLM
 *                                                        calls are slower
 *                                                        than a DB query)
 *
 * Refinement pass (independently toggled, off by default):
 *   SELF_IMPROVEMENT_REFINEMENT_ENABLED=true — turns a parked proposal's
 *     specialist dissent into one refined follow-up (SelfImprovementRefinementService),
 *     instead of discarding specific, actionable reviewer feedback. Found
 *     2026-09-19/20: 0 of 357 proposals ever reached 'goal' with this off.
 *   SELF_IMPROVEMENT_REFINEMENT_MAX_PER_TICK=3 (default 3, hard ceiling 10) —
 *     production had 200 proposals already parked the moment this shipped;
 *     this caps LLM calls per tick so arming it doesn't fire ~200 at once
 *     against the shared Ollama host (mirrors AgentSocialAutopilotService's
 *     maxRepliesPerTick ceiling).
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService, type ImprovementProposal } from './self-improvement-service';
import { SelfImprovementAgentReviewService } from './self-improvement-agent-review-service';
import { SelfImprovementRefinementService } from './self-improvement-refinement-service';
import { SpecialistPanelService } from './specialist-panel-service';
import { CommonsProposalReviewService } from './commons-proposal-review-service';
import { judgmentMode, runJudgment } from './judgment-service';
import { AutonomousGoalGenerator } from './autonomous-goal-generator';
import { namedPathsExist, proposalPrescreen } from './judgments/proposal-prescreen';

const MINUTE_MS = 60 * 1000;
const REFINEMENT_MAX_PER_TICK_CEILING = 10;

export interface AutoReviewTickResult {
  reviewed: string[];
  approved: string[];
  parked: string[];
  refined: string[];
  /**
   * Refinement attempts this tick (successful or not) — distinct from
   * refined.length so a persistently-failing refiner is still visible in the
   * tick log. Found in production: a refiner returning null on every call
   * (e.g. a misconfigured model) contributes to neither `refined` nor
   * `failed`, so without this the log-only-when-something-happened condition
   * below would stay silent forever even while refinement is completely
   * broken — exactly the kind of blind spot this scheduler's observability
   * was added to catch.
   */
  refinementAttempted: number;
  failed: Array<{ id: string; error: string }>;
}

export class SelfImprovementAutoReviewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly improvements: SelfImprovementService;
  private readonly reviewer: SelfImprovementAgentReviewService;
  private readonly refiner: SelfImprovementRefinementService;
  private readonly panels: SpecialistPanelService;
  private readonly commons: CommonsProposalReviewService;
  private readonly db: Database;

  constructor(db: Database, reviewer?: SelfImprovementAgentReviewService, refiner?: SelfImprovementRefinementService) {
    this.db = db;
    this.improvements = new SelfImprovementService(db);
    this.reviewer = reviewer ?? new SelfImprovementAgentReviewService(db);
    this.refiner = refiner ?? new SelfImprovementRefinementService();
    this.panels = new SpecialistPanelService(db);
    this.commons = new CommonsProposalReviewService(db);
  }

  /** Arm the scheduler. Returns false (no-op) unless explicitly enabled. */
  start(): boolean {
    if (process.env.SELF_IMPROVEMENT_AUTO_REVIEW_ENABLED !== 'true') return false;
    // A judge from the same model as the writer shares its blind spots (LLM-as-judge self-preference).
    const reviewModel = process.env.SELF_IMPROVEMENT_REVIEW_MODEL;
    const writerModel = process.env.SELF_IMPROVEMENT_REFINEMENT_MODEL || reviewModel;
    if (reviewModel && reviewModel === writerModel) console.warn(`⚠️  self-improvement review and refinement use the same model (${reviewModel}); use a different model family for independent review`);
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

  private refinementEnabled(): boolean {
    return process.env.SELF_IMPROVEMENT_REFINEMENT_ENABLED === 'true';
  }

  refinementMaxPerTick(): number {
    const n = Number(process.env.SELF_IMPROVEMENT_REFINEMENT_MAX_PER_TICK ?? '3');
    const normalized = Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
    return Math.min(REFINEMENT_MAX_PER_TICK_CEILING, normalized);
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
    if (this.running) return { reviewed: [], approved: [], parked: [], refined: [], refinementAttempted: 0, failed: [] };
    this.running = true;
    try {
      const runId = randomUUID();
      const result: AutoReviewTickResult = { reviewed: [], approved: [], parked: [], refined: [], refinementAttempted: 0, failed: [] };
      const proposed = this.improvements.listImprovements('proposed');

      for (const proposal of proposed) {
        try {
          // System One pre-screen: shadow mode records what it WOULD decide next to the panel's real outcome (fail-open, never blocks).
          if (judgmentMode(proposalPrescreen.id) !== 'off') await runJudgment(this.db, proposalPrescreen, { type: 'self_improvement', id: proposal.id },
            { proposal: { type: proposal.type, title: proposal.title, description: proposal.description, rationale: proposal.rationale } }, undefined,
            process.env.LOOP_REPOSITORY_PATH ? { pathExists: namedPathsExist(`${proposal.description ?? ''} ${proposal.rationale ?? ''}`, process.env.LOOP_REPOSITORY_PATH) } : undefined).catch(() => null);
          await this.reviewIfNeeded(proposal, runId, result);
        } catch (err) {
          result.failed.push({ id: proposal.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      for (const proposal of proposed) {
        try {
          const updated = this.improvements.agentApproveIfReady(proposal.id, runId);
          if (updated?.status === 'scheduled') {
            result.approved.push(proposal.id);
            // Turn the approved proposal into a goal now instead of waiting up to an hour for the learning loop (time-to-verified).
            // The approval gate before the maker is unchanged: this only removes idle time.
            if (process.env.SELF_IMPROVEMENT_GOAL_ON_APPROVE === 'true') {
              try { new AutonomousGoalGenerator(this.db).generateImprovement(proposal.id); } catch { /* the hourly loop remains the fallback */ }
            }
          }
          else if (updated?.status === 'needs_more_evidence') result.parked.push(proposal.id);
        } catch (err) {
          result.failed.push({ id: proposal.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (this.refinementEnabled()) {
        const eligible = this.improvements.getRefinementEligible(this.refinementMaxPerTick());
        result.refinementAttempted = eligible.length;
        for (const parked of eligible) {
          try {
            if (await this.refineOne(parked)) result.refined.push(parked.id);
          } catch (err) {
            result.failed.push({ id: parked.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      // Observability: this scheduler ran silently since it was deployed —
      // a 6-day, 104-proposal backlog of dead-ended reviews went unnoticed
      // as a result. Only log when something actually happened this tick —
      // refinementAttempted (not just refined) counts, so a refiner that's
      // attempting but always failing (e.g. a misconfigured model) still
      // shows up instead of going quiet.
      if (result.reviewed.length || result.approved.length || result.parked.length || result.refined.length || result.refinementAttempted || result.failed.length) {
        console.log(`🧭 self-improvement auto-review tick: reviewed=${result.reviewed.length} approved=${result.approved.length} parked=${result.parked.length} refined=${result.refined.length}/${result.refinementAttempted} failed=${result.failed.length}`);
      }

      return result;
    } finally {
      this.running = false;
    }
  }

  private async refineOne(parked: ImprovementProposal): Promise<boolean> {
    if (!parked.panelId) return false;
    const panel = this.panels.getPanel(parked.panelId);
    if (panel.status !== 'consensus_ready') return false;
    const draft = await this.refiner.refine(parked, panel.consensus.dissent, this.commons.getReviewSummary(parked.id));
    if (!draft) return false;
    return this.improvements.refineFromDissent(parked.id, draft) !== null;
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
