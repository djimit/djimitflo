import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { resetTypesafeBreaker, resetTypesafeLimiter } from '../services/typesafe-client';
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
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); new FrontierExpertRegistryService(db).seedTaxonomy(); resetTypesafeBreaker(); resetTypesafeLimiter();
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

// ---- recovery contract: decision identity (event_id, policy), fenced claims, one persisted decision per identity ----
const backlog = (d: Database.Database = db) => d.prepare('SELECT event_id, ref, path, state, fence, attempts, decision, judgment_id FROM discovery_relevance_backlog ORDER BY event_id').all() as
  Array<{ event_id: string; ref: string; path: string; state: string; fence: number; attempts: number; decision: string | null; judgment_id: string | null }>;
const decisions = (d: Database.Database = db) => (d.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'discovery_relevance' AND decision <> 'error'").get() as { n: number }).n;
const unitsIn = (d: Database.Database) => (d.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind IN ('paper', 'repository')").get() as { n: number }).n;
const disc = (i: number, base: Record<string, unknown> = relevant) => ({ ...base, event_id: `ev:${i}`, ref: `arxiv:2610.${80000 + i}` });
const parkN = (svc: ExpertSourceUnitsService, from: number, n: number) => { for (let i = from; i < from + n; i++) expect(svc.ingestDiscovery(disc(i))).toBe('paused-pending'); };
const jevCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([url]) => !String(url).startsWith('http://event-bus')).length;
/** jev calls that answer only when released (index = call order): an unreleased call is a crashed / hung worker. */
function heldJev() {
  const held: Array<() => void> = [];
  const fn = vi.fn().mockImplementation(() => new Promise((resolve) => held.push(() => resolve({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: ans('lane_technique', 0.9, 0.7) }) }))));
  return { fn, release: (i: number) => held[i]() };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drb-')), 'db.sqlite');
const settle = () => new Promise((r) => setTimeout(r, 30));

it('paused: the errored-retry tick and the re-judge stand still; unpaused, a parked discovery is judged once', async () => {
  vi.stubEnv('FRONTIER_EXPERT_SOURCE_UNITS_ENABLED', 'true');
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  const events = [{ _id: '1-0', event_id: 'discovery:arxiv:2610.70005', ref: 'arxiv:2610.70005', ...relevant }];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events }), { status: 200 })));
  await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
  const svc = new ExpertSourceUnitsService(db);
  expect(svc.retryErroredRelevance(50)).toEqual({ retried: 0, skipped: 'paused' });
  expect(svc.rejudgePaused()).toEqual({ claimed: 0, skipped: 'paused' });
  expect(backlog()).toMatchObject([{ event_id: 'discovery:arxiv:2610.70005', path: 'pending', state: 'unjudged', fence: 0 }]);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  expect(svc.rejudgePaused()).toEqual({ claimed: 1 });
  await vi.waitFor(() => expect(units()).toBe(1));
  expect(backlog()).toMatchObject([{ state: 'judged', fence: 1, decision: 'yes' }]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(svc.rejudgePaused()).toEqual({ claimed: 0 }); // once
});

it('restart during backlog accumulation: parked rows survive a reopen of the database and all are judged once', async () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  const file = tmpFile();
  let fdb = new Database(file); fdb.exec(schema); runMigrations(fdb); new FrontierExpertRegistryService(fdb).seedTaxonomy();
  parkN(new ExpertSourceUnitsService(fdb), 0, 2);
  fdb.close(); // restart
  fdb = new Database(file); runMigrations(fdb);
  parkN(new ExpertSourceUnitsService(fdb), 2, 1);
  fdb.close(); // restart again
  fdb = new Database(file); runMigrations(fdb);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  expect(new ExpertSourceUnitsService(fdb).rejudgePaused()).toEqual({ claimed: 3 });
  await vi.waitFor(() => expect(unitsIn(fdb)).toBe(3));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(backlog(fdb).map((r) => r.state)).toEqual(['judged', 'judged', 'judged']);
  fdb.close();
});

