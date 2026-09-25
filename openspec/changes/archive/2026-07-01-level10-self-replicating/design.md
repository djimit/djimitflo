# Design — Level-10 Self-Hosting + Multi-Domein

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DjimFlo Level-10 Architecture                         │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Self-Hosting Layer (G69-G72)                   │   │
│  │  SelfRepository → SelfBuild → SelfImprove → SelfDeploy          │   │
│  │       ↕              ↕             ↕             ↕               │   │
│  │  Autobiographical Memory ←→ Reflection Engine ←→ Causal Model   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕             ↕             ↕                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Multi-Domein Layer (G73-G74)                  │   │
│  │  Code    Infrastructure    Data    Communication    Research     │   │
│  │  Executor   Executor      Executor   Executor      Executor     │   │
│  │    ↕          ↕             ↕          ↕            ↕          │   │
│  │  Domain Models ←→ Transfer Learning ←→ Unified World Model      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│       ↕              ↕             ↕             ↕                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Orchestration Layer (G77-G78)                 │   │
│  │  UnifiedWorldModel ←→ DomainAdaptiveCurriculum ←→ GOAP Planner  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

## G69: Self-Repository Detection

### File: `packages/server/src/services/self-repository-service.ts`

```typescript
interface SelfRepositoryInfo {
  isSelfHosted: boolean;
  remoteUrl: string;
  branch: string;
  commitSha: string;
  lastCommitDate: string;
  hasUncommittedChanges: boolean;
  rootPath: string;
}

class SelfRepositoryService {
  detectSelfRepository(): SelfRepositoryInfo
  registerSelfRepository(): { registered: boolean; id: string }
  getSelfRepository(): RepoRow | null
  updateCommitTracking(): void
  getDiff(): string
  getRecentCommits(limit: number): Array<{ sha; message; date; author }>
}
```

## G70: Self-Build Pipeline

### File: `packages/server/src/services/self-build-service.ts`

```typescript
interface BuildResult {
  success: boolean;
  command: string;
  output: string;
  errors: string[];
  warnings: string[];
  durationMs: number;
  timestamp: string;
}

class SelfBuildService {
  runBuild(command: string): Promise<BuildResult>
  runTests(): Promise<BuildResult>
  runTypeCheck(): Promise<BuildResult>
  runLint(): Promise<BuildResult>
  getBuildHistory(limit: number): BuildResult[]
  getLastError(): string[]
}
```

## G71: Self-Improvement Loop

### File: `packages/server/src/services/self-improvement-service.ts`

```typescript
interface ImprovementProposal {
  id: string;
  type: 'bug_fix' | 'feature' | 'refactor' | 'performance' | 'security';
  title: string;
  description: string;
  rationale: string;
  source: 'reflection' | 'invention' | 'gap_analysis' | 'feedback';
  status: 'proposed' | 'approved' | 'in_progress' | 'completed' | 'rejected';
  priority: number;
}

class SelfImprovementService {
  generateFromReflection(reflection): ImprovementProposal[]
  generateFromGaps(gaps): ImprovementProposal[]
  generateFromBuildErrors(errors): ImprovementProposal[]
  getProposedImprovements(): ImprovementProposal[]
  approveImprovement(id: string): void
  completeImprovement(id: string): void
  rejectImprovement(id: string): void
}
```

## G72: Self-Deployment

### File: `packages/server/src/services/self-deploy-service.ts`

```typescript
interface DeployResult {
  success: boolean;
  commitSha: string;
  message: string;
  timestamp: string;
  rolledBack: boolean;
}

class SelfDeployService {
  commitChanges(message: string): { success: boolean; sha: string }
  pushToRemote(): { success: boolean; output: string }
  rollback(commitSha: string): { success: boolean }
  deploy(message: string): DeployResult
  getDeployHistory(limit: number): DeployResult[]
}
```

## G73: Infrastructure Executor

### File: `packages/server/src/execution/executors/infrastructure-executor.ts`

```typescript
interface InfrastructureTask {
  type: 'docker' | 'kubernetes' | 'ansible' | 'terraform';
  action: string;
  target: string;
  config?: Record<string, unknown>;
}

class InfrastructureExecutor {
  canExecute(runtime: string): boolean
  execute(task: InfrastructureTask): Promise<InfrastructureResult>
  healthCheck(target: string): Promise<{ healthy: boolean; details: string }>
}
```

## G74: Data Executor

### File: `packages/server/src/execution/executors/data-executor.ts`

```typescript
interface DataTask {
  type: 'sql' | 'python' | 'dbt' | 'csv' | 'json';
  action: string;
  target: string;
  query?: string;
}

class DataExecutor {
  canExecute(runtime: string): boolean
  execute(task: DataTask): Promise<DataResult>
  validateDataIntegrity(target, schema): Promise<{ valid: boolean; issues: string[] }>
}
```

## G77: Unified World Model

### File: `packages/server/src/services/unified-world-model-service.ts`

```typescript
interface CrossDomainQuery {
  sourceDomain: string;
  targetDomain: string;
  intervention: Record<string, string>;
  predictedOutcome: string;
  confidence: number;
}

class UnifiedWorldModelService {
  learnDomainRelation(source, target, relation, strength): void
  crossDomainQuery(source, target, intervention): CrossDomainQuery
  getDomainRelations(domain): DomainEdgeRow[]
  getAllDomains(): string[]
}
```

## G78: Domain-Adaptive Curriculum

### File: `packages/server/src/services/domain-adaptive-curriculum-service.ts`

```typescript
interface DomainCurriculum {
  domain: string;
  steps: Array<{
    objective: string;
    difficulty: number;
    prerequisites: string[];
    status: 'locked' | 'available' | 'completed';
  }>;
}

class DomainAdaptiveCurriculumService {
  detectDomain(description: string): string
  generateCurriculum(domain: string): DomainCurriculum
  getDomainSteps(domain: string): DomainCurriculum['steps']
}
```
