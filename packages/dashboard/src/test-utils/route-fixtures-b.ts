import type { PageFixture } from './route-fixtures';

const AT = '2026-01-15T10:00:00.000Z';

const RESOURCES = { cpu_threads: 8, total_memory_bytes: 8589934592, free_memory_bytes: 4294967296, load_average: [0.5, 0.4, 0.3], uptime_seconds: 3600 };
const SWARM_STATUS = {
  registry_agent_count: 0, live_agent_count: 0, worker_lease_count: 0, active_execution_count: 0,
  task_count: { open_work_items: 0, open_loop_runs: 0, open_tasks: 0, total: 0 },
  backlog_count: {},
  stale_agents: [{ id: 'agent-fixture-1', name: 'fixture-stale-agent-alpha', status: 'idle', last_active_at: null }],
  resource_snapshot: RESOURCES,
  fleet_pools: [{
    runtime: 'fixture-runtime-alpha', available: true, prepared_leases: 0, queued_leases: 0, running_leases: 0, completed_24h: 0, failed_24h: 0,
    average_runtime_ms: null, failure_rate_24h: 0, tokens_used_24h: 0, tokens_per_successful_worker: null, tokens_per_diff_line: null,
    recommended_concurrency: 1, capacity_used_percent: 0, oldest_queued_age_ms: null, next_recommended_action: 'wait', bottleneck_reason: null,
    blocked_capacity_reasons: [], queue_depth_by_risk: {},
  }],
  fleet_topology: [],
  reality_check: { agent_count_is_registry_only: false, active_execution_requires_runtime_evidence: true },
};
const POOL_PLAN = { decisions: [], eligible_count: 0, blocked_count: 0, running_count: 0, max_workers: 1, capacity_snapshot: RESOURCES };
const LOOP_RUN = {
  id: 'run-fixture-1', goal_id: null, loop_name: 'fixture-loop-alpha', mode: 'closed', status: 'completed', repository_path: null, state_file: null,
  findings: [], plan: {}, gates: [], next_actions: [], metadata: {}, created_at: AT, updated_at: AT, completed_at: AT,
};

