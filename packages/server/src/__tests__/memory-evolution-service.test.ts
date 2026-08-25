import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { MemoryEvolutionService } from '../services/memory-evolution-service';

describe('MemoryEvolutionService', () => {
  it('ingests candidates, runs evolution, and measures cross-agent use', async () => {
    const db = createTestDb();
    try {
      const service = new MemoryEvolutionService(db);
      const candidate = service.ingest({
        agentId: 'agent-a',
        content: 'When a focused test passes, run the complete suite before completion.',
        metadata: { shared: 1 },
      });
      expect(candidate.id).toBeTruthy();
      expect(service.getCandidatesByScope('agent-b', 'shared')).toContain(candidate.id);
      expect(service.computeQualityScore(candidate.id).crossAgentUsage).toBe(0.2);
      await expect(service.evolve('evaluate')).resolves.toMatchObject({ loop: 'eval_gate' });
    } finally {
      db.close();
    }
  });
});