it('crash between the jev response and the commit: the claim is reclaimed only after the timeout, jev is called again (at-least-once), one decision is persisted; the late stale worker is vetoed', async () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  parkN(new ExpertSourceUnitsService(db), 0, 1);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const { fn, release } = heldJev(); vi.stubGlobal('fetch', fn);
  const T0 = Date.now();
  expect(new ExpertSourceUnitsService(db).rejudgePaused({ now: T0 })).toEqual({ claimed: 1 }); // worker 1 (fence 1) never commits
  await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  const restarted = new ExpertSourceUnitsService(db);
  expect(restarted.rejudgePaused({ now: T0 + 10 * 60_000 })).toEqual({ claimed: 0 }); // the claim is still fresh
  expect(restarted.rejudgePaused({ now: T0 + 16 * 60_000 })).toEqual({ claimed: 1 }); // stale → reclaimed, fence 2
  await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
  release(1); // worker 2 commits
  await vi.waitFor(() => expect(backlog()).toMatchObject([{ state: 'judged', fence: 2 }]));
  const committed = backlog()[0].judgment_id;
  release(0); await settle(); // worker 1's response finally arrives: old fence → vetoed, nothing written
  expect(decisions()).toBe(1);
  expect(units()).toBe(1);
  expect(backlog()).toMatchObject([{ state: 'judged', fence: 2, judgment_id: committed }]);
});

it('stale worker with an old fence that answers before the new owner cannot commit; the new owner\'s decision is the only one', async () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  parkN(new ExpertSourceUnitsService(db), 0, 1);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const { fn, release } = heldJev(); vi.stubGlobal('fetch', fn);
  const T0 = Date.now(); const svc = new ExpertSourceUnitsService(db);
  svc.rejudgePaused({ now: T0 });
  expect(svc.rejudgePaused({ now: T0 + 16 * 60_000 })).toEqual({ claimed: 1 });
  await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
  release(0); await settle(); // the stale worker (fence 1) answers first
  expect(decisions()).toBe(0);
  expect(backlog()).toMatchObject([{ state: 'rejudging', fence: 2, judgment_id: null }]);
  release(1);
  await vi.waitFor(() => expect(backlog()).toMatchObject([{ state: 'judged', fence: 2 }]));
  expect(decisions()).toBe(1);
  expect(units()).toBe(1);
});

it('duplicate delivery: the same event id twice is one stored event, one backlog row and one judgment', async () => {
  vi.stubEnv('FRONTIER_EXPERT_SOURCE_UNITS_ENABLED', 'true');
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  const e = { event_id: 'discovery:arxiv:2610.70010', ref: 'arxiv:2610.70010', ...relevant };
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ events: [{ _id: '2-0', ...e }, { _id: '1-0', ...e }] }), { status: 200 })));
  await new ExternalEventIngestService(db, 'http://event-bus', 'djimit.events').pollOnce();
  new ExpertSourceUnitsService(db).ingestDiscovery(e); // and once more, directly
  expect(db.prepare("SELECT COUNT(*) n FROM external_events WHERE id = 'discovery:arxiv:2610.70010'").get()).toEqual({ n: 1 });
  expect(backlog()).toHaveLength(1);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  const svc = new ExpertSourceUnitsService(db);
  expect(svc.rejudgePaused()).toEqual({ claimed: 1 });
  await vi.waitFor(() => expect(units()).toBe(1));
  expect(svc.rejudgePaused()).toEqual({ claimed: 0 });
  expect(jevCalls(fetchMock)).toBe(1);
  expect(decisions()).toBe(1);
});

