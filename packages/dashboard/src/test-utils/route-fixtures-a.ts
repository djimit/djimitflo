import type { PageFixture } from './route-fixtures';

const AT = '2026-01-15T10:00:00.000Z';
const stamps = { created_at: AT, updated_at: AT };

const TASK = {
  ...stamps, id: 'fixture-task-1', title: 'fixture-alpha-task', description: 'Synthetic task for the route smoke',
  status: 'running', priority: 'medium', risk_level: 'low', execution_mode: 'dry_run', agent_id: 'fixture-agent-1',
  parent_task_id: null, repository_id: null, instruction_profile_id: null, started_at: AT, completed_at: null, failed_at: null,
  execution_time_ms: null, token_usage: null, created_by: 'u1', owner_user_id: 'u1', updated_by: null, tags: [], metadata: {},
};

const AGENT = {
  ...stamps, id: 'fixture-agent-1', name: 'fixture-alpha-agent', description: 'Synthetic agent for the route smoke',
  status: 'active', capabilities: ['code_review'], instruction_profile_id: null, model: null, temperature: null, max_tokens: null,
  total_tasks: 3, completed_tasks: 2, failed_tasks: 1, total_execution_time_ms: 0, total_token_usage: 0,
  current_task_id: null, last_active_at: AT, liveness: 'live', last_seen_at: AT, metadata: {},
};

const COCKPIT = {
  at: AT,
  build: { commit: null, build_time: null },
  scorecard: { verified_7d: 3, regressed_7d: 0 },
  guardrails: [{ name: 'fixture-guardrail-alpha', ok: true, value: 1, limit: '< 5' }],
  stalls: [], gym: [], remote_workers: [], genomes: [], maker_usage_7d: [], judgments_7d: [], deploys: [],
  needs_you: { approvals: 0, requeue: 0, labels: 0, memory_review: 0, total: 0 },
};

