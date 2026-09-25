/**
 * Autonomous runtime services (G20+).
 * Only initialized when runtime profile enables autonomy.
 * Extracted from index.ts for separation of concerns.
 */
import { lifecycleManager } from '../services/lifecycle-manager';
import { LoopService } from '../services/loop-service';
import { SwarmIntelligenceService } from '../services/swarm-intelligence-service';
import { NestedSpawnService } from '../services/nested-spawn-service';
import { NegotiationCoordinator } from '../services/negotiation-coordinator';
import { CapabilityAcquisitionService } from '../services/capability-acquisition';
import { MetaEvolutionService } from '../services/meta-evolution-service';
import { AutonomousGoalGenerator } from '../services/autonomous-goal-generator';
import { ExpertSwarmOrchestrator } from '../services/expert-swarm-orchestrator';
import { WorkerPool } from '../services/worker-pool';
import { OkfKnowledgeUpdater } from '../services/okf-knowledge-updater';
import { RsiSafetyGuard } from '../services/rsi-safety-guard';
import { ServiceRefactoringAnalyzer } from '../services/service-refactoring-analyzer';
import { EmergentSpecializationService } from '../services/emergent-specialization-service';
import { ContinuousLearningLoop } from '../services/continuous-learning-loop';
import { TrajectoryStore } from '../services/trajectory-store';
import { CuriosityService } from '../services/curiosity-service';
import { BoardHandoffService } from '../services/board-handoff-service';
import { AgentSocialAutopilotService, autopilotConfigFromEnv } from '../services/agent-social-autopilot-service';
import { CommonsProposalReviewService, commonsReviewEnabled } from '../services/commons-proposal-review-service';
import { EventOutboxService, bridgeGoalEvents, eventPublishEnabled } from '../services/event-outbox-service';
import { AgentRegistrySyncService, registryUrl } from '../services/agent-registry-sync-service';
import { TestGapSourceService, testGapSourceEnabled } from '../services/test-gap-source-service';
import { DreamStateService, dreamStateEnabled } from '../services/dream-state-service';
import { NeedsGroundingTriageService, needsGroundingTriageEnabled } from '../services/needs-grounding-triage-service';
import { DiskGuardService, diskGuardEnabled } from '../services/disk-guard-service';
import { QueueHygieneService, queueHygieneEnabled } from '../services/queue-hygiene-service';
import { KnowledgeMaintenanceService, maintenanceEnabled } from '../services/knowledge-maintenance-service';

