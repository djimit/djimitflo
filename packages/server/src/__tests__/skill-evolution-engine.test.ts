import { afterEach, expect, it } from 'vitest';
import { createTestDb } from './helpers/test-db';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';

const db = createTestDb();
afterEach(() => db.close());

it('keeps unknown usage unknown and deduplicates outcome credit by execution attempt', () => {
  db.prepare(`INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain)
    VALUES ('historic', 'skill', 1, 0, 1, 'legacy')`).run();
  const engine = new SkillEvolutionEngine(db);
  engine.recordDelivery({ taskId: 'task', attemptId: 'attempt', skillId: 'skill', skillVersion: '1.0.0', skillContentHash: 'a'.repeat(64), runtime: 'mock' });
  const input = {
    success: true, tokensUsed: null, durationMs: 10, domain: 'test', taskId: 'task',
    skillVersion: '1.0.0', skillContentHash: 'a'.repeat(64), attemptId: 'attempt',
  };
  engine.recordOutcome('skill', input);
  engine.recordOutcome('skill', input);

  expect(db.prepare('SELECT COUNT(*) AS count, MIN(tokens_used) AS tokens FROM skill_outcomes WHERE attempt_id = ?').get('attempt'))
    .toEqual({ count: 1, tokens: null });
  expect(db.prepare('SELECT COUNT(*) AS count FROM skill_delivery_receipts WHERE attempt_id = ?').get('attempt'))
    .toEqual({ count: 1 });
  expect(db.prepare("SELECT tokens_used FROM skill_outcomes WHERE id = 'historic'").get()).toEqual({ tokens_used: 0 });
  expect((db.prepare('PRAGMA table_info(skill_outcomes)').all() as Array<{ name: string; notnull: number }>).find((column) => column.name === 'tokens_used')?.notnull).toBe(0);
});
