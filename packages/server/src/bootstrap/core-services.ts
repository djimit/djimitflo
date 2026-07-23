/**
 * Core services (always initialized regardless of runtime profile).
 * Extracted from index.ts for separation of concerns.
 */
import { AuthService } from '../services/auth-service';
import { createAuthMiddleware } from '../middleware/auth';
import { WebSocketService } from '../services/websocket-service';
import { ExecutionEngine } from '../execution/execution-engine';
import { MemorySyncService } from '../services/memory-sync-service';
import { ReasoningBankService } from '../services/reasoning-bank-service';
import { VectorMemoryService } from '../services/vector-memory-service';
import { TrajectoryStore } from '../services/trajectory-store';
import { RetentionService } from '../services/retention-service';
import { CognitiveLoopClosureService } from '../services/cognitive-loop-closure-service';
import { MultiModelIntelligence } from '../services/multi-model-intelligence';
import { MetaOrchestrationService } from '../services/meta-orchestration-service';
import { SelfModificationPipeline } from '../services/self-modification-pipeline';
import { ProactiveMemoryService } from '../services/proactive-memory-service';
import { ComplianceAuditService } from '../services/compliance-audit-service';
import { lifecycleManager } from '../services/lifecycle-manager';
import type { WebSocketServer } from 'ws';

export interface CoreServices {
  authService: AuthService;
  auth: ReturnType<typeof createAuthMiddleware>;
  wsService: WebSocketService;
  executionEngine: ExecutionEngine;
  metaOrchestration?: MetaOrchestrationService;
}

export function initCoreServices(
  db: any,
  _app: import('express').Express,
  wss: WebSocketServer,
  autonomousRuntime: boolean,
  operatorRuntime: boolean,
): CoreServices {
  // Auth
  const authService = new AuthService(db);
  authService.bootstrapAdmin();
  const auth = createAuthMiddleware(authService);
  console.log('🔐 Authentication initialized');

  // WebSocket
  const wsService = new WebSocketService(wss, authService, db);
  console.log('🔌 WebSocket server initialized (authenticated)');

  // Execution engine
  const executionEngine = new ExecutionEngine(db, wsService);
  console.log('⚙️  Execution engine initialized');

  // Learning subsystems
  const memorySync = new MemorySyncService(db);
  executionEngine.setMemorySyncService(memorySync);

  const reasoningBank = new ReasoningBankService(db);
  executionEngine.setReasoningBankService(reasoningBank);

  const vectorMemory = new VectorMemoryService(db);
  reasoningBank.setVectorMemory(vectorMemory);

  const trajectoryStore = new TrajectoryStore(db);
  executionEngine.setTrajectoryStore(trajectoryStore);

  // Operator-only services
  if (operatorRuntime) {
    const retention = new RetentionService(db);
    retention.start();
    lifecycleManager.register({ serviceName: 'RetentionService', stop: () => (retention as any)?.stop?.() });

    const cognitiveLoopClosure = new CognitiveLoopClosureService(db);
    cognitiveLoopClosure.start();
    lifecycleManager.register({ serviceName: 'CognitiveLoopClosure', stop: () => (cognitiveLoopClosure as any)?.stop?.() });
  }

  // Multi-model intelligence
  const multiModelIntelligence = new MultiModelIntelligence(db);
  if (multiModelIntelligence.getStatus().totalModels === 0) {
    multiModelIntelligence.registerModel({ modelId: 'workstation-litellm/coding', modelName: 'LiteLLM Coding', provider: 'litellm', costPerMtok: 1.0 });
    multiModelIntelligence.registerModel({ modelId: 'ollama-qwen25-14b', modelName: 'Qwen2.5 14B', provider: 'ollama', costPerMtok: 0 });
  }

  // Autonomous-only services
  let metaOrchestration: MetaOrchestrationService | undefined;
  if (autonomousRuntime) {
    metaOrchestration = new MetaOrchestrationService(db);
    metaOrchestration.start();
    lifecycleManager.register({ serviceName: 'MetaOrchestration', stop: () => (metaOrchestration as any)?.stop?.() });
    executionEngine.setMetaOrchestration(metaOrchestration);

    const selfModification = new SelfModificationPipeline(db);
    selfModification.analyze();
  }

  // Startup side-effects
  new ProactiveMemoryService(db);
  new ComplianceAuditService(db);

  return { authService, auth, wsService, executionEngine, metaOrchestration };
}
