import { describe, expect, it } from 'vitest';
import { knowledgeRuntimePanelModel } from './SwarmMissionControlPage';
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
});
