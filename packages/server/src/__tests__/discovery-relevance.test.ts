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
