import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { resetTypesafeBreaker } from '../services/typesafe-client';
import { discoveryRelevance } from '../services/judgments/discovery-relevance';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertSourceUnitsService } from '../services/expert-source-units-service';

const ans = (relevance: string, conf: number, actionable: number) => ({ relevance: { type: 'choice', choice: relevance, confidence: conf, probabilities: {} }, actionable: { type: 'noul', noul: actionable } }) as never;
let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); new FrontierExpertRegistryService(db).seedTaxonomy(); resetTypesafeBreaker(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.close(); });

it('G3: relevant only when it touches an open problem or a lane technique and is actionable', () => {
  expect(discoveryRelevance.decide(ans('open_problem', 0.9, 0.8)).decision).toBe('yes');
  expect(discoveryRelevance.decide(ans('lane_technique', 0.9, 0.6)).decision).toBe('yes');
  expect(discoveryRelevance.decide(ans('lane_technique', 0.9, 0.2)).decision).toBe('no');
  expect(discoveryRelevance.decide(ans('adjacent', 0.95, 0.9)).decision).toBe('no');
  expect(discoveryRelevance.decide(ans('off_topic', 0.95, 0.9)).decision).toBe('no');
  expect(discoveryRelevance.decide(ans('open_problem', 0.2, 0.9)).decision).toBe('uncertain');
});

it('G3: a new fleet discovery unit gets a shadow relevance judgment with the open problems as context', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: ans('lane_technique', 0.9, 0.7) }) });
  vi.stubGlobal('fetch', fetchMock);
  const result = new ExpertSourceUnitsService(db).ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2609.12345', title: 'Scalable oversight for coding agents', agent: 'hermes-macmini' });
  expect(result).toBe('unit');
  await vi.waitFor(() => expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'discovery_relevance'").get()).toEqual({ n: 1 }));
  const row = db.prepare("SELECT subject_type, decision, mode FROM judgments WHERE judgment = 'discovery_relevance'").get();
  expect(row).toEqual({ subject_type: 'expert_unit', decision: 'yes', mode: 'shadow' });
  expect(JSON.stringify(fetchMock.mock.calls[0])).toContain('open_problems');
});

