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
import { ContinuousLearningLoop } from '../services/continuous-learning-loop';

export function initAutonomousServices(db: any, recoverySvc: LoopService): void {
  const intelligence = new SwarmIntelligenceService(db);
  const nestedSpawns = new NestedSpawnService(db, recoverySvc, { intelligence, controlUrl: process.env.DJIMITFLO_CONTROL_URL || '' });

  try {
    const learning = new ContinuousLearningLoop(db);
    learning.start();
    lifecycleManager.register({ serviceName: 'ContinuousLearningLoop', stop: () => learning.stop() });
    console.log('📚 Continuous learning loop started (persistent evidence watermark).');
  } catch (error) {
    console.warn('⚠️  Continuous learning loop failed to start (non-fatal):', error instanceof Error ? error.message : String(error));
  }

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
    const generated = autonomousGoals.generateAll();
    if (generated.total > 0) {
      console.log(`🎯 Autonomous goals generated: ${generated.total} (${generated.improvements} improvements, ${generated.security} security, ${generated.curiosity} curiosity)`);
    }
  } catch (error) {
    console.warn('⚠️  Autonomous goal generation failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }

}
