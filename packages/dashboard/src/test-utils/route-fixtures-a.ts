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
