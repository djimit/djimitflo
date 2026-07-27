import { describe, it, expect } from 'vitest';

describe('registerGovernanceTools', () => {
  it('governance tools module exports registerGovernanceTools', async () => {
    const mod = await import('../../../mcp-server/src/tools/governance');
    expect(mod.registerGovernanceTools).toBeDefined();
    expect(typeof mod.registerGovernanceTools).toBe('function');
  });

  it('governance tools module exports registerOrchestrationTools', async () => {
    const mod = await import('../../../mcp-server/src/tools/orchestration');
    expect(mod.registerOrchestrationTools).toBeDefined();
    expect(typeof mod.registerOrchestrationTools).toBe('function');
  });
});
