/**
 * SpecialistPanelBacklogScheduler — closes the "Backlog Work Items" loop on
 * /swarm-resources.
 *
 * SpecialistPanelService.projectPanelToBacklog() (turns a consensus_ready
 * panel into a real work item) is only ever called from
 * POST /swarms/specialist-panels/:id/backlog — a human/API-triggered route.
 * Nothing calls it automatically, so any general (non-self-improvement)
 * panel that reaches consensus_ready sits forever with no work item created
 * unless a human manually does it.
 *
 * Deliberately excludes any panel with metadata.self_improvement_id set —
 * those panels are exclusively owned by the self-improvement pipeline
 * (SelfImprovementAutoReviewScheduler / SelfImprovementService.
 * agentApproveIfReady / approveImprovement). projectPanelToBacklog() itself
 * has no such guard, so scanning ALL consensus_ready panels indiscriminately
 * would fast-track a self-improvement proposal still sitting at
 * 'needs_more_evidence' into a generic backlog work item — a shadow path
 * around that pipeline's own status tracking. This scheduler only ever
 * touches general panels created directly via POST /specialist-panels.
 *
 * Default-off. Arm with:
 *   SPECIALIST_PANEL_BACKLOG_ENABLED=true
 *   SPECIALIST_PANEL_BACKLOG_INTERVAL_MINUTES=15 (default)
 */

import type { Database } from 'better-sqlite3';
import { SpecialistPanelService } from './specialist-panel-service';

const MINUTE_MS = 60 * 1000;

export interface BacklogTickResult {
  projected: string[];
  failed: Array<{ id: string; error: string }>;
}

export class SpecialistPanelBacklogScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly panels: SpecialistPanelService;

  constructor(db: Database) {
    this.panels = new SpecialistPanelService(db);
  }

  start(): boolean {
    if (process.env.SPECIALIST_PANEL_BACKLOG_ENABLED !== 'true') return false;
    const intervalMs = this.intervalMinutes() * MINUTE_MS;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
    this.tick(); // catch-up on boot
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  intervalMinutes(): number {
    const minutes = Number(process.env.SPECIALIST_PANEL_BACKLOG_INTERVAL_MINUTES ?? '15');
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 15;
  }

  tick(): BacklogTickResult {
    const result: BacklogTickResult = { projected: [], failed: [] };
    const candidates = this.panels.listPanels(500).filter((panel) =>
      panel.status === 'consensus_ready'
      && panel.consensus.decision !== 'blocked'
      && !panel.metadata.self_improvement_id
    );
    for (const panel of candidates) {
      try {
        this.panels.projectPanelToBacklog(panel.id);
        result.projected.push(panel.id);
      } catch (err) {
        result.failed.push({ id: panel.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }
}
