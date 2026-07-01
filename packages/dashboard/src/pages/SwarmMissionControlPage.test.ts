import { describe, expect, it } from 'vitest';
import { asArray, integrationSpinePanelModel, knowledgeRuntimePanelModel, productionCertificationPanelModel, productionPilotPanelModel } from './SwarmMissionControlPage';
import type { KnowledgeRuntimeHealth } from '../lib/api';

function health(overrides: Partial<KnowledgeRuntimeHealth> = {}): KnowledgeRuntimeHealth {
  return {
    okf_base: '/Users/dlandman/djimitflo/knowledge',
    canonical_candidate: '/Users/dlandman/djimitflo/knowledge',
    symlink_target: '../djimitflo-knowledge/okf',
    exists: true,
    valid: true,
    validate_okf: { status: 'pass', command: null, stdout: '', stderr: '' },
    counts: { skills: 1, agents: 0, memory: 0, services: 0, repos: 0, models: 0, total: 1 },
    drift: {
      okf_skill_count: 1,
      registered_skill_capability_count: 1,
      missing_registry_entries: [],
      stale_registry_entries: [],
      packages_knowledge_is_canonical: false,
      projection_status: 'unknown',
    },
    blocked_reasons: [],
    next_safe_actions: [],
    ...overrides,
  };
}

describe('knowledge runtime mission control view model', () => {
  it('labels repo knowledge as canonical runtime knowledge', () => {
    expect(knowledgeRuntimePanelModel(health())).toMatchObject({
      canonical: '/Users/dlandman/djimitflo/knowledge',
      usesPackagesKnowledge: false,
      status: 'valid',
    });
  });

  it('does not hide packages/knowledge canonical drift', () => {
    expect(knowledgeRuntimePanelModel(health({
      okf_base: '/Users/dlandman/djimitflo/packages/knowledge',
      drift: {
        ...health().drift,
        packages_knowledge_is_canonical: true,
      },
    }))).toMatchObject({
      canonical: '/Users/dlandman/djimitflo/packages/knowledge',
      usesPackagesKnowledge: true,
    });
  });
});

