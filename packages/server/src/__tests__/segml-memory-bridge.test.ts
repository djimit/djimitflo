import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SegmlMemoryBridge } from '../services/segml-memory-bridge';

describe('SegmlMemoryBridge', () => {
  let db: Database;
  let bridge: SegmlMemoryBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlMemoryBridge(db);
  });

  const sampleResults = [
    { caseId: 'c1', category: 'injection', difficulty: 3, response: 'Sure...', judgeScore: 1.5, judgeRationale: 'Failed', status: 'completed' as const },
    { caseId: 'c2', category: 'injection', difficulty: 2, response: 'No...', judgeScore: 4.0, judgeRationale: 'Passed', status: 'completed' as const },
    { caseId: 'c3', category: 'hallucination', difficulty: 3, response: 'Atlantis capital is...', judgeScore: 2.0, judgeRationale: 'Fabricated', status: 'completed' as const },
  ];

  it('creates failure memories for low-scoring cases', () => {
    const result = bridge.bridgeEvalToMemory('cycle-1', 'run-1', sampleResults, 2.5);
    expect(result.memories_created).toBe(3);
    expect(result.failure_memories.length).toBe(2);
    expect(result.success_memories.length).toBe(1);
  });

  it('creates success memories for high-scoring cases', () => {
    const result = bridge.bridgeEvalToMemory('cycle-1', 'run-1', sampleResults, 2.5);
    expect(result.success_memories.length).toBe(1);
  });

  it('consolidates repeated failures into patterns', () => {
    const results = [
      { caseId: 'c1', category: 'injection', difficulty: 3, response: 'fail', judgeScore: 1.0, judgeRationale: 'fail', status: 'completed' as const },
      { caseId: 'c2', category: 'injection', difficulty: 2, response: 'fail', judgeScore: 1.5, judgeRationale: 'fail', status: 'completed' as const },
      { caseId: 'c3', category: 'injection', difficulty: 3, response: 'fail', judgeScore: 2.0, judgeRationale: 'fail', status: 'completed' as const },
    ];
    const result = bridge.bridgeEvalToMemory('cycle-1', 'run-1', results, 2.5);
    expect(result.memories_created).toBe(3);
    expect(result.memories_consolidated).toBe(1);
  });

  it('skips non-completed cases', () => {
    const results = [
      { caseId: 'c1', category: 'injection', difficulty: 3, response: '', judgeScore: 0, judgeRationale: '', status: 'failed' as const },
    ];
    const result = bridge.bridgeEvalToMemory('cycle-1', 'run-1', results, 2.5);
    expect(result.memories_created).toBe(0);
  });

  it('retrieves failure memories by category', () => {
    bridge.bridgeEvalToMemory('cycle-1', 'run-1', sampleResults, 2.5);
    const failures = bridge.getFailureMemories('injection');
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].metadata.category).toBe('injection');
  });
});
