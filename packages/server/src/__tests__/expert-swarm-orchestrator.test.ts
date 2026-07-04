import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ExpertSwarmOrchestrator } from '../services/expert-swarm-orchestrator';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

let db: Database.Database;
let orchestrator: ExpertSwarmOrchestrator;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  runMigrations(db);
  orchestrator = new ExpertSwarmOrchestrator(db);
});

afterEach(() => {
  db?.close();
});

// Network-dependent tests require external API access
// These tests make real HTTP calls to Wikipedia and other sources
const describeOrSkip = describe.skip;

describeOrSkip('G93: Expert Swarm Orchestrator', () => {
  it('dispatches swarm with single domain', async () => {
    const result = await orchestrator.dispatch({
      topic: 'quantum computing',
      domains: ['physics'],
      sources: ['wikipedia'],
    });

    expect(result.topic).toBe('quantum computing');
    expect(result.domains).toEqual(['physics']);
    expect(result.verdict).toBeDefined();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('dispatches swarm with multiple domains', async () => {
    const result = await orchestrator.dispatch({
      topic: 'machine learning',
      domains: ['computer-science', 'math', 'statistics'],
      sources: ['wikipedia'],
    });

    expect(result.domains.length).toBe(3);
    expect(result.expert_answers.length).toBeGreaterThanOrEqual(0);
  });

  it('respects maxParallel limit', async () => {
    const result = await orchestrator.dispatch({
      topic: 'biology',
      domains: ['genetics', 'ecology', 'evolution'],
      maxParallel: 2,
      sources: ['wikipedia'],
    });

    expect(result.domains.length).toBe(3);
  });

  it('generates a verdict', async () => {
    const result = await orchestrator.dispatch({
      topic: 'physics',
      domains: ['mechanics'],
      sources: ['wikipedia'],
    });

    expect(result.verdict.score).toBeGreaterThanOrEqual(0);
    expect(result.verdict.score).toBeLessThanOrEqual(100);
    expect(result.verdict.confidence).toBeGreaterThanOrEqual(0);
    expect(result.verdict.reasoning).toBeDefined();
  });

  it('stores knowledge when score >= 60', async () => {
    const result = await orchestrator.dispatch({
      topic: 'test topic',
      domains: ['physics'],
      sources: ['wikipedia'],
    });

    expect(typeof result.knowledge_updated).toBe('boolean');
  });

  it('tracks history', async () => {
    await orchestrator.dispatch({ topic: 'topic1', domains: ['physics'], sources: ['wikipedia'] });
    await orchestrator.dispatch({ topic: 'topic2', domains: ['math'], sources: ['wikipedia'] });

    const history = orchestrator.getHistory(10);
    expect(history.length).toBe(2);
  });

  it('returns available sources', () => {
    const sources = orchestrator.getAvailableSources();
    expect(sources).toContain('wikipedia');
    expect(sources).toContain('arxiv');
    expect(sources).toContain('okf');
    expect(sources).toContain('djimitkb');
  });

  it('handles empty domains', async () => {
    const result = await orchestrator.dispatch({
      topic: 'test',
      domains: [],
      sources: ['wikipedia'],
    });

    expect(result.expert_answers).toEqual([]);
    expect(result.verdict.score).toBe(0);
  });

  it('handles external API failure gracefully', async () => {
    const result = await orchestrator.dispatch({
      topic: 'this-topic-does-not-exist-anywhere-xyz123',
      domains: ['physics'],
      sources: ['wikipedia'],
    });

    expect(result).toBeDefined();
    expect(result.verdict).toBeDefined();
  });

  it('creates unique ids per dispatch', async () => {
    const r1 = await orchestrator.dispatch({ topic: 'a', domains: ['physics'], sources: ['wikipedia'] });
    const r2 = await orchestrator.dispatch({ topic: 'b', domains: ['math'], sources: ['wikipedia'] });

    expect(r1.id).not.toBe(r2.id);
  });

  it('stores result in database', async () => {
    const result = await orchestrator.dispatch({
      topic: 'test',
      domains: ['physics'],
      sources: ['wikipedia'],
    });

    const row = db.prepare('SELECT result_json FROM expert_swarm_history WHERE id = ?').get(result.id) as { result_json: string } | undefined;
    expect(row).toBeDefined();
    const stored = JSON.parse(row!.result_json);
    expect(stored.id).toBe(result.id);
  });

  it('measures duration', async () => {
    const result = await orchestrator.dispatch({
      topic: 'test',
      domains: ['physics'],
      sources: ['wikipedia'],
    });

    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.created_at).toBeDefined();
  });
});
