## ADDED Requirements

### Requirement: createSwarmRoutes is split into domain factories
The monolithic route factory MUST be split into worker, intelligence, and governance factories.

#### Scenario: Worker routes are in createWorkerRoutes
- **WHEN** the server starts
- **THEN** worker/spawn routes are registered from createWorkerRoutes

#### Scenario: All existing API endpoints work identically
- **WHEN** any existing API endpoint is called
- **THEN** the response is identical to pre-decomposition