export function initAutonomousServices(db: any, recoverySvc: LoopService): void {
  try {
    if (process.env.DJIMITFLO_BOARD_HANDOFF_AUTONOMY !== 'false') {
      const handoff = new BoardHandoffService(db);
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          const result = handoff.reconcile(500);
          if (result.created || result.rejected) console.log(`[BoardHandoff] scanned=${result.scanned} created=${result.created} rejected=${result.rejected} status=${result.status}`);
          const publish = await handoff.publishPending(500);
          if (publish.attempted) console.log(`[BoardHandoff] outbox attempted=${publish.attempted} published=${publish.published} failed=${publish.failed} status=${publish.status}`);
        } catch (error) {
          console.warn('⚠️  Board handoff reconcile failed:', error instanceof Error ? error.message : String(error));
        } finally {
          running = false;
        }
      };
      const timer = setInterval(() => void tick(), 60_000);
      lifecycleManager.register({ serviceName: 'BoardHandoffService', stop: () => clearInterval(timer) });
      void tick();
    }
  } catch (error) {
    console.warn('⚠️  Board handoff failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  const learningLoop = new ContinuousLearningLoop(db);
  learningLoop.setTrajectoryStore(new TrajectoryStore(db));
  learningLoop.start();
  lifecycleManager.register({ serviceName: 'ContinuousLearningLoop', stop: () => learningLoop.stop() });
  void learningLoop.runCycle().catch((error) => {
    console.warn('⚠️  Initial continuous learning cycle failed (non-fatal):', error instanceof Error ? error.message : String(error));
  });

  // Agent Commons autopilot: residents heartbeat, answer and open rounds in-process (SOCIAL_AUTOPILOT_RUNTIME=ollama).
  try {
    const autopilotConfig = autopilotConfigFromEnv();
    if (autopilotConfig.runtime !== 'off') {
      const autopilot = new AgentSocialAutopilotService(db, autopilotConfig);
      autopilot.start();
      lifecycleManager.register({ serviceName: 'AgentSocialAutopilot', stop: () => autopilot.stop() });
      console.log(`🪐 Agent Commons autopilot on: runtime=${autopilotConfig.runtime} model=${autopilotConfig.model} agents=${autopilotConfig.agents} every ${autopilotConfig.intervalMs}ms`);
    }
  } catch (error) {
    console.warn('⚠️  Agent Commons autopilot failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Agent Commons reviews parked self-improvement proposals (advisory). Default off: COMMONS_PROPOSAL_REVIEW_ENABLED=true.
  try {
    if (commonsReviewEnabled()) {
      const commonsReview = new CommonsProposalReviewService(db);
      commonsReview.start();
      lifecycleManager.register({ serviceName: 'CommonsProposalReview', stop: () => commonsReview.stop() });
      console.log('🪐 Commons proposal review on (advisory; specialist panel remains the gate).');
    }
  } catch (error) {
    console.warn('⚠️  Commons proposal review failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  try {
    if (registryUrl()) {
      const registrySync = new AgentRegistrySyncService(db);
      registrySync.start();
      lifecycleManager.register({ serviceName: 'AgentRegistrySync', stop: () => registrySync.stop() });
      console.log('🛰️ Agent registry sync on (pull-only).');
    }
  } catch (error) {
    console.error('Agent registry sync failed to start:', error);
  }

  // Djimitflo domain events on the Djimit event bus (work items, approvals, goals) via an outbox. Default off.
  try {
    if (eventPublishEnabled()) {
      const outbox = new EventOutboxService(db);
      outbox.start();
      const unsubscribe = bridgeGoalEvents(db);
      lifecycleManager.register({ serviceName: 'EventOutbox', stop: () => { outbox.stop(); unsubscribe(); } });
      console.log('📣 Event publishing on (djimitflo.work_item/approval/goal events -> event bus).');
    }
  } catch (error) {
    console.warn('⚠️  Event publishing failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Test-gap source: deterministic, fully grounded test-only proposals for untested services. Default off.
  try {
    if (testGapSourceEnabled()) {
      const testGaps = new TestGapSourceService(db);
      testGaps.start();
      lifecycleManager.register({ serviceName: 'TestGapSource', stop: () => testGaps.stop() });
      console.log('🧪 Test-gap source on (max 2 proposals/day).');
    }
  } catch (error) {
    console.warn('⚠️  Test-gap source failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Outcome-driven dream state (plan E11): replay failed runs and classify their causes (shadow). Default off.
  try {
    if (dreamStateEnabled()) {
      const dreamState = new DreamStateService(db);
      dreamState.start();
      lifecycleManager.register({ serviceName: 'DreamState', stop: () => dreamState.stop() });
      console.log('🌙 Dream state on (failure-cause replay every 6 h).');
    }
  } catch (error) {
    console.warn('⚠️  Dream state failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Way out of needs_grounding based on reflection_triage (plan E2/E9c). Default off.
  try {
    if (needsGroundingTriageEnabled()) {
      const triage = new NeedsGroundingTriageService(db);
      triage.start();
      lifecycleManager.register({ serviceName: 'NeedsGroundingTriage', stop: () => triage.stop() });
      console.log('🧭 needs_grounding triage on (every 6 h, max 10 per run).');
    }
  } catch (error) {
    console.warn('⚠️  needs_grounding triage failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Disk guard: one work item + bus event per day when the data volume passes 80 % / 90 %. Default off.
  try {
    if (diskGuardEnabled()) {
      const diskGuard = new DiskGuardService(db);
      diskGuard.start();
      lifecycleManager.register({ serviceName: 'DiskGuard', stop: () => diskGuard.stop() });
      console.log('💾 Disk guard on (warn >= 80 %, critical >= 90 %).');
    }
  } catch (error) {
    console.warn('⚠️  Disk guard failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Queue hygiene: expires consumer-less work items, stale curiosity claims and unvalidated drafts. Default off.
  try {
    if (queueHygieneEnabled()) {
      const hygiene = new QueueHygieneService(db);
      hygiene.start();
      lifecycleManager.register({ serviceName: 'QueueHygiene', stop: () => hygiene.stop() });
      console.log('🧹 Queue hygiene on (work-item TTL, curiosity-claim expiry, draft-capability deprecation).');
    }
  } catch (error) {
    console.warn('⚠️  Queue hygiene failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Scheduled knowledge maintenance (OKF drift, wiki delta, OKF lint) -> work items. Default off.
  try {
    if (maintenanceEnabled()) {
      const maintenance = new KnowledgeMaintenanceService(db);
      maintenance.start();
      lifecycleManager.register({ serviceName: 'KnowledgeMaintenance', stop: () => maintenance.stop() });
      console.log('📚 Knowledge maintenance on (okf_sync_drift, wiki_delta, okf_lint).');
    }
  } catch (error) {
    console.warn('⚠️  Knowledge maintenance failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  const intelligence = new SwarmIntelligenceService(db);
  const nestedSpawns = new NestedSpawnService(db, recoverySvc, { intelligence, controlUrl: process.env.DJIMITFLO_CONTROL_URL || '' });

  try {
    const coordinator = new NegotiationCoordinator(recoverySvc, nestedSpawns, intelligence);
    coordinator.start();
    lifecycleManager.register({ serviceName: 'NegotiationCoordinator', stop: () => (coordinator as any)?.stop?.() });
    console.log('🤝 Negotiation coordinator started (inter-agent help_request protocol).');
  } catch (error) {
    console.warn('⚠️  Negotiation coordinator failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  try {
    const acquisition = new CapabilityAcquisitionService(db, intelligence);
    acquisition.start();
    lifecycleManager.register({ serviceName: 'CapabilityAcquisition', stop: () => (acquisition as any)?.stop?.() });
    console.log('🧠 Capability acquisition service started (autonomous capability growth).');
  } catch (error) {
    console.warn('⚠️  Capability acquisition failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  try {
    const metaEvolution = new MetaEvolutionService(db, intelligence);
    metaEvolution.start();
    lifecycleManager.register({ serviceName: 'MetaEvolution', stop: () => (metaEvolution as any)?.stop?.() });
    console.log('🔄 Meta-evolution service started (periodic self-evaluation + capability pruning).');
  } catch (error) {
    console.warn('⚠️  Meta-evolution failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  try {
    const autonomousGoals = new AutonomousGoalGenerator(db);
    const curiosity = new CuriosityService(db, intelligence);
    curiosity.start();
    lifecycleManager.register({ serviceName: 'CuriosityService', stop: () => curiosity.stop() });
    void curiosity.scanForGaps().catch((error) => {
      console.warn('⚠️  Initial curiosity scan failed (non-fatal):', error instanceof Error ? error.message : String(error));
    }).then(() => {
      const generated = autonomousGoals.generateAll();
      if (generated.total > 0) console.log(`🎯 Autonomous goals generated: ${generated.total} (${generated.improvements} improvements, ${generated.security} security)`);
    });
    // Panel-authorised (scheduled) proposals used to become goals only at boot: a requeued or late-scheduled proposal
    // waited for the next restart (prod 2026-09-25: dc1143b8 sat 'scheduled' for 40+ min). Only this generator, hourly.
    const scheduledTimer = setInterval(() => {
      try { const n = autonomousGoals.generateFromSelfImprovements(); if (n) console.log(`🎯 ${n} goal(s) from scheduled proposals`); }
      catch (err) { console.warn('Scheduled-proposal goals failed:', err instanceof Error ? err.message : String(err)); }
    }, Number(process.env.SCHEDULED_PROPOSAL_GOALS_INTERVAL_MS) || 3_600_000);
    scheduledTimer.unref?.();
    lifecycleManager.register({ serviceName: 'ScheduledProposalGoals', stop: () => clearInterval(scheduledTimer) });
  } catch (error) {
    console.warn('⚠️  Autonomous goal generation failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  try {
    const safetyGuard = new RsiSafetyGuard(db);
    const refactoringAnalyzer = new ServiceRefactoringAnalyzer(db);
    const emergentSpec = new EmergentSpecializationService(db);
    void safetyGuard;
    void refactoringAnalyzer;
    void emergentSpec;
    console.log('🧬 RSI Engine ready (Refactor + Safety + Specialization).');
  } catch (error) {
    console.warn('⚠️  RSI Engine initialization failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  try {
    const workerPool = new WorkerPool({ concurrency: 10 });
    const okfUpdater = new OkfKnowledgeUpdater(db);
    void workerPool;
    void okfUpdater;
    new ExpertSwarmOrchestrator(db);
    console.log('🎓 Expert Swarm Orchestrator + WorkerPool + OKF Updater ready.');
  } catch (error) {
    console.warn('⚠️  Expert Swarm initialization failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

}
