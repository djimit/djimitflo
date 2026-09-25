/**
 * MemoryCandidateReviewScheduler — replaces the broken auto-promotion gate
 * for memory candidates with real specialist-panel analysis, and closes a
 * genuine evolution loop on top of it.
 *
 * MemoryEvolutionService.computeQualityScore()/evaluatePromotion() (the
 * intended auto-promotion gate) turned out to be structurally unsatisfiable
 * (discrimination >= 0.6 requires status='promoted', i.e. eligibility
 * requires already being promoted) — found while building PR #267, which
 * deliberately stopped at a safe listPendingPromotion() query rather than
 * invent a replacement threshold. This scheduler is that replacement,
 * built entirely from infrastructure already proven in production today:
 *
 * - SpecialistPanelService's catalog already has a `memory_scientist` role
 *   (specialist-panel-service.ts) whose default_questions are literally
 *   "What deserves durable memory? What must remain candidate-only?" —
 *   evidently built for exactly this, never wired up.
 * - SelfImprovementAgentReviewService generates real, non-rubber-stamp LLM
 *   specialist reviews for any SpecialistPanelRecord — reused here
 *   unmodified; it has no self-improvement-specific coupling.
 * - computeConsensus()'s 'goal' decision (unanimous support, confidence
 *   >= 0.8) is reused generically as "yes, promote this candidate."
 *
 * Evolution loop: when 5 memory-candidate panels accumulate a non-'goal'
 * decision without yet contributing to a reflection, their dissent is
 * folded into one SelfImprovementService.generateFromReflection() call
 * suggesting the memory_scientist specialist's criteria be reviewed. That
 * proposal flows through the already-deployed self-improvement
 * agent-approve pipeline like any other — genuine review, autonomous goal
 * authorization if warranted, and if authorized, a real loop-worker PR
 * editing the actual catalog entry (specialist-panel-service.ts) — not a
 * black-box score. generateFromReflection()'s existing fingerprint dedup
 * (unmodified) naturally caps this to one active evolution proposal at a
 * time: a second can't be created until the first resolves.
 *
 * Every memory-candidate panel is tagged metadata.memory_candidate_id, and
 * SpecialistPanelBacklogScheduler was extended to exclude it — otherwise
 * that scheduler would race this one to project the same panel into a
 * generic backlog work item.
 *
 * A reviewed candidate whose panel reaches consensus_ready on anything
 * other than 'goal' is parked (promotion_status -> 'blocked_pending_review')
 * rather than left at 'proposed' forever — the self-improvement pipeline
 * had exactly this gap and it produced a silent, unbounded backlog (104
 * proposals stuck for up to 6 days) before anyone noticed. See
 * MemoryCandidateService.markNeedsMoreEvidence().
 *

 * Default-off. Arm with:
 *   MEMORY_CANDIDATE_REVIEW_ENABLED=true
 *   MEMORY_CANDIDATE_REVIEW_INTERVAL_MINUTES=15 (default — LLM calls are
 *                                                 slower than a DB query)
 */

import type { Database } from 'better-sqlite3';
import { MemoryCandidateService, type MemoryCandidateRecord } from './memory-candidate-service';
import { SpecialistPanelService, type SpecialistPanelRecord } from './specialist-panel-service';
import { SelfImprovementAgentReviewService } from './self-improvement-agent-review-service';
import { SelfImprovementService } from './self-improvement-service';

const MINUTE_MS = 60 * 1000;
const SCHEDULER_ACTOR = 'agent:memory-approver';
const EVOLUTION_THRESHOLD = 5;

export interface MemoryReviewTickResult {
  reviewed: string[];
  promoted: string[];
  parked: string[];
  failed: Array<{ id: string; error: string }>;
  evolutionProposalGenerated: boolean;
}

type Reviewer = Pick<SelfImprovementAgentReviewService, 'reviewMissingSpecialists'>;

