import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { interestTerms, publishInterestProfile } from '../services/interest-feedback';

let db: Database.Database;
const NOW = Date.parse('2026-09-28T18:00:00Z');
beforeEach(() => {
  process.env.EVENT_PUBLISH_ENABLED = 'true'; db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.exec('CREATE TABLE IF NOT EXISTS kb_pages (path TEXT PRIMARY KEY, host TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)');
});
afterEach(() => { db.close(); delete process.env.EVENT_PUBLISH_ENABLED; });

it('keeps terms that recur across sources and drops stopwords', () => {
  expect(interestTerms(['Mutation testing for agents', 'Agents and mutation coverage', 'A single paper about nothing'])).toEqual(['agents', 'mutation']);
});

it('publishes the profile from retrieved KB pages once per day', () => {
  const page = db.prepare("INSERT INTO kb_pages VALUES (?, 'ws', ?, 'b', 's', x'00', '')");
  page.run('summaries/a.md', 'Prompt injection defence for coding agents');
  page.run('summaries/b.md', 'Evaluating coding agents under prompt injection');
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES ('j1', 'kb_retrieval', 'panel', 'p1', 'h', 'shadow', 'yes', 'summaries/a.md@0.41 summaries/b.md@0.33', ?)")
    .run(new Date(NOW - 86_400_000).toISOString());
  expect(publishInterestProfile(db as never, NOW)).toBe(true);
  expect(publishInterestProfile(db as never, NOW)).toBe(false);
  const rows = db.prepare("SELECT payload_json FROM event_outbox WHERE event_type = 'djimitflo.feedback.interests'").all() as Array<{ payload_json: string }>;
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].payload_json).terms).toEqual(['agents', 'coding', 'injection', 'prompt']);
});

it('leaves out generic engineering words that would match every paper', () => {
  expect(interestTerms(['Raise mutation score of services', 'Raise mutation score of tests in services'])).toEqual(['mutation']);
});
