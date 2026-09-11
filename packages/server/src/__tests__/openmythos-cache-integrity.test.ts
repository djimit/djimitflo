import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from './helpers/test-db';
import { OpenMythosEvalService } from '../services/openmythos-eval-service';

let directory: string;
let db: ReturnType<typeof createTestDb>;
let service: OpenMythosEvalService;
let corpus: string;
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const fixtureCase = { id: 'fixture-001', category: 'injection', subcategory: 'basic', difficulty: 1, prompt: 'Original fixture prompt', expected_behavior: 'Refuse', failure_mode: 'compliance', rationale: 'Fixture' };
const anchor = { case_id: fixtureCase.id, oracle_type: 'exact_scalar', rule: { expected: 'original' } };
const anchors = () => (service as unknown as { loadAnchors(): Map<string, typeof anchor> }).loadAnchors();

function writeManifest(content = corpus) {
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema_version: 1, corpus_version: 'fixture', case_count: 1, sha256: hash(content), certification_ready: false }));
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'djimitflo-openmythos-cache-'));
  db = createTestDb();
  corpus = JSON.stringify(fixtureCase) + '\n';
  writeFileSync(join(directory, 'corpus.jsonl'), corpus); writeManifest();
  vi.stubEnv('OPENMYTHOS_CORPUS_PATH', join(directory, 'corpus.jsonl'));
  vi.stubEnv('OPENMYTHOS_CORPUS_MANIFEST_PATH', join(directory, 'manifest.json'));
  vi.stubEnv('OPENMYTHOS_ORACLE_ANCHORS_PATH', join(directory, 'anchors.json'));
  writeFileSync(join(directory, 'anchors.json'), JSON.stringify({ schema_version: 1, anchors: [anchor] }));
  vi.stubEnv('OPENMYTHOS_SUBJECT_MODEL_DIGEST', 'fixture-subject-digest');
  vi.stubEnv('OPENMYTHOS_USE_JUDGE_SERVICE', 'false');
  vi.stubEnv('OPENMYTHOS_JUDGE_MODEL_DIGEST', 'fixture-judge-digest');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Provider access forbidden in cache test'); }));
  service = new OpenMythosEvalService(db);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  db.close(); rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it.each(['hash', 'count', 'json', 'missing'])('failed manifest %s validation never publishes a usable cache and can recover after repair', failure => {
  const path = join(directory, 'manifest.json');
  if (failure === 'missing') unlinkSync(path);
  else writeFileSync(path, failure === 'json' ? '{' : JSON.stringify({ schema_version: 1, case_count: failure === 'count' ? 2 : 1, sha256: failure === 'hash' ? 'mismatch' : hash(corpus) }));
  expect(() => service.loadCases()).toThrow();
  expect(() => service.loadCases()).toThrow();
  writeManifest();
  expect(service.loadCases()).toHaveLength(1);
});

it.each(['schema', 'duplicate', 'entry', 'json', 'missing'])('failed oracle %s validation never becomes partial oracle or silent judge fallback', failure => {
  const path = join(directory, 'anchors.json');
  if (failure === 'missing') unlinkSync(path);
  else writeFileSync(path, failure === 'json' ? '{' : JSON.stringify({ schema_version: failure === 'schema' ? 99 : 1, anchors: failure === 'duplicate' ? [anchor, anchor] : failure === 'entry' ? [anchor, {}] : [anchor] }));
  expect(anchors).toThrow(); expect(anchors).toThrow();
  writeFileSync(path, JSON.stringify({ schema_version: 1, anchors: [anchor] }));
  expect(anchors().get(fixtureCase.id)).toEqual(anchor);
});

it('keeps cached corpus and anchor bytes bound to persisted provenance when source files change', async () => {
  const originalAnchorBytes = JSON.stringify({ schema_version: 1, anchors: [anchor] });
  service.loadCases(); anchors();
  const changedCorpus = JSON.stringify({ ...fixtureCase, prompt: 'Changed source after initial load' }) + '\n';
  writeFileSync(join(directory, 'corpus.jsonl'), changedCorpus); writeManifest(changedCorpus);
  writeFileSync(join(directory, 'anchors.json'), JSON.stringify({ schema_version: 1, anchors: [{ ...anchor, rule: { expected: 'changed' } }] }));
  expect(service.loadCases()[0].prompt).toBe(fixtureCase.prompt);
  expect(anchors().get(fixtureCase.id)?.rule.expected).toBe('original');
  // No agent or judge execution: empty worker results deliberately yield a
  // failed run; only its source provenance is under test.
  const pool = (service as unknown as { workerPool: { execute(...args: unknown[]): Promise<unknown[]> } }).workerPool;
  vi.spyOn(pool, 'execute').mockResolvedValue([]);
  const result = await service.runEval('fixture-agent', undefined, 'fixture-model', [fixtureCase.id]);
  expect(result.status).toBe('failed');
  const row = db.prepare('SELECT metadata FROM openmythos_eval_runs WHERE id=?').get(result.id) as { metadata: string };
  expect(JSON.parse(row.metadata)).toMatchObject({ corpus_sha256: hash(corpus), oracle_anchors_sha256: hash(originalAnchorBytes), corpus_certification_ready: false });
  expect(new OpenMythosEvalService(db).loadCases()[0].prompt).toBe('Changed source after initial load');
});

it('does not let a loadCases consumer rewrite subsequent cached prompts or add unvalidated cases', () => {
  const loaded = service.loadCases();
  try { loaded[0].prompt = 'Caller rewrite'; } catch { /* frozen data is also acceptable */ }
  try { loaded.push({ ...fixtureCase, id: 'fixture-002' }); } catch { /* frozen array is also acceptable */ }
  expect(service.loadCases()).toHaveLength(1);
  expect(service.loadCases()[0].prompt).toBe(fixtureCase.prompt);
});

it('queries prior discrimination evidence using the cached corpus hash, not a changed file', () => {
  const second = { ...fixtureCase, id: 'fixture-002' };
  const original = [fixtureCase, second].map(value => JSON.stringify(value)).join('\n');
  writeFileSync(join(directory, 'corpus.jsonl'), original);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ schema_version: 1, case_count: 2, sha256: hash(original) }));
  const cases = service.loadCases();
  for (let index = 0; index < 3; index++) {
    db.prepare('INSERT INTO openmythos_eval_runs(id,agent_id,status,metadata) VALUES (?,?,?,?)').run(`prior-${index}`, 'fixture-agent', 'completed', JSON.stringify({ corpus_sha256: hash(original), subject_model: index ? 'strong' : 'weak' }));
    db.prepare('INSERT INTO openmythos_case_results(id,run_id,case_id,category,judge_score,status) VALUES (?,?,?,?,?,?)').run(`result-${index}`, `prior-${index}`, fixtureCase.id, 'injection', index ? 5 : 1, 'completed');
  }
  writeFileSync(join(directory, 'corpus.jsonl'), 'changed-after-snapshot');
  expect(service.filterDiscriminatingCases(cases).map(value => value.id)).toEqual([fixtureCase.id]);
});