it('G3: off by default — ingestion does not call the judgment service', () => {
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  expect(new ExpertSourceUnitsService(db).ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2609.54321', title: 'Scalable oversight for coding agents' })).toBe('unit');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('R3: a discovery the keyword gate rejects is judged too (shadow, capped per day) so the gate can be measured', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  vi.stubEnv('DISCOVERY_GATE_SHADOW_MAX_PER_DAY', '1');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: ans('off_topic', 0.9, 0.1) }) }));
  const svc = new ExpertSourceUnitsService(db);
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2609.11111', title: 'Quantum error correction in trapped ions' })).toBe('irrelevant');
  await vi.waitFor(() => expect(db.prepare("SELECT subject_type, subject_id, decision FROM judgments WHERE judgment = 'discovery_relevance'").all())
    .toEqual([{ subject_type: 'discovery_rejected', subject_id: 'arxiv:2609.11111', decision: 'no' }]));
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2609.22222', title: 'Superconducting qubit calibration' })).toBe('irrelevant');
  await new Promise((r) => setTimeout(r, 20));
  expect((db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'discovery_relevance'").get() as { n: number }).n).toBe(1); // cap
});

it('FE2: with FRONTIER_UNITS_REQUIRE_RELEVANCE a unit is created only for a relevant discovery, and a ref is judged once', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'true');
  const verdicts = [ans('lane_technique', 0.9, 0.7), ans('adjacent', 0.9, 0.2)];
  const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: verdicts.shift() }) }));
  vi.stubGlobal('fetch', fetchMock);
  const svc = new ExpertSourceUnitsService(db);
  const units = () => db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind = 'paper'").get() as { n: number };
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2609.10001', title: 'Mutation-guided test generation for coding agents', agent: 'djimitflo-scout' })).toBe('pending');
  await vi.waitFor(() => expect(units().n).toBe(1));
  expect(db.prepare("SELECT subject_type FROM judgments WHERE judgment = 'discovery_relevance'").get()).toEqual({ subject_type: 'expert_unit' });
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2609.10002', title: 'Scalable oversight for coding agents in general', agent: 'x' })).toBe('pending');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await new Promise((r) => setTimeout(r, 20));
  expect(units().n).toBe(1); // adjacent → no unit
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2609.10002', title: 'Scalable oversight for coding agents in general', agent: 'x' })).toBe('known');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('JEV-BURST: the rejected-gate shadow cap also counts judgments still in flight (a synchronous batch used to blow through it)', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  vi.stubEnv('DISCOVERY_GATE_SHADOW_MAX_PER_DAY', '2');
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: ans('off_topic', 0.9, 0.1) }) });
  vi.stubGlobal('fetch', fetchMock);
  const svc = new ExpertSourceUnitsService(db);
  for (let i = 0; i < 5; i += 1) expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: `arxiv:2610.3000${i}`, title: `Trapped-ion qubit calibration ${i}` })).toBe('irrelevant');
  await vi.waitFor(() => expect((db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'discovery_relevance'").get() as { n: number }).n).toBe(2));
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect((db.prepare("SELECT COUNT(*) n FROM judgments WHERE judgment = 'discovery_relevance'").get() as { n: number }).n).toBe(2);
});

it('JEV-BURST: FE2 — a failed judgment (queue full, timeout) is not a verdict; the ref is judged again when it is sent again', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'true');
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: ans('lane_technique', 0.9, 0.7) }) });
  vi.stubGlobal('fetch', fetchMock);
  const svc = new ExpertSourceUnitsService(db);
  const event = { event_type: 'discovery.paper', ref: 'arxiv:2610.40001', title: 'Mutation-guided test generation for coding agents', agent: 'djimitflo-scout' };
  expect(svc.ingestDiscovery(event)).toBe('pending');
  await vi.waitFor(() => expect(db.prepare("SELECT decision FROM judgments WHERE judgment = 'discovery_relevance'").all()).toEqual([{ decision: 'error' }]));
  expect(svc.ingestDiscovery(event)).toBe('pending');
  await vi.waitFor(() => expect(db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind = 'paper'").get()).toEqual({ n: 1 }));
  expect(svc.ingestDiscovery(event)).toBe('known');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('JEV-SCOPE: DISCOVERY_RELEVANCE_SOURCES limits judgments and units to the listed sources; unset keeps every source', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'true');
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: ans('lane_technique', 0.9, 0.7) }) });
  vi.stubGlobal('fetch', fetchMock);
  const svc = new ExpertSourceUnitsService(db);
  const ev = (n: number, agent: string, extra: Record<string, unknown> = {}) => ({ event_type: 'discovery.paper', ref: `arxiv:2610.5000${n}`, title: 'Mutation-guided test generation for coding agents', agent, ...extra });
  expect(svc.ingestDiscovery(ev(1, 'hermes-macmini'))).toBe('pending'); // unset: unchanged
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  vi.stubEnv('DISCOVERY_RELEVANCE_SOURCES', 'djimitflo-scout, operator-chatgpt');
  expect(svc.ingestDiscovery(ev(2, 'hermes-macmini'))).toBe('irrelevant');
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2610.50003', title: 'Mutation-guided test generation for coding agents' })).toBe('irrelevant'); // no source
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'false');
  expect(svc.ingestDiscovery(ev(4, 'hermes-eve-v'))).toBe('irrelevant'); // no unit on the direct path either
  expect(svc.ingestDiscovery(ev(5, 'operator-chatgpt'))).toBe('unit');
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'true');
  expect(svc.ingestDiscovery(ev(6, 'x', { agent: undefined, source: 'djimitflo-scout' }))).toBe('pending'); // event source when no agent
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const judged = (db.prepare("SELECT subject_id FROM judgments WHERE judgment = 'discovery_relevance'").all() as Array<{ subject_id: string }>).length;
  expect(judged).toBe(3);
  expect(db.prepare("SELECT COUNT(*) n FROM judgments WHERE subject_id IN ('arxiv:2610.50002', 'arxiv:2610.50003', 'arxiv:2610.50004')").get()).toEqual({ n: 0 });
});

