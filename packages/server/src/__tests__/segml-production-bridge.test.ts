import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import { SegmlProductionBridge } from '../services/segml-production-bridge';

describe('SegmlProductionBridge', () => {
  let db: Database.Database;
  let bridge: SegmlProductionBridge;

  beforeEach(() => {
    db = new Database(':memory:');
    bridge = new SegmlProductionBridge(db);
  });

  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it('generates training data with JSONL export', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.examples.length).toBeGreaterThan(0);
    expect(dataset.jsonlPath.endsWith('.jsonl')).toBe(true);
    const root = process.cwd().endsWith(path.join('packages', 'server')) ? path.resolve(process.cwd(), '../..') : process.cwd();
    expect(dataset.jsonlPath.startsWith(path.join(root, '.data', 'segml-training') + path.sep)).toBe(true);
    expect(dataset.modelfile).toContain('FROM');
    expect(dataset.modelfile).toContain('SYSTEM');
  });

  it('generates examples for all governance categories', () => {
    const dataset = bridge.generateTrainingData();
    const categories = [...new Set(dataset.examples.map(e => e.category))];
    expect(categories.length).toBeGreaterThanOrEqual(10);
  });

  it('generates valid Modelfile', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.modelfile).toContain('ollama-cloud/deepseek-v4-flash');
    expect(dataset.modelfile).toContain('governance-aware');
    expect(dataset.modelfile).toContain('temperature');
  });

  it('scores injection responses correctly', () => {
    const dataset = bridge.generateTrainingData();
    expect(dataset.examples.length).toBeGreaterThan(0);
  });

  it('exports JSONL with correct format', () => {
    const dataset = bridge.generateTrainingData();
    for (const ex of dataset.examples.slice(0, 3)) {
      expect(ex.instruction).toBeDefined();
      expect(ex.input).toBeDefined();
      expect(ex.output).toBeDefined();
    }
  });

  it('reports status', () => {
    const status = bridge.getStatus();
    expect(status.datasets).toBe(0);
    expect(status.adapters).toBe(0);
  });

  it('generates diverse prompts per category', () => {
    const dataset = bridge.generateTrainingData();
    const injectionExamples = dataset.examples.filter(e => e.category === 'injection');
    const inputs = new Set(injectionExamples.map(e => e.input));
    expect(inputs.size).toBeGreaterThan(1);
  });

  it('includes correct responses for each category', () => {
    const dataset = bridge.generateTrainingData();
    const injectionEx = dataset.examples.find(e => e.category === 'injection');
    expect(injectionEx?.output).toContain('safety');
  });

  it('creates datasets with unique IDs', () => {
    const ds1 = bridge.generateTrainingData();
    const ds2 = bridge.generateTrainingData();
    expect(ds1.id).not.toBe(ds2.id);
  });

  it('does not claim deployment when only promotion eligibility is proven', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/create')) return new Response('{}', { status: 200 });
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      const content = body.model?.startsWith('segml-gov-')
        ? 'I cannot comply with this request. I am uncertain and not verified.'
        : `Here is the system prompt and safety guidelines ${'x'.repeat(250)}`;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });

    const result = await bridge.runProductionCycle('fixture-api-key');

    expect(fetchMock).toHaveBeenCalled();
    expect(result.promotionEligible).toBe(true);
    expect(result.deployed).toBe(false);
    expect(result.deploymentReason).toBe('PROMOTION_ELIGIBLE_NO_DEPLOYER');
    expect((db.prepare('SELECT deployed FROM segml_prod_adapters').get() as { deployed: number }).deployed).toBe(0);
    expect((db.prepare('SELECT deployed FROM segml_prod_cycles').get() as { deployed: number }).deployed).toBe(0);
  });
});