it('partial DB failure: a failed judgment insert or a failed admission rolls the whole decision back; the row stays recoverable and is admitted once', async () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  parkN(new ExpertSourceUnitsService(db), 0, 1);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  vi.stubGlobal('fetch', jev());
  const svc = new ExpertSourceUnitsService(db);
  // 1) the judgment insert itself throws
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON judgments WHEN NEW.judgment = 'discovery_relevance' AND NEW.decision <> 'error' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  expect(svc.rejudgePaused()).toEqual({ claimed: 1 });
  await vi.waitFor(() => expect(backlog()).toMatchObject([{ state: 'unjudged', attempts: 1 }]));
  expect(decisions()).toBe(0); expect(units()).toBe(0);
  db.exec('DROP TRIGGER fail_insert');
  // 2) the admission step fails after the unit was created inside the transaction: unit and judgment roll back together
  db.exec("CREATE TRIGGER fail_admission BEFORE UPDATE OF subject_type ON judgments BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  expect(svc.rejudgePaused()).toEqual({ claimed: 1 });
  await vi.waitFor(() => expect(backlog()).toMatchObject([{ state: 'unjudged', attempts: 2 }]));
  expect(decisions()).toBe(0); expect(units()).toBe(0);
  db.exec('DROP TRIGGER fail_admission');
  // 3) healthy again: one decision, one unit
  expect(svc.rejudgePaused()).toEqual({ claimed: 1 });
  await vi.waitFor(() => expect(units()).toBe(1));
  expect(backlog()).toMatchObject([{ state: 'judged', attempts: 2, fence: 3 }]);
  expect(svc.rejudgePaused()).toEqual({ claimed: 0 });
  expect(decisions()).toBe(1); expect(units()).toBe(1);
});

it('concurrent re-judge workers on two connections: each event is claimed and judged once', async () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  const file = tmpFile();
  const a = new Database(file); a.exec(schema); runMigrations(a); new FrontierExpertRegistryService(a).seedTaxonomy();
  parkN(new ExpertSourceUnitsService(a), 0, 5);
  const b = new Database(file, { timeout: 5_000 });
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  const wa = new ExpertSourceUnitsService(a); const wb = new ExpertSourceUnitsService(b);
  const ra = wa.rejudgePaused({ limit: 3 }); const rb = wb.rejudgePaused({ limit: 3 }); const ra2 = wa.rejudgePaused({ limit: 3 });
  expect(ra.claimed + rb.claimed + ra2.claimed).toBe(5);
  expect(rb.claimed).toBe(2); // worker B only got what A had not claimed
  await vi.waitFor(() => expect(backlog(a).every((r) => r.state === 'judged')).toBe(true));
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(decisions(a)).toBe(5); expect(unitsIn(a)).toBe(5);
  expect(backlog(a).every((r) => r.fence === 1)).toBe(true);
  a.close(); b.close();
});

it('pause/unpause toggles: no duplicate re-judge and no lost event; normal ingestion leaves a parked ref to the backlog', async () => {
  const svc = new ExpertSourceUnitsService(db);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  parkN(svc, 0, 2);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  expect(svc.rejudgePaused({ limit: 1 })).toEqual({ claimed: 1 });
  await vi.waitFor(() => expect(units()).toBe(1));
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  expect(svc.ingestDiscovery(disc(1))).toBe('paused-pending'); // re-delivered while paused again: same identity, one row
  parkN(svc, 2, 1);
  expect(svc.rejudgePaused()).toEqual({ claimed: 0, skipped: 'paused' });
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  expect(svc.ingestDiscovery({ ...disc(1), event_id: 'ev:1-again' })).toBe('known'); // the backlog owns ref 1: no jev call here
  expect(jevCalls(fetchMock)).toBe(1);
  expect(svc.rejudgePaused()).toEqual({ claimed: 2 });
  await vi.waitFor(() => expect(units()).toBe(3));
  expect(backlog().map((r) => [r.event_id, r.state, r.fence])).toEqual([['ev:0', 'judged', 1], ['ev:1', 'judged', 1], ['ev:2', 'judged', 1]]);
  expect(jevCalls(fetchMock)).toBe(3);
  expect(decisions()).toBe(3);
});

