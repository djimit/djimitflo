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
import { ExplainerFleetWorker } from '../services/explainer-fleet-worker';
import { TrajectoryStore } from '../services/trajectory-store';
import { CuriosityService } from '../services/curiosity-service';
import { BoardHandoffService } from '../services/board-handoff-service';

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
      if (generated.total > 0) console.log(`🎯 Autonomous goals generated: ${generated.total} (${generated.improvements} improvements, ${generated.security} security, ${generated.curiosity} curiosity)`);
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

  // ExplainerFleetWorker — autonomous repo-explainer pipeline tick (SC-007 auto-refresh).
  // Default ON; disable with DJIMITFLO_EXPLAINER_AUTONOMY=false. Respects scheduler pause (kill-switch).
  try {
    if (process.env.DJIMITFLO_EXPLAINER_AUTONOMY === 'false') {
      console.log('ℹ️  Explainer fleet autonomy disabled via DJIMITFLO_EXPLAINER_AUTONOMY=false');
    } else {
      const fleetWorker = ExplainerFleetWorker.create(db);
      fleetWorker.start();
      lifecycleManager.register({ serviceName: 'ExplainerFleetWorker', stop: () => fleetWorker.stop() });
      console.log('📖 Explainer fleet worker started (30s tick, honors kill-switch).');
    }
  } catch (error) {
    console.warn('⚠️  Explainer fleet worker failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }
}