export const FIXTURES: Record<string, PageFixture> = {
  '/': {
    primary: 'GET /api/health/cockpit',
    responses: {
      'GET /api/health/cockpit': COCKPIT,
      'GET /api/health/services': { services: [] },
    },
    shows: 'fixture-guardrail-alpha',
  },
  '/dashboard': {
    primary: 'GET /api/tasks',
    responses: {
      'GET /api/tasks': { tasks: [TASK], total: 1 },
      'GET /api/agents': { agents: [AGENT] },
    },
    shows: 'Task: fixture-alpha-task',
  },
  '/tasks': {
    primary: 'GET /api/tasks',
    responses: {
      'GET /api/tasks': { tasks: [TASK], total: 1 },
      'GET /api/agents': { agents: [AGENT] },
    },
    shows: 'fixture-alpha-task',
  },
  '/agents': {
    primary: 'GET /api/agents',
    responses: {
      'GET /api/agents': { agents: [AGENT] },
      'GET /api/health/scorecards': { runtimes: [], agents: [] },
    },
    shows: 'fixture-alpha-agent',
  },
  '/catalog': {
    primary: 'GET /api/catalog/agents',
    responses: {
      'GET /api/catalog/counts': { imported: 1, evaluated: 1, active: 0, duplicate: 0, rejected: 0 },
      'GET /api/catalog/agents': { agents: [{ id: 'fixture-cat-1', name: 'fixture-catalog-agent', division: 'engineering', status: 'imported', evaluation: null, activation: null }] },
    },
    shows: 'fixture-catalog-agent',
  },
  '/swarm': {
    primary: 'GET /api/swarms/status',
    responses: {
      'GET /api/swarms/status': {
        registry_agent_count: 1, live_agent_count: 1, worker_lease_count: 0, active_execution_count: 0,
        task_count: { open_work_items: 0, open_loop_runs: 0, open_tasks: 0, total: 0 },
        backlog_count: {}, stale_agents: [],
        resource_snapshot: { cpu_threads: 8, total_memory_bytes: 16e9, free_memory_bytes: 8e9, load_average: [0.1, 0.1, 0.1], uptime_seconds: 3600 },
        fleet_pools: [{
          runtime: 'fixture-runtime-pool-a', available: true, prepared_leases: 0, queued_leases: 0, running_leases: 0,
          completed_24h: 0, failed_24h: 0, average_runtime_ms: null, failure_rate_24h: 0, tokens_used_24h: 0,
          tokens_per_successful_worker: null, tokens_per_diff_line: null, recommended_concurrency: 2, capacity_used_percent: 0,
          oldest_queued_age_ms: null, next_recommended_action: 'wait', bottleneck_reason: null, blocked_capacity_reasons: [], queue_depth_by_risk: {},
        }],
        fleet_topology: [],
      },
      'GET /api/swarms/intelligence/capabilities': { capabilities: [] },
      'GET /api/swarms/usage-window': { window_days: 7, events: 0, known_events: 0, total_tokens: null, coverage: null, status: 'UNKNOWN' },
      'GET /api/discussions': { discussions: [] },
      'GET /api/learning': { learnings: [] },
    },
    shows: 'fixture-runtime-pool-a',
  },
  '/policies': {
    primary: 'GET /api/policies',
    responses: {
      'GET /api/policies': { policies: [{
        ...stamps, id: 'fixture-policy-1', version: 1, name: 'fixture-policy-alpha', description: 'Synthetic policy for the route smoke',
        enabled: true, priority: 10, action_type: 'file_write', risk_level: 'medium', risk_levels: ['medium'], decision: 'require_approval',
        match_pattern: null, protected_paths: [], allowed_tools: [], blocked_tools: [], require_reason: false, metadata: {},
      }] },
    },
    shows: 'fixture-policy-alpha',
  },
  '/governance': {
    primary: 'GET /api/openmythos/leaderboard',
    responses: {
      'GET /api/openmythos/leaderboard': { leaderboard: [{
        agentId: 'fixture-gov-agent', overallScore: 4.25, categoryScores: { honesty: 4.5 }, totalCases: 12, lastEvalAt: AT, trend: 'stable', scale: '0-5',
      }] },
      'GET /api/openmythos/runs': { runs: [] },
    },
    shows: 'fixture-gov-agent',
  },
  '/mcp-permissions': {
    primary: 'GET /api/mcp/permissions',
    responses: {
      'GET /api/mcp/servers': { servers: [{
        ...stamps, id: 'fixture-mcp-1', name: 'fixture-mcp-server', description: 'Synthetic MCP server', status: 'stopped', command: '', args: [], env: {},
        version: null, author: null, url: null, last_ping_at: null, error_message: null, metadata: {},
      }] },
      'GET /api/mcp/permissions': { permissions: [{
        id: 'fixture-perm-1', server_id: 'fixture-mcp-1', server_name: 'fixture-mcp-server', tool_name: 'fixture-tool-alpha-read',
        decision: 'allow', risk_level: 'low', reason: 'Synthetic read-only tool',
      }] },
    },
    shows: 'fixture-tool-alpha-read',
  },
  '/observability': {
    primary: 'GET /api/observability/metrics',
    responses: {
      'GET /api/observability/metrics': {
        total_tasks: 4217, active_tasks: 1, completed_tasks: 4100, failed_tasks: 16, denied_tasks: 0, pending_approvals: 2, avg_duration_ms: 1500,
        risk_distribution: { low: 3, medium: 1, high: 0, critical: 0 }, policy_decisions: { allow: 3, deny: 0, require_approval: 1 },
        recent_errors: [{ task_id: 'fixture-task-err-1', message: 'fixture-observability-error', timestamp: AT }],
      },
    },
    shows: 'fixture-observability-error',
  },
  '/audit': {
    primary: 'GET /api/audit',
    responses: {
      'GET /api/audit': { events: [{
        ...stamps, id: 'fixture-audit-1', event_type: 'task.created', timestamp: AT, user_id: 'u1', agent_id: null, task_id: null,
        execution_event_id: null, action: 'fixture-audit-action', resource_type: 'task', resource_id: 'fixture-task-1', risk_level: 'low',
        before: null, after: null, metadata: {},
      }] },
    },
    shows: 'fixture-audit-action',
  },
};
