## Why

DjimFlo orchestrates loops (doc drift, self-improvement, GitHub issue) but each loop execution is an isolated episode. No system consumes loop outcomes to improve future loops. The OpenMythos governance audit identified this as the P0 gap separating "working system" from "cognitive platform."

The LoopService is the #1 bridge node (betweenness 0.0325) — every code path passes through it. Adding cognitive closure here maximizes leverage.

## What Changes

- **New**: `EpisodeService` — records loop execution traces as episodic memory (goal type, strategy, cost, outcome, duration)
- **New**: `StrategyService` — scores strategies by success rate and cost efficiency per goal type
- **New**: `CognitiveRuntimeService` — orchestrates episode recording and strategy selection
- **New**: `/api/cognitive/episodes` and `/api/cognitive/strategies` REST routes
- **New**: `CognitiveRuntimePage` dashboard — episodes list, strategy leaderboard, learning curve
- **Modified**: `LoopService` — emits episode records on loop completion
- **New**: Database tables `cognitive_episodes` and `cognitive_strategies`

## Non-Goals

- No autonomous strategy mutation without human approval
- No cross-agent memory sharing (separate initiative)
- No real-time streaming of cognitive events
- No ML-based strategy optimization (rule-based scoring only in v1)

## Success Criteria

- Every completed loop run produces an episode record
- Strategies are scored by success rate and average cost
- Dashboard shows episodes and strategy leaderboard
- LoopService emits episodes without breaking existing tests
- 15+ new integration tests for cognitive routes
- Full test suite + lint + type-check pass
