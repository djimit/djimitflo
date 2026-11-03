## ADDED Requirements

### Requirement: WorktreeManager is extracted from LoopService
Git and worktree operations MUST be in a dedicated WorktreeManager service.

#### Scenario: Worktree creation delegates to WorktreeManager
- **WHEN** LoopService.createWorktree is called
- **THEN** it delegates to WorktreeManager.createWorktree

#### Scenario: All existing tests pass after extraction
- **WHEN** decomposition is complete
- **THEN** all 1174+ existing tests pass without modification

### Requirement: GoalService is extracted from LoopService
Goal CRUD operations MUST be in a dedicated GoalService.

#### Scenario: Goal creation delegates to GoalService
- **WHEN** LoopService.createGoal is called
- **THEN** it delegates to GoalService.create
