/**
 * FrontierExpertScheduler — closes gap G-06 from the project's own
 * frontier-experts gap register: "No scheduler triggers re-enrichment yet
 * (bounded enrichBatch is manual)."
 *
 * Automates exactly three stages of the expert lifecycle, each already a
 * real, tested, individually-callable method that today only ever runs when
 * a human/script calls it: discovery (PacingFrontierIngestionService.ingest),
 * evidence enrichment (ExpertEvidenceEnrichmentService.enrichBatch), and
 * peer cross-review (ExpertCouncilService.reviewExpert, mirroring
 * scripts/review-experts.ts's own pairing logic).
 *
 * Deliberately stops there. FrontierExpertRegistryService.transition() has a
 * hard-coded actor guard at the CHECKED -> APPROVED -> ACTIVE steps (actor
 * must not match /^(system|ingestion|swarm|autopilot)/i, and checker/
 * approver must differ) — a deliberate governance wall, not an oversight,
 * and not something this change was asked to remove. This scheduler has no
 * code path anywhere near that transition; approval/activation stays
 * exactly as it is today, a human via POST /expert/experts/:id/transition.
 *
 * Default-off, and only meaningful when the existing feature flag is also
 * on. Arm with:
 *   DJIMITFLO_FRONTIER_EXPERTS_ENABLED=true   (already gates the feature)
 *   FRONTIER_EXPERTS_SCHEDULER_ENABLED=true
 *   FRONTIER_EXPERTS_SCHEDULER_INTERVAL_MINUTES=60 (default — matches
 *     pacing ingestion's own built-in 1-request/hour ceiling)
 */

import type { Database } from 'better-sqlite3';
import { FrontierExpertRegistryService, frontierExpertsEnabled } from './frontier-expert-registry-service';
import { PacingFrontierIngestionService } from './pacing-frontier-ingestion-service';
import { ExpertEvidenceEnrichmentService } from './expert-evidence-enrichment-service';
import { ExpertCouncilService } from './expert-council-service';

const MINUTE_MS = 60 * 1000;
const SCHEDULER_ACTOR = 'autopilot:frontier-experts';
const PEER_REVIEW_ACTION = 'frontier_expert_peer_review';

type Ingestor = Pick<PacingFrontierIngestionService, 'ingest'>;
type Enricher = Pick<ExpertEvidenceEnrichmentService, 'enrichBatch'>;
type Reviewer = Pick<ExpertCouncilService, 'reviewExpert'>;

export interface FrontierExpertTickResult {
  ingested: boolean;
  enriched: number;
  reviewed: string[];
  failed: Array<{ stage: 'ingest' | 'enrich' | 'review'; error: string; expert_id?: string }>;
}

export class FrontierExpertScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly registry: FrontierExpertRegistryService;
  private readonly ingestion: Ingestor;
  private readonly enrichment: Enricher;
  private readonly council: Reviewer;

  constructor(private readonly db: Database, deps: { ingestion?: Ingestor; enrichment?: Enricher; council?: Reviewer } = {}) {
    this.registry = new FrontierExpertRegistryService(db);
    this.ingestion = deps.ingestion ?? new PacingFrontierIngestionService(db, { registry: this.registry });
    this.enrichment = deps.enrichment ?? new ExpertEvidenceEnrichmentService(db, { registry: this.registry });
    this.council = deps.council ?? new ExpertCouncilService(db);
  }

  /** Arm the scheduler. Returns false (no-op) unless both this and the base feature flag are enabled. */
  start(): boolean {
    if (!frontierExpertsEnabled(process.env)) return false;
    if (process.env.FRONTIER_EXPERTS_SCHEDULER_ENABLED !== 'true') return false;
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
    const minutes = Number(process.env.FRONTIER_EXPERTS_SCHEDULER_INTERVAL_MINUTES ?? '60');
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
  }

  async tick(): Promise<FrontierExpertTickResult> {
    const result: FrontierExpertTickResult = { ingested: false, enriched: 0, reviewed: [], failed: [] };

    try {
      const ingestResult = await this.ingestion.ingest({ actor: SCHEDULER_ACTOR });
      result.ingested = ingestResult.fetched;
    } catch (err) {
      result.failed.push({ stage: 'ingest', error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const enrichResults = await this.enrichment.enrichBatch({ actor: SCHEDULER_ACTOR, limit: 5 });
      result.enriched = enrichResults.length;
    } catch (err) {
      result.failed.push({ stage: 'enrich', error: err instanceof Error ? err.message : String(err) });
    }

    await this.reviewCapabilityInferred(result);

    return result;
  }

  /**
   * Mirrors scripts/review-experts.ts's own pairing logic (peer with the
   * most shared capabilities), but checks idempotency against the durable
   * audit_events row reviewExpert() already writes instead of that script's
   * file-based JSONL log — no file I/O in an in-process scheduler.
   */
  private async reviewCapabilityInferred(result: FrontierExpertTickResult): Promise<void> {
    const experts = this.registry.list({ state: 'CAPABILITY_INFERRED', limit: 50 });
    if (experts.length < 2) return;

    for (const target of experts) {
      const peers = experts
        .filter((peer) => peer.id !== target.id)
        .sort((a, b) => this.sharedCapabilities(b, target) - this.sharedCapabilities(a, target));
      const peer = peers[0];
      if (!peer) continue;
      try {
        if (this.alreadyReviewed(target.id, target.version, peer.id, peer.version)) continue;
        await this.council.reviewExpert(target.id, peer.id, SCHEDULER_ACTOR);
        result.reviewed.push(target.id);
      } catch (err) {
        result.failed.push({ stage: 'review', expert_id: target.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private sharedCapabilities(a: { capabilities: string[] }, b: { capabilities: string[] }): number {
    return a.capabilities.filter((id) => b.capabilities.includes(id)).length;
  }

  private alreadyReviewed(expertId: string, expertVersion: number, reviewerId: string, reviewerVersion: number): boolean {
    const runtime = process.env.FRONTIER_EXPERTS_RUNTIME;
    const rows = this.db.prepare(
      "SELECT metadata FROM audit_events WHERE action = ? AND resource_id = ?"
    ).all(PEER_REVIEW_ACTION, expertId) as Array<{ metadata: string }>;
    return rows.some((row) => {
      let report: { expert_version?: number; reviewer_id?: string; reviewer_version?: number; runtime?: string } = {};
      try { report = JSON.parse(row.metadata || '{}'); } catch { return false; }
      return report.expert_version === expertVersion
        && report.reviewer_id === reviewerId
        && report.reviewer_version === reviewerVersion
        && report.runtime === runtime;
    });
  }
}
