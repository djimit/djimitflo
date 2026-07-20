/**
 * CognitivePlatformOrchestrator — unified cognitive loop connecting all subsystems.
 *
 * This is the "brain" of DjimFlo. It connects:
 *   Loop Execution → Episode Recording → Pattern Extraction → Strategy Evolution
 *       ↕                    ↕                    ↕
 *   Runtime Governance ←→ Proactive Memory ←→ Fleet Mesh
 *       ↕                    ↕                    ↕
 *   Compliance Audit ←→ Self-Modification ←→ Red Team
 *
 * The orchestrator runs a continuous cognitive cycle:
 * 1. Observe — Collect events from all subsystems
 * 2. Learn — Extract patterns from observations
 * 3. Plan — Select optimal strategies based on learned patterns
 * 4. Act — Apply strategies to loop execution
 * 5. Verify — Check outcomes against expectations
 * 6. Archive — Store episode for future learning
 */

import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
interface CognitiveCycleResult {
  cycleId: string;
  timestamp: string;
  observations: number;
  patternsExtracted: number;
  strategiesEvolved: number;
  memoryMaintenance: { promoted: number; archived: number; decayed: number; evaluated: number };
}

import { CognitiveLoopClosureService } from './cognitive-loop-closure-service';
import { ProactiveMemoryService } from './proactive-memory-service';
import { RuntimeGovernanceService } from './runtime-governance-service';
import { FleetMeshService } from './fleet-mesh-service';
import { ComplianceAuditService } from './compliance-audit-service';
import { AgentRetirementService } from './agent-retirement-service';
import { AdversarialRedTeamService } from './adversarial-red-team-service';
import { MultiModelIntelligence } from './multi-model-intelligence';
import { SegmlCpoBridge } from './segml-cpo-bridge';
import { SegmlRuntimeGovernanceBridge } from './segml-runtime-governance-bridge';
import { SegmlRedTeamBridge } from './segml-red-team-bridge';
import { SegmlPsychometryBridge } from './segml-psychometry-bridge';

export class CognitivePlatformOrchestrator {
   cognitive: CognitiveLoopClosureService;
   memory: ProactiveMemoryService;
   governance: RuntimeGovernanceService;
   fleet: FleetMeshService;
   compliance: ComplianceAuditService;
   retirement: AgentRetirementService;
   redTeam: AdversarialRedTeamService;
   models: MultiModelIntelligence;
   segml: SegmlCpoBridge;
   segmlRuntime: SegmlRuntimeGovernanceBridge;
   segmlRedTeam: SegmlRedTeamBridge;
   segmlPsychometry: SegmlPsychometryBridge;

   private started = false;

  constructor(db: Database) {
    this.cognitive = new CognitiveLoopClosureService(db);
    this.memory = new ProactiveMemoryService(db);
    this.governance = new RuntimeGovernanceService(db);
    this.fleet = new FleetMeshService(db);
    this.compliance = new ComplianceAuditService(db);
    this.retirement = new AgentRetirementService(db);
     this.redTeam = new AdversarialRedTeamService(db);
     this.models = new MultiModelIntelligence(db);
     this.segml = new SegmlCpoBridge(db);
     this.segmlRuntime = new SegmlRuntimeGovernanceBridge(db);
     this.segmlRedTeam = new SegmlRedTeamBridge(db);
     this.segmlPsychometry = new SegmlPsychometryBridge(db);
   }

  /**
   * Start the cognitive platform — all subsystems.
   */
  start(): void {
    if (this.started) return;

    this.cognitive.start();
    this.governance.start();
    this.fleet.startHeartbeat();

    this.started = true;
  }

  /**
   * Stop all subsystems.
   */
  stop(): void {
    this.cognitive.stop();
    this.governance.stop();
    this.fleet.stopHeartbeat();
    this.started = false;
  }

  /**
   * Get unified platform status.
   */
  getPlatformStatus(): Record<string, unknown> {
    return {
      cognitive: this.cognitive.getStats(),
      memory: this.memory.getStats(),
      governance: this.governance.getStatus(),
      fleet: this.fleet.getStatus(),
      compliance: this.compliance.getStatus(),
      models: this.models.getStatus(),
      redTeam: this.redTeam.getLatestReport(),
    };
  }

  /**
   * Run a full cognitive cycle (observe → learn → plan → act → verify → archive).
   */
  async runCognitiveCycle(agentIds: string[] = []): Promise<CognitiveCycleResult & {
     segmlResults: Array<{ agentId: string; status: string; blindSpots: string[]; scoreDelta: number }>;
   }> {
     const cycleId = randomUUID();
     const timestamp = new Date().toISOString();

     // 1. Observe — collect pending observations
     const observations = this.cognitive.getStats().totalEpisodes;

     // 2. Learn — extract patterns from recent episodes + SEGML governance learning
     const patterns = this.cognitive.extractPatterns();
     const segmlResults = await this.segml.runFleetSegmlPhase(agentIds);

     // 3. Plan — evolve strategies based on patterns + SEGML blind spots
     const strategies = this.cognitive.evolveStrategies();

     // 4. Memory maintenance — promote/archive/decay
     const memoryResult = this.memory.runMaintenanceCycle();

     // 5. Compliance check — verify audit chain integrity
     const chainIntegrity = this.compliance.verifyChain();

     // 6. Archive — log the cycle itself
     this.compliance.appendEntry({
       actor: 'cognitive_orchestrator',
       action: 'cognitive_cycle_complete',
       resource: cycleId,
       outcome: chainIntegrity.valid ? 'success' : 'failure',
       evidence: {
         observations,
         patternsExtracted: patterns.length,
         strategiesEvolved: strategies.length,
         memoryMaintenance: memoryResult,
         segmlCycles: segmlResults.length,
         segmlBlindSpots: segmlResults.flatMap(r => r.blindSpots),
       },
     });

     return {
       cycleId,
       timestamp,
       observations,
       patternsExtracted: patterns.length,
       strategiesEvolved: strategies.length,
       memoryMaintenance: memoryResult,
       segmlResults: segmlResults.map(r => ({
         agentId: r.agentId,
         status: r.status,
         blindSpots: r.blindSpots.map(b => b.category),
         scoreDelta: r.scoreDelta,
       })),
     };
   }
}
