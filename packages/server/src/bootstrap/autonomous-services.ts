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