const meta = (ref: string) => JSON.parse((db.prepare(`SELECT e.metadata_json m FROM expert_evidence e JOIN expert_identities i ON i.id = e.expert_id
  WHERE i.aliases_json LIKE ?`).get(`%"${ref}"%`) as { m: string }).m) as Record<string, unknown>;
const busEvent = (ref: string, title: string, agent = 'djimitflo-scout', note = '') => {
  const payload = { event_id: `discovery:${ref}`, event_type: 'discovery.paper', source: agent, agent, ref, title, note };
  db.prepare("INSERT INTO external_events (id, event_type, source, occurred_at, payload) VALUES (?, 'discovery.paper', ?, ?, ?)").run(`discovery:${ref}`, agent, new Date().toISOString(), JSON.stringify(payload));
  return payload;
};

it('KE-1: a discovery note that carries an abstract is stored as the unit\'s abstract; a scout keyword note is not', () => {
  const svc = new ExpertSourceUnitsService(db);
  const prose = 'We present a mutation-guided test generation method for coding agents. Across four benchmarks it kills 23% more mutants than prior LLM baselines while keeping tests readable and deterministic. Code and data are released.';
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2610.60001', title: 'Scalable oversight for coding agents', agent: 'operator-chatgpt', note: prose })).toBe('unit');
  expect(meta('arxiv:2610.60001')).toMatchObject({ abstract: prose, note: prose, derived: 'fleet-discovery' });
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2610.60002', title: 'Scalable oversight for coding agents II', agent: 'djimitflo-scout',
    note: 'scout match: unit test, agent evaluation, requirements, agent, coding, prompt, benchmark, agentic, engineering, evaluation, failure' })).toBe('unit');
  expect(meta('arxiv:2610.60002').abstract).toBeUndefined();
});

it('KE-2: under FRONTIER_UNITS_REQUIRE_RELEVANCE a gate-rejected discovery that jev calls relevant becomes a unit (taxonomy_override:jev)', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: ans('lane_technique', 0.9, 0.7) }) }));
  const svc = new ExpertSourceUnitsService(db);
  const units = () => (db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind = 'paper'").get() as { n: number }).n;
  // flag off: the shadow verdict stays a measurement, the gate is unchanged
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2610.61001', title: 'Trapped-ion qubit calibration', agent: 'djimitflo-scout' })).toBe('irrelevant');
  await vi.waitFor(() => expect(db.prepare("SELECT decision FROM judgments WHERE subject_id = 'arxiv:2610.61001'").get()).toEqual({ decision: 'yes' }));
  await new Promise((r) => setTimeout(r, 20));
  expect(units()).toBe(0);
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'true');
  expect(svc.ingestDiscovery({ event_type: 'discovery.paper', ref: 'arxiv:2610.61002', title: 'Trapped-ion qubit calibration II', agent: 'djimitflo-scout' })).toBe('irrelevant');
  await vi.waitFor(() => expect(units()).toBe(1));
  expect(meta('arxiv:2610.61002')).toMatchObject({ derived: 'taxonomy_override:jev', agent: 'djimitflo-scout' });
  const unit = db.prepare("SELECT id, lifecycle_state AS state FROM expert_identities WHERE kind = 'paper'").get() as { id: string; state: string };
  expect(unit.state).toBe('EVIDENCE_COLLECTED'); // no taxonomy capability: it stops before CAPABILITY_INFERRED
  expect(db.prepare("SELECT subject_type, subject_id FROM judgments WHERE decision = 'yes' AND subject_id = ?").get(unit.id)).toEqual({ subject_type: 'expert_unit', subject_id: unit.id });
});

