import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import fs from 'fs';
import path from 'path';
import { interestProfile, interestTerms, MIN_TERM_N, PROFILE_TERM_CAP, publishInterestProfile, SCOUT_STATIC_TERMS } from '../services/interest-feedback';

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
  scouted('s', 'mutation', 40, 8); scouted('i', 'injection', 20, 10); // only 'injection' has a measured yield ≥ the static list
  expect(publishInterestProfile(db as never, NOW)).toBe(true);
  expect(publishInterestProfile(db as never, NOW)).toBe(false);
  const rows = db.prepare("SELECT payload_json FROM event_outbox WHERE event_type = 'djimitflo.feedback.interests'").all() as Array<{ payload_json: string }>;
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].payload_json).terms).toEqual(['injection']);
});

it('leaves out generic engineering words that would match every paper', () => {
  expect(interestTerms(['Raise mutation score of services', 'Raise mutation score of tests in services'])).toEqual(['mutation']);
});

it('N4: drops ids, title verbs and plural duplicates (prod profile 30-09 carried added, proposal-61847269, agent + agents)', () => {
  expect(interestTerms([
    'Added agent benchmarks for proposal-61847269', 'Agents added a benchmark', 'agent benchmark v2 proposal-61847269',
  ])).toEqual(['agent', 'benchmark']);
});

// N4 yield gate (Phase KE 09-10): profile-only terms ('agent', 'benchmark', 'prove', 'generation') pulled 3,992 of 4,776 scout
// papers at 5.7 % jev yes vs 13.5 % for the static list — a term is published only when its own measured yield is at least as good.
const ev = (db_: Database.Database) => db_.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'discovery.paper', 'djimitflo-scout', ?, ?)");
const verdict = (db_: Database.Database) => db_.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'discovery_relevance', 'discovery_rejected', ?, 'h', 'shadow', ?, NULL, ?)");
/** n scout discoveries whose note matched `hits`, of which `yes` were judged relevant. */
function scouted(prefix: string, hits: string, n: number, yes: number) {
  for (let i = 0; i < n; i++) {
    const ref = `arxiv:${prefix}.${i}`;
    ev(db).run(`e-${ref}`, new Date(NOW - 2 * 86_400_000).toISOString(), JSON.stringify({ ref, title: `t ${ref}`, agent: 'djimitflo-scout', note: `scout match: ${hits}` }));
    verdict(db).run(`j-${ref}`, ref, i < yes ? 'yes' : 'uncertain', new Date(NOW - 86_400_000).toISOString());
  }
}
/** candidate terms: relevant discoveries (G3 'yes' on expert units) whose titles name them twice */
function candidates(...titles: string[]) {
  titles.forEach((t, i) => {
    db.prepare("INSERT INTO expert_identities (id, canonical_name, kind, provenance_json) VALUES (?, ?, 'paper', '{}')").run(`expert:c${i}`, t);
    db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, created_at) VALUES (?, 'discovery_relevance', 'expert_unit', ?, 'h', 'shadow', 'yes', NULL, ?)")
      .run(`jc${i}`, `expert:c${i}`, new Date(NOW - 86_400_000).toISOString());
  });
}

it('N4 yield gate: a high-yield term is kept, a low-yield term is dropped, an unmeasured term (n < 20) is dropped', () => {
  scouted('s', 'mutation', 40, 8); // static baseline 20 %
  scouted('r', 'repair', 30, 9); // 30 % ≥ baseline → kept
  scouted('f', 'fuzzer', 30, 3); // 10 % < baseline → dropped
  scouted('l', 'lattice', 10, 10); // 100 % but n = 10 → unmeasured, dropped
  candidates('Fuzzer repair lattice', 'Fuzzer repair lattice again');
  const p = interestProfile(db as never, NOW);
  expect(p.terms).toEqual(['repair']);
  expect(p.baseline).toEqual({ yield: 0.2, n: 40 });
});

it('N4 yield gate: generic terms stay out even with a high measured yield', () => {
  scouted('s', 'mutation', 40, 4);
  scouted('a', 'agent, benchmark', 50, 25);
  candidates('Agent benchmark', 'Agent benchmark two');
  expect(interestProfile(db as never, NOW).terms).toEqual([]);
  expect(publishInterestProfile(db as never, NOW)).toBe(false);
});

it('N4 exploration cap: at most PROFILE_TERM_CAP profile terms, best yield first', () => {
  scouted('s', 'mutation', 40, 4);
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echoes', 'foxtrot', 'golfer', 'hotel', 'india', 'juliet', 'kilos', 'limas'];
  words.forEach((w, i) => scouted(w, w, 20, 10 + (i % 5)));
  candidates(words.join(' '), words.join(' '));
  const p = interestProfile(db as never, NOW);
  expect(PROFILE_TERM_CAP).toBeLessThanOrEqual(10);
  expect(p.terms).toHaveLength(PROFILE_TERM_CAP);
  expect(p.yields.map((y) => y.yield)).toEqual([...p.yields.map((y) => y.yield)].sort((a, b) => b - a));
});

it('N4 audit: the published profile carries each term with its yield and n, plus the static baseline', () => {
  scouted('s', 'mutation', 40, 8);
  scouted('r', 'repair', 30, 9);
  candidates('Program repair loops', 'Repair agents for repair');
  expect(publishInterestProfile(db as never, NOW)).toBe(true);
  const payload = JSON.parse((db.prepare("SELECT payload_json FROM event_outbox WHERE event_type = 'djimitflo.feedback.interests'").get() as { payload_json: string }).payload_json);
  expect(payload).toMatchObject({ terms: ['repair'], yields: [{ term: 'repair', yield: 0.3, n: 30 }], baseline: { yield: 0.2, n: 40 },
    rule: { window_days: 30, min_n: MIN_TERM_N, cap: PROFILE_TERM_CAP } });
});

it('N4: the static scout list mirrors scripts/fleet-discovery-publisher.py INTERESTS', () => {
  const py = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/fleet-discovery-publisher.py'), 'utf8');
  const list = /^INTERESTS = \[([\s\S]*?)\]/m.exec(py)![1];
  expect([...list.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(SCOUT_STATIC_TERMS);
});
