import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { MemoryEvolutionService } from '../services/memory-evolution-service';

describe('MemoryEvolutionService', () => {
  it('ingests candidates, schedules evolution, and measures cross-agent use', () => {
    const db = createTestDb();
    try {
      const service = new MemoryEvolutionService(db);
      const candidate = service.ingestTrace({
        agentId: 'agent-a',
        content: 'When a focused test passes, run the complete suite before completion.',
        metadata: { shared: 1 },
      });
      expect(candidate.id).toBeTruthy();
      expect(service.getCandidatesByScope('agent-a', 'all')).toContain(candidate.id);
      // Fresh trace with no cross-agent access yet → 0 usage (saturates at 2 consumers)
      expect(service.computeQualityScore(candidate.id).crossAgentUsage).toBe(0);
      const goals = service.scheduleEvolution('evaluate', [candidate.id]);
      expect(goals.length).toBe(1);
      expect(goals[0]).toHaveProperty('objective');
    } finally {
      db.close();
    }
  });
});