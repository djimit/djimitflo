import { beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { knowledgeOverview } from '../services/knowledge-overview';

let db: Database.Database;
const NOW = Date.parse('2026-09-30T20:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });

const event = (ref: string, agent: string, h: number) => db.prepare(`INSERT INTO external_events (id, event_type, source, occurred_at, payload, ingested_at)
  VALUES (?, 'discovery.paper', ?, ?, ?, ?)`).run(`e-${ref}`, agent, ago(h), JSON.stringify({ ref, agent, title: `Paper ${ref}` }), ago(h));
const verdict = (subjectType: string, subject: string, decision: string, h: number) => db.prepare(`INSERT INTO judgments
  (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES (?, 'discovery_relevance', ?, ?, 'h', 'shadow', ?, ?)`)
  .run(`j-${subject}-${decision}`, subjectType, subject, decision, ago(h));

it('W5: counts discoveries, jev relevance and units per source, newest relevant first', () => {
  event('arxiv:1', 'djimitflo-scout', 2); event('arxiv:2', 'djimitflo-scout', 3); event('arxiv:3', 'hermes-macmini', 200);
  verdict('discovery_pending', 'arxiv:1', 'yes', 2); verdict('discovery_rejected', 'arxiv:2', 'no', 3); verdict('discovery_pending', 'arxiv:3', 'uncertain', 200);
  db.prepare(`INSERT INTO expert_identities (id, canonical_name, aliases_json, lifecycle_state, identity_confidence, provenance_json, version, kind, created_at)
    VALUES ('unit:1', 'Unit paper', '[]', 'CAPABILITY_INFERRED', 0, ?, 1, 'paper', ?)`).run(JSON.stringify({ agent: 'djimitflo-scout' }), ago(1));
  verdict('expert_unit', 'unit:1', 'yes', 1);
  const k = knowledgeOverview(db, NOW);
  const scout = k.sources.find((s) => s.source === 'djimitflo-scout')!;
  expect(scout).toMatchObject({ events: 2, events_7d: 2, yes: 2, no: 1, units: 1, relevant_pct: 66.7 });
  expect(k.sources.find((s) => s.source === 'hermes-macmini')).toMatchObject({ events: 1, events_7d: 0, uncertain: 1, relevant_pct: 0 });
  expect(k.relevance).toEqual({ yes: 2, uncertain: 1, no: 1 });
  expect(k.recent_relevant.map((r) => r.title)).toEqual(['Unit paper', 'Paper arxiv:1']);
});

it('W5: reads the interest profile and never throws on a bare schema', () => {
  db.prepare(`INSERT INTO event_outbox (event_id, event_type, aggregate_id, correlation_id, payload_json, status, created_at) VALUES ('o1', 'djimitflo.feedback.interests', 'x', 'c1', ?, 'published', ?)`)
    .run(JSON.stringify({ terms: ['agents', 'repair'] }), ago(1));
  expect(knowledgeOverview(db, NOW).interest_profile).toEqual({ at: ago(1), terms: ['agents', 'repair'] });
  const bare = new Database(':memory:');
  expect(knowledgeOverview(bare, NOW)).toMatchObject({ sources: [], relevance: { yes: 0, uncertain: 0, no: 0 }, interest_profile: null });
});
