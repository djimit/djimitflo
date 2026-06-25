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
