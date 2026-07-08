# Cognitive Runtime Specification

## Overview

The cognitive runtime closes the loop between loop execution and future loop strategy. It records episodes (what happened), extracts strategies (what worked), and selects strategies for new goals.

## Episode

An episode captures the outcome of a single loop execution.

```typescript
interface CognitiveEpisode {
  id: string;                    // UUID
  loop_run_id: string;           // FK to loop_runs.id
  goal_type: string;             // e.g. "doc-drift", "self-improvement", "github-issue"
  strategy: string;              // e.g. "maker-checker-v1", "single-pass", "deep-analysis"
  status: 'success' | 'failed' | 'partial';
  cost_dollars: number;          // Total token cost
  duration_ms: number;           // Wall-clock duration
  worker_count: number;          // Number of workers spawned
  approval_required: boolean;    // Whether human approval was needed
  metadata: Record<string, any>; // Flexible context (repo, branch, findings count, etc.)
  recorded_at: string;           // ISO timestamp
}
```

## Strategy

A strategy aggregates episodes to determine what works best for a goal type.

```typescript
interface CognitiveStrategy {
  id: string;                    // UUID
  goal_type: string;             // Matches episode goal_type
  strategy_name: string;         // Strategy identifier
  episode_count: number;         // Total episodes using this strategy
  success_count: number;         // Successful episodes
  success_rate: number;          // success_count / episode_count (0.0 - 1.0)
  avg_cost_dollars: number;      // Mean cost across episodes
  avg_duration_ms: number;       // Mean duration across episodes
  last_used_at: string;          // ISO timestamp of most recent use
  score: number;                 // Composite: success_rate * 0.7 + cost_efficiency * 0.3
  created_at: string;
  updated_at: string;
}
```

## Strategy Selection

When a new loop starts for a goal type:

1. Query strategies for that `goal_type` ordered by `score` DESC
2. If a strategy exists with `success_rate >= 0.7` and `episode_count >= 3`, pre-select it
3. Otherwise, default to `"maker-checker-v1"`
4. Store the selected strategy in the loop run metadata

## Scoring Algorithm

```
score = (success_rate * 0.7) + (cost_efficiency * 0.3)

where cost_efficiency = clamp(1.0 - (avg_cost / max_cost_baseline), 0.0, 1.0)
and max_cost_baseline = 5.00 (USD)
```

## API Endpoints

### GET /api/cognitive/episodes
Query episodes with filters: `goal_type`, `strategy`, `status`, `limit`, `offset`.

### GET /api/cognitive/episodes/:id
Get single episode by ID.

### GET /api/cognitive/strategies
List all strategies ordered by score DESC. Filter by `goal_type`.

### GET /api/cognitive/strategies/:id
Get single strategy by ID.

### GET /api/cognitive/leaderboard
Top strategies per goal type (for dashboard).

### POST /api/cognitive/episodes/recompute
Recompute all strategy scores from episode data (admin only).

## Database Schema

```sql
CREATE TABLE cognitive_episodes (
  id TEXT PRIMARY KEY,
  loop_run_id TEXT NOT NULL,
  goal_type TEXT NOT NULL,
  strategy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'success',
  cost_dollars REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  worker_count INTEGER NOT NULL DEFAULT 0,
  approval_required INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_episodes_goal_type ON cognitive_episodes(goal_type);
CREATE INDEX idx_episodes_strategy ON cognitive_episodes(strategy);
CREATE INDEX idx_episodes_recorded_at ON cognitive_episodes(recorded_at);

CREATE TABLE cognitive_strategies (
  id TEXT PRIMARY KEY,
  goal_type TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  episode_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  success_rate REAL NOT NULL DEFAULT 0,
  avg_cost_dollars REAL NOT NULL DEFAULT 0,
  avg_duration_ms REAL NOT NULL DEFAULT 0,
  last_used_at TEXT,
  score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(goal_type, strategy_name)
);

CREATE INDEX idx_strategies_goal_type ON cognitive_strategies(goal_type);
CREATE INDEX idx_strategies_score ON cognitive_strategies(score DESC);
```
