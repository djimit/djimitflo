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
