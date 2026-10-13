import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { resetTypesafeBreaker } from '../services/typesafe-client';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { discoveryRelevancePaused, ExpertSourceUnitsService } from '../services/expert-source-units-service';
import { ExternalEventIngestService } from '../services/external-event-ingest-service';
import { knowledgeOverview } from '../services/knowledge-overview';
import { fleetSourceGate } from '../services/committee-swarm';
import { publishInterestProfile, termYields } from '../services/interest-feedback';
import { detectStalls } from '../services/stall-watch';

/** DI-001 C: DISCOVERY_RELEVANCE_PAUSED stops new discovery_relevance jev calls, with an explicit paused path per dependent. */
const ans = (relevance: string, conf: number, actionable: number) => ({ relevance: { type: 'choice', choice: relevance, confidence: conf, probabilities: {} }, actionable: { type: 'noul', noul: actionable } });
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); new FrontierExpertRegistryService(db).seedTaxonomy(); resetTypesafeBreaker();
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'true');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });

const relevant = { event_type: 'discovery.paper', title: 'Mutation-guided test generation for coding agents', agent: 'djimitflo-scout' };
const rejected = { event_type: 'discovery.paper', title: 'Trapped-ion qubit calibration', agent: 'djimitflo-scout' };
const units = () => (db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind IN ('paper', 'repository')").get() as { n: number }).n;
const judgments = () => (db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'discovery_relevance'").get() as { n: number }).n;
const jev = (verdict = ans('lane_technique', 0.9, 0.7)) => vi.fn().mockImplementation(async (url: string) => (String(url).startsWith('http://event-bus')
  ? new Response(JSON.stringify({ events: [] }), { status: 200 })
  : { ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: verdict }) }));
const stored = (ref: string) => JSON.parse((db.prepare("SELECT payload FROM external_events WHERE json_extract(payload, '$.ref') = ?").get(ref) as { payload: string }).payload) as Record<string, unknown>;

it('default false: the flag is off unless exactly "true", and an unpaused FE2 ingest still calls jev', async () => {
  expect(discoveryRelevancePaused({})).toBe(false);
  expect(discoveryRelevancePaused({ DISCOVERY_RELEVANCE_PAUSED: '1' })).toBe(false);
  expect(discoveryRelevancePaused({ DISCOVERY_RELEVANCE_PAUSED: 'true' })).toBe(true);
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  expect(new ExpertSourceUnitsService(db).ingestDiscovery({ ...relevant, ref: 'arxiv:2610.70001' })).toBe('pending');
  await vi.waitFor(() => expect(units()).toBe(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('paused, FE2 path: no jev call, no unit admitted, the event is stored and marked unjudged', async () => {
  vi.stubEnv('FRONTIER_EXPERT_SOURCE_UNITS_ENABLED', 'true');
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  const events = [{ _id: '1-0', event_id: 'discovery:arxiv:2610.70002', ref: 'arxiv:2610.70002', ...relevant }];
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('http://event-bus'))).toBe(true); // only the bus, never jev
  expect(judgments()).toBe(0);
  expect(units()).toBe(0);
  expect(stored('arxiv:2610.70002')).toMatchObject({ relevance: 'unjudged', relevance_paused: 'pending', title: relevant.title });
});

it('paused, rejected path: no R3 shadow call and no KE-2 override unit; the G3 direct path keeps admitting (it never waited for jev)', async () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  const svc = new ExpertSourceUnitsService(db);
  expect(svc.ingestDiscovery({ ...rejected, ref: 'arxiv:2610.70003' })).toBe('paused-rejected');
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'false');
  expect(svc.ingestDiscovery({ ...relevant, ref: 'arxiv:2610.70004' })).toBe('paused-unit');
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(units()).toBe(1); // the direct-path unit, as without the pause
  expect(judgments()).toBe(0);
});

