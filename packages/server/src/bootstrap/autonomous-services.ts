/**
 * Autonomous runtime services (G20+).
 * Only initialized when runtime profile enables autonomy.
 * Extracted from index.ts for separation of concerns.
 */
import { lifecycleManager } from '../services/lifecycle-manager';
import { markRun, noteScheduler } from '../services/scheduler-registry';
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
import { DeadCodeSourceService, deadCodeLaneEnabled } from '../services/dead-code-source-service';
import { EvolutionGymService, gymEnabled } from '../services/evolution-gym-service';
import { DreamStateService, dreamStateEnabled } from '../services/dream-state-service';
import { NeedsGroundingTriageService, needsGroundingTriageEnabled } from '../services/needs-grounding-triage-service';
import { DiskGuardService, diskGuardEnabled } from '../services/disk-guard-service';
import { QueueHygieneService, queueHygieneEnabled } from '../services/queue-hygiene-service';
import { startStallWatch } from '../services/stall-watch';
import { startInterestFeedback } from '../services/interest-feedback';
import { startDreamEvolution } from '../services/dream-evolution';
import { startEvolutionEstimators } from '../services/evolution-estimators';
import { startMergeSurvival } from '../services/merge-survival';
import { startLoopAutoMerge } from '../services/loop-auto-merge';
import { startCommitteeEvolution } from '../services/committee-swarm';
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
    if (noteScheduler('test_gap_source', 'TEST_GAP_SOURCE_ENABLED', testGapSourceEnabled(), 6 * 3_600_000)) {
      const testGaps = new TestGapSourceService(db);
      testGaps.start();
      lifecycleManager.register({ serviceName: 'TestGapSource', stop: () => testGaps.stop() });
      console.log('🧪 Test-gap source on (max 2 proposals/day).');
    }
  } catch (error) {
    console.warn('⚠️  Test-gap source failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Dead-code lane: proposals to remove unused files / dormant route groups; human approval and merge. Default off.
  try {
    if (noteScheduler('dead_code_lane', 'DEAD_CODE_LANE_ENABLED', deadCodeLaneEnabled(), 12 * 3_600_000)) {
      const deadCode = new DeadCodeSourceService(db);
      deadCode.start();
      lifecycleManager.register({ serviceName: 'DeadCodeSource', stop: () => deadCode.stop() });
      console.log(`🧹 Dead-code lane on (max ${Number(process.env.DEAD_CODE_MAX_PER_DAY) || 2} proposals/day).`);
    }
  } catch (error) {
    console.warn('⚠️  Dead-code lane failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // C2 evolution gym: sandbox replay tasks from our own history; outcomes feed species selection. Default off.
  try {
    if (noteScheduler('evolution_gym', 'EVOLUTION_GYM_ENABLED', gymEnabled(), 3_600_000)) {
      const gym = new EvolutionGymService(db, recoverySvc);
      gym.start();
      lifecycleManager.register({ serviceName: 'EvolutionGym', stop: () => gym.stop() });
      console.log(`🏋️ Evolution gym on (max ${Number(process.env.EVOLUTION_GYM_MAX_PER_DAY) || 12} attempts/day).`);
    }
  } catch (error) {
    console.warn('⚠️  Evolution gym failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Outcome-driven dream state (plan E11): replay failed runs and classify their causes (shadow). Default off.
  try {
    if (noteScheduler('dream_state', 'DREAM_STATE_ENABLED', dreamStateEnabled(), 6 * 3_600_000)) {
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

  // N4: daily interest profile for the fleet scouts (djimitflo.feedback.interests). FEEDBACK_INTERESTS_ENABLED=true.
  try {
    const stopFeedback = startInterestFeedback(db);
    if (stopFeedback) { lifecycleManager.register({ serviceName: 'InterestFeedback', stop: stopFeedback }); console.log('📣 Interest feedback on (daily).'); }
  } catch (error) {
    console.warn('⚠️  Interest feedback failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Y3: dreaming as mutation — daily mutants of the maker genome, judged on the frozen gym holdout. DREAM_EVOLUTION_ENABLED=true.
  try {
    const stopDream = startDreamEvolution(db);
    noteScheduler('dream_evolution', 'DREAM_EVOLUTION_ENABLED', !!stopDream, 3_600_000);
    if (stopDream) { lifecycleManager.register({ serviceName: 'DreamEvolution', stop: stopDream }); console.log('🧬 Dream evolution on (hourly tick, one dream a day).'); }
  } catch (error) {
    console.warn('⚠️  Dream evolution failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // RX-14: nightly evolution estimates (thermometer) — one row per estimator, scope and UTC day. EVOLUTION_ESTIMATORS_ENABLED=true.
  try {
    const stopEstimates = startEvolutionEstimators(db);
    noteScheduler('evolution_estimators', 'EVOLUTION_ESTIMATORS_ENABLED', !!stopEstimates, 3_600_000);
    if (stopEstimates) { lifecycleManager.register({ serviceName: 'EvolutionEstimators', stop: stopEstimates }); console.log('🌡️  Evolution estimates on (daily).'); }
  } catch (error) {
    console.warn('⚠️  Evolution estimates failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // AR-W3: committee members evolve on real-outcome skill (extinction n >= 30, one child a day). COMMITTEE_SWARM_ENABLED=true.
  try {
    const stopCommittee = startCommitteeEvolution(db);
    noteScheduler('committee_evolution', 'COMMITTEE_SWARM_ENABLED', !!stopCommittee, 3_600_000);
    if (stopCommittee) { lifecycleManager.register({ serviceName: 'CommitteeEvolution', stop: stopCommittee }); console.log('🧠 Committee evolution on (daily).'); }
  } catch (error) {
    console.warn('⚠️  Committee evolution failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // EV4: loop draft PRs settled by merge + 14 days in main → skill outcomes (domain 'merge'). MERGE_SURVIVAL_ENABLED=true.
  try {
    const stopMerge = startMergeSurvival(db);
    noteScheduler('merge_survival', 'MERGE_SURVIVAL_ENABLED', !!stopMerge, 6 * 3_600_000);
    if (stopMerge) { lifecycleManager.register({ serviceName: 'MergeSurvival', stop: stopMerge }); console.log('🧾 Merge survival on (every 6 h).'); }
  } catch (error) {
    console.warn('⚠️  Merge survival failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Earned auto-merge for verified test-only loop PRs (shadow/act, self-revoking). LOOP_AUTO_MERGE_TEST_ONLY=shadow|act.
  try {
    const stopAutoMerge = startLoopAutoMerge(db);
    noteScheduler('loop_auto_merge', 'LOOP_AUTO_MERGE_TEST_ONLY', !!stopAutoMerge, 15 * 60_000);
    if (stopAutoMerge) { lifecycleManager.register({ serviceName: 'LoopAutoMerge', stop: stopAutoMerge }); console.log('🤝 Loop auto-merge (test-only) on (every 15 min).'); }
  } catch (error) {
    console.warn('⚠️  Loop auto-merge failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

  // Stall watch (M10): hourly log line per silent stall. STALL_WATCH_ENABLED=true (default off).
  try {
    const stopStallWatch = startStallWatch(db);
    noteScheduler('stall_watch', 'STALL_WATCH_ENABLED', !!stopStallWatch, 3_600_000);
    if (stopStallWatch) { lifecycleManager.register({ serviceName: 'StallWatch', stop: stopStallWatch }); console.log('🚨 Stall watch on (hourly).'); }
  } catch (error) {
    console.warn('⚠️  Stall watch failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
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
    }).catch((error) => {
      // an error here used to be an unhandled rejection that killed the process on every boot (prod 2026-09-25)
      console.warn('⚠️  Autonomous goal generation failed (non-fatal):', error instanceof Error ? error.message : String(error));
    });
    // Panel-authorised (scheduled) proposals used to become goals only at boot: a requeued or late-scheduled proposal
    // waited for the next restart (prod 2026-09-25: dc1143b8 sat 'scheduled' for 40+ min). Only this generator, hourly.
    const scheduledTimer = setInterval(() => {
      markRun('scheduled_proposal_goals');
      try { const n = autonomousGoals.generateFromSelfImprovements(); if (n) console.log(`🎯 ${n} goal(s) from scheduled proposals`); }
      catch (err) { console.warn('Scheduled-proposal goals failed:', err instanceof Error ? err.message : String(err)); }
    }, Number(process.env.SCHEDULED_PROPOSAL_GOALS_INTERVAL_MS) || 3_600_000);
    scheduledTimer.unref?.();
    noteScheduler('scheduled_proposal_goals', '(always on with autonomy)', true, Number(process.env.SCHEDULED_PROPOSAL_GOALS_INTERVAL_MS) || 3_600_000);
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