export const FIXTURES: Record<string, PageFixture> = {
  '/decisions': {
    primary: 'GET /api/self-improve/decisions',
    responses: {
      'GET /api/self-improve/decisions': {
        requeue: [],
        prescreen: { items: [], labelled: 0, wrong: 0, false_rejection_pct: null, enforce_threshold: '<= 10%' },
        telegram: [],
        memory: [{ id: 'mem-fixture-1', title: 'fixture-memory-rule-alpha', content: 'Synthetic rule body for the route smoke.', memory_type: 'rule', status: 'pending_review', created_at: AT }],
        autonomy: [],
        attribution_audit: {
          week_start: AT, seed: 'seed-fixture', size: 0, frame_n: 0,
          strata: { maker_failure: 0, reviewer_failure: 0, environment_failure: 0, verified: 0 },
          items: [], audited: { total: 0, correct: 0, wrong: 0, unclear: 0 }, note: '',
        },
      },
    },
    shows: 'fixture-memory-rule-alpha',
  },
  '/configuration': {
    primary: 'GET /api/health/config',
    responses: {
      'GET /api/health/config': {
        entries: [{ name: 'FIXTURE_ALPHA_SETTING', value: 'fixture-config-value-7731', masked: false, group: 'FIXTURE', area: 'other',
          source: 'env', default: null, overridden: null, takes_effect: 'restart' }],
        masked: 0,
        build: { commit: null, built_commit: null, build_source: null, build_time: null, instance_id: null, commit_matches_build: false },
      },
    },
    shows: 'fixture-config-value-7731',
  },
  '/fleet': {
    primary: 'GET /api/fleet-hosts',
    responses: {
      'GET /api/fleet-hosts': {
        hosts: [{ host: 'fixture-alpha-host', last_seen: AT, seconds_ago: 30, live: true, agent_version: '2', info: { os: 'linux', components: [] } }],
        commands: [],
      },
    },
    shows: 'fixture-alpha-host',
  },
  '/improvement-funnel': {
    primary: 'GET /api/self-improve/funnel',
    responses: {
      'GET /api/self-improve/funnel': {
        generatedAt: AT,
        proposals: { total: 4217, byStatus: {} },
        bySource: [],
        panel: { decisions: {}, goalRate: null, linkedPanels: 0, linkedDecided: 0, linkedDecisions: {} },
        refinement: { originals: null, children: null, childOutcomes: {}, childGoals: null },
        goals: { fromSelfImprovement: {} },
        learning: { cognitiveEpisodes: null, cognitivePatterns: null, cognitiveStrategies: null, learningClosures: null, memoryCandidates: {} },
        kpi: { windowDays: 7, verified: null, regressed: null, regressionRate: null, panels24h: null, panels7d: null, reviews24h: null, reviews7d: null,
          panelsPerVerified: null, medianHoursToVerified: null, approvalsPerRun: null },
        hygiene: { zombieGoals: null, staleRuns: null, blockedBoardItems: null },
        queues: { openWorkItems: null, workItemsByLoop: [], commonsReviews: {} },
      },
      'GET /api/self-improve/calibration': { specialists: [] },
    },
    shows: '4217',
  },
  '/authority': {
    primary: 'GET /api/authority/events',
    responses: {
      'GET /api/authority/stats': { total: 1, by_decision: [], recent_denials_and_holds: [] },
      'GET /api/authority/events': {
        events: [{ event_id: 'ev-fixture-1', correlation_id: 'corr-fixture-1', sequence: 1, occurred_at: AT, previous_state: null, requested_state: 'approved',
          policy_decision: 'ALLOW', actor_subject: 'fixture-actor-alpha', actor_type: 'agent', source_system: 'fixture-source' }],
        total: 1,
      },
    },
    shows: 'fixture-actor-alpha',
  },
  '/usage': {
    primary: 'GET /api/usage/accounts',
    responses: {
      'GET /api/usage/accounts': {
        generated_at: AT,
        window_starts: { '5h': AT, today: AT, '7d': AT, month: AT },
        sources: {},
        plan_limits: { source: 'fixture', entries: 0, invalid: 0, error: null },
        accounts: [{
          id: 'fixture-account', label: 'fixture-usage-account-alpha', scope: 'djimitflo_ledger',
          windows: {
            '5h': { calls: 0, tokens: 0, calls_without_tokens: 0 }, today: { calls: 0, tokens: 0, calls_without_tokens: 0 },
            '7d': { calls: 0, tokens: 0, calls_without_tokens: 0 }, month: { calls: 0, tokens: 0, calls_without_tokens: 0 },
          },
          lease_sessions: { '5h': 0, today: 0, '7d': 0, month: 0 },
          consumers_7d: [], providers_seen: [], last_error: null, last_limit_hit: null,
          state: { state: 'no_limit_recorded', since: null, until: null, reason: null },
          cost: { basis: 'metered', observed_bases: [], list_price_usd_month: null, calls_without_list_price_month: 0 },
          plan: 'fixture-plan', limits: [],
        }],
        note: 'Synthetic usage note.',
      },
    },
    shows: 'fixture-usage-account-alpha',
  },
  '/repositories': {
    primary: 'GET /api/repositories',
    responses: {
      'GET /api/repositories': {
        repositories: [{
          id: 'repo-fixture-1', name: 'fixture-repo-alpha', description: '', path: '/srv/fixture/repo-alpha',
          git_remote: null, git_branch: 'main', git_commit: null, is_active: true, last_synced_at: null,
          provider: 'local', status: 'clean', detected_stacks: [], package_manager: 'npm', test_commands: [], build_commands: [], lint_commands: [], typecheck_commands: [],
          has_git: true, has_agents_md: false, health_score: null, added_by: null, created_at: AT, updated_at: AT,
        }],
      },
    },
    shows: 'fixture-repo-alpha',
  },
  '/goals-loops': {
    primary: 'GET /api/loops/runs',
    responses: {
      'GET /api/goals': { goals: [] },
      'GET /api/loops/runs': { runs: [LOOP_RUN] },
      'GET /api/loops/catalog': { loops: [] },
      'GET /api/loops/runs/run-fixture-1/review-bundle': { run: LOOP_RUN, leases: [], events: [], state_content: null },
    },
    shows: 'fixture-loop-alpha',
  },
  '/fleet-cockpit': {
    primary: 'GET /api/swarms/status',
    responses: {
      'GET /api/swarms/status': SWARM_STATUS,
      'POST /api/swarms/worker-pool/plan': POOL_PLAN,
      'GET /api/loops/runtime-contracts': { runtimes: {} },
    },
    shows: 'fixture-runtime-alpha',
  },
  '/swarm-resources': {
    primary: 'GET /api/swarms/status',
    responses: {
      'GET /api/swarms/status': SWARM_STATUS,
      'GET /api/swarms/rsi/safety': { enabled: false, mutationsToday: 0, mutationsLimit: 0, lastMutation: null, frozenComponents: [], auditLogEntries: 0 },
      'GET /api/work-items': { work_items: [] },
      'GET /api/swarms/memory/candidates': { candidates: [] },
      'GET /api/swarms/specialists/catalog': { specialists: [] },
      'GET /api/swarms/specialist-panels': { panels: [] },
      'GET /api/swarms/assurance/summary': {
        trace_count: 0, trace_span_count: 0, checkpoint_count: 0, eval_run_count: 0, active_capability_count: 0, pending_capability_count: 0,
        reflection_review_required_count: 0, latest_evals: [], guardrails: { external_writes_from_evals: 0, replay_copies_worker_leases: false },
      },
    },
    shows: 'fixture-stale-agent-alpha',
  },
  '/swarm-mission-control': {
    primary: 'GET /api/swarms/intelligence/mission-control',
    responses: {
      'GET /api/swarms/intelligence/mission-control': {
        execution_node: { cockpit: 'fixture-host-a', workers_run_on: 'fixture-host-b', active_execution_requires_runtime_evidence: true },
        swarm_truth: { registry_agent_count: 0, live_agent_count: 0, prepared_leases: 0, running_leases: 0, active_execution_count: 0, registry_is_not_execution: true },
        capability_health: { total: 0, validated: 0, routable: 0, blocked: 0 },
        claim_health: { total: 0, proposed: 0, supported: 0, contradicted: 0, review_required: 0 },
        specialist_panels: { total: 0, consensus_ready: 0, blocked_or_needs_evidence: 0 },
        capacity: { ...POOL_PLAN, queue_classes: {}, fair_share_order: [], audit_manifest_preview: [] },
        latest_runner_manifests: [],
        latest_proof_run: null,
        next_safe_actions: [],
      },
    },
    shows: 'fixture-host-b',
  },
};