it('paused: the errored-retry tick and the paused re-judge stand still; unpaused, a paused discovery is judged once through the normal path', async () => {
  vi.stubEnv('FRONTIER_EXPERT_SOURCE_UNITS_ENABLED', 'true');
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  const events = [{ _id: '1-0', event_id: 'discovery:arxiv:2610.70005', ref: 'arxiv:2610.70005', ...relevant }];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events }), { status: 200 })));
  await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
  const svc = new ExpertSourceUnitsService(db);
  expect(svc.retryErroredRelevance(50)).toEqual({ retried: 0, skipped: 'paused' });
  expect(svc.rejudgePaused(50)).toEqual({ requeued: 0, skipped: 'paused' });
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  expect(svc.rejudgePaused(50)).toEqual({ requeued: 1 });
  await vi.waitFor(() => expect(units()).toBe(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(stored('arxiv:2610.70005').relevance).toBe('requeued');
  expect(svc.rejudgePaused(50)).toEqual({ requeued: 0 }); // once
});

it('the knowledge overview reports the pause: unjudged discoveries, calls avoided (rejected capped per day) and an estimated token saving', () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  vi.stubEnv('DISCOVERY_GATE_SHADOW_MAX_PER_DAY', '2');
  const now = Date.parse('2026-10-14T12:00:00Z');
  const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const tok = db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, input_tokens, output_tokens, created_at) VALUES (?, 'discovery_relevance', 'discovery_pending', ?, 'h', 'shadow', ?, ?, ?, ?)");
  tok.run('j1', 'arxiv:1', 'no', 700, 100, iso(30)); tok.run('j2', 'arxiv:2', 'uncertain', 900, 100, iso(40)); tok.run('j3', 'arxiv:3', 'error', 0, 0, iso(41));
  const ev = db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, ingested_at, payload) VALUES (?, 'discovery.paper', 'djimitflo-scout', ?, ?, ?)");
  const mark = (id: string, ref: string, path: string, h: number) => ev.run(id, iso(h), iso(h), JSON.stringify({ ref, agent: 'djimitflo-scout', relevance: 'unjudged', relevance_paused: path, relevance_paused_at: iso(h) }));
  mark('e1', 'arxiv:p1', 'pending', 1); mark('e2', 'arxiv:p1', 'pending', 1); mark('e3', 'arxiv:p2', 'pending', 2);
  for (let i = 0; i < 5; i++) mark(`r${i}`, `arxiv:r${i}`, 'rejected', 1);
  const p = knowledgeOverview(db, now).relevance_pause;
  expect(p).toMatchObject({ paused: true, unjudged: { pending: 2, rejected: 5, unit: 0 }, calls_avoided: 4, mean_tokens_per_call: 900, tokens_avoided_estimate: 3600 });
  expect(p.basis).toMatch(/estimate/);
});

it('fleet source gate and N4 term yields treat paused-period discoveries as missing, not as "no"', () => {
  const now = Date.now(); const iso = new Date(now - 3_600_000).toISOString();
  const ev = db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'discovery.paper', 'src-a', ?, ?)");
  const j = db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES (?, 'discovery_relevance', 'discovery_pending', ?, 'h', 'shadow', ?, ?)");
  for (let i = 0; i < 49; i++) { ev.run(`n${i}`, iso, JSON.stringify({ ref: `arxiv:n${i}`, agent: 'src-a', note: 'scout match: repair' })); j.run(`j${i}`, `arxiv:n${i}`, i < 3 ? 'uncertain' : 'no', iso); }
  for (let i = 0; i < 10; i++) ev.run(`p${i}`, iso, JSON.stringify({ ref: `arxiv:p${i}`, agent: 'src-a', note: 'scout match: repair', relevance: 'unjudged', relevance_paused: 'pending' }));
  expect(fleetSourceGate(db, 'src-a', now)).toEqual({ allowed: true, reason: '0/49 relevant' }); // 49 judged, the 10 paused are not 'no'
  expect(termYields(db, new Date(now - 86_400_000).toISOString()).terms.get('repair')).toEqual({ n: 49, yes: 0 });
});

