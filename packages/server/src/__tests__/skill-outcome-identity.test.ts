import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
let db: Database.Database;
afterEach(() => db?.close());
it('migrates legacy outcomes without inventing version, runtime or artifact identity', () => {
  db = new Database(':memory:'); db.exec(schema);
  db.exec(`CREATE TABLE skill_outcomes(id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, success INTEGER DEFAULT 0,
    tokens_used INTEGER, duration_ms INTEGER DEFAULT 0, domain TEXT DEFAULT '', created_at TEXT);
    INSERT INTO skill_outcomes(id,skill_id) VALUES('historical','label');`);
  runMigrations(db); runMigrations(db);
  expect(db.prepare('SELECT capability_id,artifact_digest,runtime FROM skill_outcomes WHERE id=?').get('historical'))
    .toEqual({ capability_id: null, artifact_digest: null, runtime: null });
  new SkillEvolutionEngine(db);
  expect(db.prepare('SELECT skill_version FROM skill_outcomes WHERE id=?').get('historical')).toEqual({ skill_version: null });
});
it('persists exact executable identity separately from the instructions and unknown usage', () => {
  db = new Database(':memory:');
  const service = new SkillEvolutionEngine(db);
  service.recordOutcome('label-v1-0-0', { success: false, tokensUsed: null, durationMs: 10, domain: 'review_only',
    taskId: 'task', skillVersion: '1.0.0', skillContentHash: 'a'.repeat(64), artifactDigest: 'b'.repeat(64),
    capabilityId: 'skill:label-v1-0-0@1.0.0', runtime: 'codex', evidenceRefs: ['outcome_class:completed_unverified'] });
  expect(db.prepare('SELECT capability_id,artifact_digest,runtime,skill_version,skill_content_hash,tokens_used FROM skill_outcomes').get())
    .toEqual({ capability_id: 'skill:label-v1-0-0@1.0.0', artifact_digest: 'b'.repeat(64), runtime: 'codex',
      skill_version: '1.0.0', skill_content_hash: 'a'.repeat(64), tokens_used: null });
});