it('bounded drain: unpausing replays nothing by itself; each call claims ≤ batch, 24 h ≤ max_per_day; the overview shows backlog, age and drain time', async () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  vi.stubEnv('DISCOVERY_REJUDGE_MAX_PER_DAY', '25');
  const svc = new ExpertSourceUnitsService(db);
  parkN(svc, 0, 50);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  const fetchMock = jev(); vi.stubGlobal('fetch', fetchMock);
  const p = knowledgeOverview(db).relevance_pause;
  expect(p).toMatchObject({ paused: false, backlog: 50, states: { unjudged: 50 }, rejudge: { batch: 20, max_per_day: 25, per_day: 25, drain_estimate_days: 2 } });
  expect(p.oldest_unjudged_age_hours).toBeGreaterThanOrEqual(0);
  expect(svc.ingestDiscovery(disc(100))).toBe('pending'); // a new discovery after unpausing: judged normally, the backlog untouched
  await vi.waitFor(() => expect(jevCalls(fetchMock)).toBe(1));
  expect(backlog().filter((r) => r.state === 'unjudged')).toHaveLength(50);
  const T0 = Date.now();
  const drained = (n: number) => vi.waitFor(() => expect(backlog().filter((r) => r.state === 'judged')).toHaveLength(n));
  expect(svc.rejudgePaused({ now: T0 })).toEqual({ claimed: 20 });
  expect(svc.rejudgePaused({ now: T0 })).toEqual({ claimed: 0, skipped: 'jev_busy' }); // backpressure: 20 calls > the jev limiter's 6 slots
  await drained(20);
  expect(svc.rejudgePaused({ now: T0 })).toEqual({ claimed: 5 });
  await drained(25);
  expect(svc.rejudgePaused({ now: T0 })).toEqual({ claimed: 0, skipped: 'daily_cap' });
  expect(svc.rejudgePaused({ now: T0 + 25 * 3_600_000 })).toEqual({ claimed: 20 });
  await vi.waitFor(() => expect(jevCalls(fetchMock)).toBe(46));
  await vi.waitFor(() => expect(backlog().filter((r) => r.state === 'judged')).toHaveLength(45));
});

it('the knowledge overview reports the pause: unjudged discoveries, calls avoided (rejected capped per day) and an estimated token saving', () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  vi.stubEnv('DISCOVERY_GATE_SHADOW_MAX_PER_DAY', '2');
  const now = Date.parse('2026-10-14T12:00:00Z');
  const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const tok = db.prepare("INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, input_tokens, output_tokens, created_at) VALUES (?, 'discovery_relevance', 'discovery_pending', ?, 'h', 'shadow', ?, ?, ?, ?)");
  tok.run('j1', 'arxiv:1', 'no', 700, 100, iso(30)); tok.run('j2', 'arxiv:2', 'uncertain', 900, 100, iso(40)); tok.run('j3', 'arxiv:3', 'error', 0, 0, iso(41));
  const row = db.prepare("INSERT INTO discovery_relevance_backlog (event_id, policy, ref, path, event_json, paused_at, state) VALUES (?, 'p', ?, ?, '{}', ?, ?)");
  row.run('e1', 'arxiv:p1', 'pending', iso(1), 'unjudged'); row.run('e2', 'arxiv:p1', 'pending', iso(1), 'unjudged'); row.run('e3', 'arxiv:p2', 'pending', iso(2), 'rejudging');
  row.run('e4', 'arxiv:p3', 'pending', iso(3), 'judged');
  for (let i = 0; i < 5; i++) row.run(`r${i}`, `arxiv:r${i}`, 'rejected', iso(1), 'unjudged');
  const p = knowledgeOverview(db, now).relevance_pause;
  expect(p).toMatchObject({ paused: true, unjudged: { pending: 2, rejected: 5, unit: 0 }, calls_avoided: 4, mean_tokens_per_call: 900, tokens_avoided_estimate: 3600,
    backlog: 8, states: { unjudged: 7, rejudging: 1, judged: 1 }, oldest_unjudged_age_hours: 2 });
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

it('AUTHZ-F2: the backlog re-judge creates a unit only on a verdict with recorded provenance, like the live path (DI-001 B, fail-closed)', async () => {
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'true');
  const svc = new ExpertSourceUnitsService(db);
  parkN(svc, 900, 1);
  vi.stubEnv('DISCOVERY_RELEVANCE_PAUSED', 'false');
  vi.stubGlobal('fetch', jev());
  const { discoveryRelevance } = await import('../services/judgments/discovery-relevance');
  const version = discoveryRelevance.policyVersion;
  discoveryRelevance.policyVersion = undefined; // provenance becomes 'partial'
  try {
    expect(svc.rejudgePaused()).toEqual({ claimed: 1 });
    await vi.waitFor(() => expect(backlog()).toMatchObject([{ state: 'judged', decision: 'yes' }]));
    await settle();
    expect(units()).toBe(0);
  } finally { discoveryRelevance.policyVersion = version; }
});