it('stall watch: while paused, "no judgment for 36 h" is not a stall; a publisher that stopped sending still is', () => {
  const NOW = Date.parse('2026-10-14T12:00:00Z');
  const env = { FRONTIER_EXPERT_SOURCE_UNITS_ENABLED: 'true', DISCOVERY_RELEVANCE_PAUSED: 'true' };
  db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES ('j', 'discovery_relevance', 'discovery_pending', 'x', 'h', 'shadow', 'no', ?)").run(new Date(NOW - 72 * 3_600_000).toISOString());
  const ev = db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, ingested_at, payload) VALUES (?, 'discovery.paper', 's', ?, ?, '{}')");
  ev.run('old', new Date(NOW - 48 * 3_600_000).toISOString(), new Date(NOW - 48 * 3_600_000).toISOString());
  expect(detectStalls(db, NOW, env).find((s) => s.subsystem === 'discoveries')?.detail).toContain('no fleet discovery received');
  ev.run('new', new Date(NOW - 3_600_000).toISOString(), new Date(NOW - 3_600_000).toISOString());
  expect(detectStalls(db, NOW, env).map((s) => s.subsystem)).not.toContain('discoveries');
  expect(detectStalls(db, NOW, { FRONTIER_EXPERT_SOURCE_UNITS_ENABLED: 'true' }).map((s) => s.subsystem)).toContain('discoveries'); // unpaused: unchanged
});

it('N4 trial clock: a pause never runs an unmeasured trial out of time (missing, not failed); unpaused it expires as before', () => {
  vi.stubEnv('EVENT_PUBLISH_ENABLED', 'true');
  db.exec('CREATE TABLE IF NOT EXISTS kb_pages (path TEXT PRIMARY KEY, host TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, sha TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)');
  const NOW = Date.parse('2026-09-28T18:00:00Z'); const DAY = 86_400_000;
  for (let i = 0; i < 40; i++) { // a measured static baseline (mutation, 20 %)
    db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'discovery.paper', 'djimitflo-scout', ?, ?)").run(`e${i}`, new Date(NOW - 2 * DAY).toISOString(), JSON.stringify({ ref: `arxiv:s.${i}`, note: 'scout match: mutation' }));
    db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES (?, 'discovery_relevance', 'discovery_rejected', ?, 'h', 'shadow', ?, ?)").run(`j${i}`, `arxiv:s.${i}`, i < 8 ? 'yes' : 'uncertain', new Date(NOW - DAY).toISOString());
  }
  ['Lattice sieves', 'Lattice sieves again'].forEach((t, i) => {
    db.prepare("INSERT INTO expert_identities (id, canonical_name, kind, provenance_json) VALUES (?, ?, 'paper', '{}')").run(`expert:c${i}`, t);
    db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, created_at) VALUES (?, 'discovery_relevance', 'expert_unit', ?, 'h', 'shadow', 'yes', ?)").run(`jc${i}`, `expert:c${i}`, new Date(NOW - DAY).toISOString());
  });
  const published = (at: number) => JSON.parse((db.prepare('SELECT payload_json FROM event_outbox WHERE aggregate_id = ?').get(`interests-${new Date(at).toISOString().slice(0, 10)}`) as { payload_json: string }).payload_json) as
    { yields: Array<{ term: string; since?: string }>; cooldown: Array<{ term: string }> };
  publishInterestProfile(db as never, NOW, {});
  publishInterestProfile(db as never, NOW + 15 * DAY, { DISCOVERY_RELEVANCE_PAUSED: 'true' });
  expect(published(NOW + 15 * DAY).cooldown).toEqual([]);
  expect(published(NOW + 15 * DAY).yields.find((y) => y.term === 'lattice')).toMatchObject({ trial: true, since: new Date(NOW + 15 * DAY).toISOString() });
  publishInterestProfile(db as never, NOW + 30 * DAY, {});
  expect(published(NOW + 30 * DAY).cooldown.map((c) => c.term)).toContain('lattice'); // unpaused: the 14-day rule applies again
});