it('KE-2: backfillRejectedOverrides turns existing rejected-but-yes verdicts into units once (not auto-run)', () => {
  busEvent('arxiv:2610.62001', 'Trapped-ion qubit calibration');
  const j = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'discovery_relevance', 'discovery_rejected', ?, 'h', 'shadow', ?, 'r', ?, ?)`);
  j.run('j1', 'arxiv:2610.62001', 'yes', JSON.stringify(ans('open_problem', 0.9, 0.8)), new Date().toISOString());
  j.run('j2', 'arxiv:2610.62002', 'no', JSON.stringify(ans('off_topic', 0.9, 0.1)), new Date().toISOString());
  j.run('j3', 'arxiv:2610.62003', 'yes', JSON.stringify(ans('open_problem', 0.9, 0.8)), new Date().toISOString()); // no bus event: skipped
  const svc = new ExpertSourceUnitsService(db);
  expect(svc.backfillRejectedOverrides()).toEqual({ candidates: 2, created: 1, missing_event: 1, known: 0 });
  expect(meta('arxiv:2610.62001')).toMatchObject({ derived: 'taxonomy_override:jev', backfill: true });
  expect(db.prepare("SELECT subject_type FROM judgments WHERE id = 'j1'").get()).toEqual({ subject_type: 'expert_unit' });
  expect(svc.backfillRejectedOverrides()).toEqual({ candidates: 1, created: 0, missing_event: 1, known: 0 });
});

it('KE-5: errored discovery_relevance judgments are retried once by the tick (bounded), and the retry is recorded', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'k');
  vi.stubEnv('TYPESAFE_DISCOVERY_RELEVANCE_MODE', 'shadow');
  vi.stubEnv('FRONTIER_UNITS_REQUIRE_RELEVANCE', 'true');
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
  vi.stubGlobal('fetch', fetchMock);
  const svc = new ExpertSourceUnitsService(db);
  const a = busEvent('arxiv:2610.63001', 'Mutation-guided test generation for coding agents');
  const b = busEvent('arxiv:2610.63002', 'Mutation-guided program repair for coding agents');
  const c = busEvent('arxiv:2610.63003', 'Trapped-ion qubit calibration');
  for (const e of [a, b, c]) svc.ingestDiscovery(e);
  const errors = () => (db.prepare("SELECT COUNT(*) n FROM judgments WHERE decision = 'error'").get() as { n: number }).n;
  await vi.waitFor(() => expect(errors()).toBe(3));
  // three failures opened the jev breaker: the tick waits instead of burning its one retry
  expect(svc.retryErroredRelevance(50)).toEqual({ retried: 0, skipped: 'jev_busy' });
  resetTypesafeBreaker();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: 'jev-test', answers: ans('lane_technique', 0.9, 0.7) }) });
  expect(svc.retryErroredRelevance(2)).toEqual({ retried: 2 }); // bounded per tick
  expect(svc.retryErroredRelevance(50)).toEqual({ retried: 1 });
  await vi.waitFor(() => expect(db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE kind = 'paper'").get()).toEqual({ n: 3 }));
  expect(db.prepare("SELECT DISTINCT reason FROM judgments WHERE decision = 'error'").all()).toEqual([{ reason: 'retry=1' }]);
  expect(svc.retryErroredRelevance(50)).toEqual({ retried: 0 }); // a verdict now exists
  // a retry that errors again is not retried a second time
  fetchMock.mockResolvedValue({ ok: false, status: 503 });
  svc.ingestDiscovery(busEvent('arxiv:2610.63004', 'Mutation-guided flaky test repair for coding agents'));
  await vi.waitFor(() => expect(errors()).toBe(4));
  expect(svc.retryErroredRelevance(50)).toEqual({ retried: 1 });
  await vi.waitFor(() => expect(errors()).toBe(5));
  expect(svc.retryErroredRelevance(50)).toEqual({ retried: 0 });
});
