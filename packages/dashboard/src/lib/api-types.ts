/**
 * API types for dashboard consumers.
 * Re-exported from api barrel for backward compatibility.
 * 
 * Task 1: Dashboard consumer migration
 */
export type { CatalogCounts, CatalogAgent, CatalogSearchResult } from './api/catalog';
export type { UsageQuota, UsageBreakdown, UsageLog, Task } from './api/evidence';
export type {
  GoalRecord, LoopRunRecord, LoopCatalogItem, RuntimeContract,
  LoopReviewBundle, WorkerLeaseRecord, LoopGate, LoopFinding, LoopEventRecord,
  GoalBatchPreviewResult, GoalBatchApplyResult, ExecuteWorkerResult,
} from './api/loops';
export type {
  SwarmRealityStatus, SchedulerTickResult, BacklogFleetSyncResult,
  KnowledgeRuntimeHealth, KnowledgeSyncResult, WorkerPoolPlanResult,
  WorkerPoolStartResult, WorkerPoolDrainResult, WorkerPoolStopResult, WorkerPoolDecision,
  WorkItemRecord, MemoryCandidateRecord, SpecialistProfile, SpecialistPanelRecord,
  WorkerRuntime, CheckerRuntime,
} from './api/swarm';