export class MemoryCandidateReviewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly candidates: MemoryCandidateService;
  private readonly panels: SpecialistPanelService;
  private readonly reviewer: Reviewer;
  private readonly selfImprovements: SelfImprovementService;

  constructor(db: Database, deps: { reviewer?: Reviewer } = {}) {
    this.candidates = new MemoryCandidateService(db);
    this.panels = new SpecialistPanelService(db);
    this.reviewer = deps.reviewer ?? new SelfImprovementAgentReviewService(db);
    this.selfImprovements = new SelfImprovementService(db);
  }

  start(): boolean {
    if (process.env.MEMORY_CANDIDATE_REVIEW_ENABLED !== 'true') return false;
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
    const minutes = Number(process.env.MEMORY_CANDIDATE_REVIEW_INTERVAL_MINUTES ?? '15');
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
  }

  async tick(): Promise<MemoryReviewTickResult> {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result: MemoryReviewTickResult = { reviewed: [], promoted: [], parked: [], failed: [], evolutionProposalGenerated: false };

    for (const candidate of this.candidates.listPendingPromotion()) {
      try {
        await this.reviewOne(candidate, runId, result);
      } catch (err) {
        result.failed.push({ id: candidate.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    try {
      result.evolutionProposalGenerated = this.maybeGenerateEvolutionProposal();
    } catch (err) {
      result.failed.push({ id: 'evolution', error: err instanceof Error ? err.message : String(err) });
    }

    if (result.reviewed.length || result.promoted.length || result.parked.length || result.failed.length || result.evolutionProposalGenerated) {
      console.log(`🧬 memory-candidate review tick: reviewed=${result.reviewed.length} promoted=${result.promoted.length} parked=${result.parked.length} failed=${result.failed.length} evolutionProposal=${result.evolutionProposalGenerated}`);
    }

    return result;
  }

  private async reviewOne(candidate: MemoryCandidateRecord, runId: string, result: MemoryReviewTickResult): Promise<void> {
    const panelId = this.panelIdFor(candidate) ?? this.createPanelFor(candidate).id;
    await this.reviewer.reviewMissingSpecialists(panelId, runId);
    result.reviewed.push(candidate.id);

    const panel = this.panels.getPanel(panelId);
    if (panel.status !== 'consensus_ready') return;
    if (panel.consensus.decision === 'goal') {
      this.candidates.promote(candidate.id, { approved_by: `${SCHEDULER_ACTOR}:${runId}` });
      result.promoted.push(candidate.id);
    } else {
      this.candidates.markNeedsMoreEvidence(candidate.id);
      result.parked.push(candidate.id);
    }
  }

  private panelIdFor(candidate: MemoryCandidateRecord): string | null {
    const panelId = candidate.metadata.review_panel_id;
    return typeof panelId === 'string' ? panelId : null;
  }

  private createPanelFor(candidate: MemoryCandidateRecord): SpecialistPanelRecord {
    const panel = this.panels.createPanel({
      topic: candidate.title,
      question: 'Should this be promoted to durable memory?',
      risk_class: 'low',
      specialist_ids: ['memory_scientist', 'security_reviewer'],
      context: { content: candidate.content, memory_type: candidate.memory_type },
      metadata: { memory_candidate_id: candidate.id },
    });
    this.candidates.setReviewPanel(candidate.id, panel.id);
    return panel;
  }

  /**
   * Folds accumulated non-'goal' memory-candidate panel dissent into one
   * self-improvement reflection, once 5 have built up since the last one.
   * generateFromReflection()'s own fingerprint dedup means a second
   * proposal can't be created until the first resolves — no extra cooldown
   * logic needed here.
   */
  private maybeGenerateEvolutionProposal(): boolean {
    const unreviewed = this.panels.listPanels(500).filter((panel) =>
      panel.metadata.memory_candidate_id
      && panel.status === 'consensus_ready'
      && panel.consensus.decision !== 'goal'
      && !panel.metadata.evolution_reviewed
    );
    if (unreviewed.length < EVOLUTION_THRESHOLD) return false;

    const batch = unreviewed.slice(0, EVOLUTION_THRESHOLD);
    const lessons = batch.flatMap((panel) => panel.consensus.dissent.map((d) => d.limitations).filter((limitation): limitation is string => Boolean(limitation)));
    this.selfImprovements.generateFromReflection({
      whatFailed: [`${batch.length} memory-candidate reviews reached '${batch.map((p) => p.consensus.decision).join("', '")}' instead of promotion`],
      lessonsLearned: lessons.length ? lessons : ['Specialist panel repeatedly found insufficient evidence for durable memory promotion'],
      proposedImprovements: ["Review why the memory-candidate specialist panel keeps blocking promotions — consider adjusting the memory_scientist specialist's evaluation criteria in specialist-panel-service.ts"],
    });

    for (const panel of batch) {
      this.panels.updateMetadata(panel.id, { evolution_reviewed: true });
    }
    return true;
  }
}