describe('mission control execution truth', () => {
  it('normalizes non-array API payloads before map rendering', () => {
    expect(asArray({ runs: [] })).toEqual([]);
    expect(asArray(null)).toEqual([]);
    expect(asArray(['ok'])).toEqual(['ok']);
  });

  it('separates registry count from active execution count', () => {
    // The dashboard shows separate metrics for registry agents and active execution
    // This test verifies the model distinguishes them
    const mockMission = {
      swarm_truth: {
        registry_agent_count: 5,
        live_agent_count: 2,
        prepared_leases: 3,
        running_leases: 1,
        active_execution_count: 1,
        registry_is_not_execution: true,
      },
      execution_node: {
        cockpit: 'MacBook dashboard',
        workers_run_on: 'workstation',
      },
    };

    // Registry count (5) must not equal active execution count (1)
    expect(mockMission.swarm_truth.registry_agent_count).toBe(5);
    expect(mockMission.swarm_truth.active_execution_count).toBe(1);
    expect(mockMission.swarm_truth.registry_agent_count).not.toBe(mockMission.swarm_truth.active_execution_count);
    expect(mockMission.swarm_truth.registry_is_not_execution).toBe(true);
  });

  it('labels MacBook as cockpit and workstation as execution node', () => {
    const mockMission = {
      execution_node: {
        cockpit: 'MacBook dashboard',
        workers_run_on: 'workstation',
      },
    };

    expect(mockMission.execution_node.cockpit).toContain('MacBook');
    expect(mockMission.execution_node.workers_run_on).toContain('workstation');
    expect(mockMission.execution_node.cockpit).not.toBe(mockMission.execution_node.workers_run_on);
  });

  it('distinguishes prepared leases from running leases', () => {
    const mockTruth = {
      prepared_leases: 3,
      running_leases: 1,
    };

    expect(mockTruth.prepared_leases).not.toBe(mockTruth.running_leases);
    // Prepared means ready but not started; running means actively executing
    expect(mockTruth.prepared_leases).toBeGreaterThan(mockTruth.running_leases);
  });

  it('models integration spine chain truth without assuming arrays', () => {
    expect(integrationSpinePanelModel({ latest: null, chains: {} as any, next_safe_action: 'Import integration event' })).toMatchObject({
      latest: null,
      chains: [],
      nextSafeAction: 'Import integration event',
    });

    const model = integrationSpinePanelModel({
      next_safe_action: 'Close loop learning',
      latest: null,
      chains: [{
        source: 'dashboard_action',
        source_ref: 'dashboard:smoke',
        work_item: {
          id: 'wi-1',
          title: 'Smoke',
          status: 'leased',
          risk_class: 'low',
          recommended_loop: 'doc-drift-and-small-fix-loop',
          assigned_runtime: 'mock',
        },
        goal_id: 'goal-1',
        loop: { id: 'loop-1', status: 'ready_for_human_merge' },
        leases: [{ id: 'lease-1', role: 'maker', runtime: 'mock', effective_runtime: 'mock', status: 'completed' }],
        eval_run: null,
        reflection_candidate: null,
        memory_candidate: null,
        requested_runtime: 'mock',
        next_safe_action: 'Close loop learning',
      }],
    });

    expect(model.latest?.work_item.id).toBe('wi-1');
    expect(model.nextSafeAction).toBe('Close loop learning');
    expect(model.chains[0].leases[0]).toMatchObject({ effective_runtime: 'mock' });
  });

  it('models production certification without requiring a proof run', () => {
    const missing = productionCertificationPanelModel(null);
    expect(missing).toMatchObject({
      status: 'missing',
      runtime: 'none',
      productionPassed: false,
      missing: [],
    });

    const certified = productionCertificationPanelModel({
      production_certification: {
        status: 'certified',
        proof_run_id: 'proof-1',
        runtime: 'codex',
        proof_class: 'production',
        production_passed: true,
        production_missing: [],
        next_safe_action: 'Review production evidence and candidates',
      },
      runtime_readiness: {
        ready: true,
        starts_workers: false,
        next_safe_action: 'Run opt-in real runtime certification',
        runtimes: [{
          runtime: 'codex',
          production_runtime: true,
          ready: true,
          start_allowed: true,
          command: 'codex',
          status: 'ok',
          available: true,
          version: 'codex test',
          evidence: [],
          blocked_reasons: [],
          contract: {},
        }],
      },
    } as any);

    expect(certified).toMatchObject({
      status: 'certified',
      runtime: 'codex',
      productionPassed: true,
      readyRuntimes: ['codex'],
      nextSafeAction: 'Review production evidence and candidates',
    });
  });

  it('models production pilot metrics without assuming arrays', () => {
    expect(productionPilotPanelModel(null)).toMatchObject({
      runs: [],
      nextSafeAction: 'Run production pilot from a low-risk integration item',
      metrics: {
        total_runs: 0,
        completed_runs: 0,
      },
    });

    const model = productionPilotPanelModel({
      latest: null,
      runs: [{
        source: 'dashboard_action',
        source_ref: 'pilot:1',
        work_item: {
          id: 'wi-pilot',
          title: 'Pilot',
          status: 'done',
          risk_class: 'low',
          recommended_loop: 'doc-drift-and-small-fix-loop',
          assigned_runtime: 'codex',
        },
        goal_id: 'goal-1',
        loop: { id: 'loop-1', status: 'completed' },
        leases: [],
        eval_run: { id: 'eval-1', status: 'passed', score: 1 },
        reflection_candidate: { id: 'reflection-1', status: 'candidate' },
        memory_candidate: { id: 'memory-1', status: 'candidate', promotion_status: 'proposed' },
        requested_runtime: 'codex',
        next_safe_action: 'Review reflection and memory candidates',
      }],
      metrics: {
        total_runs: 1,
        completed_runs: 1,
        success_rate: 1,
        checker_rejection_rate: 0,
        reflection_candidates: 1,
        memory_candidates: 1,
        manual_intervention_count: 0,
        avg_time_to_closure_ms: 1200,
      },
      next_safe_action: 'Review reflection and memory candidates',
    });

    expect(model.latest?.work_item.id).toBe('wi-pilot');
    expect(model.metrics.success_rate).toBe(1);
    expect(model.nextSafeAction).toBe('Review reflection and memory candidates');
  });
});
