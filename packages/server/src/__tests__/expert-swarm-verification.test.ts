import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ExpertSwarmOrchestrator } from '../services/expert-swarm-orchestrator';
import { JudgeService, type ExpertAnswer } from '../services/judge-service';
import { KnowledgeAdapterRegistry } from '../services/knowledge-adapters';
import type { KnowledgeResult, KnowledgeSourceAdapter } from '../services/knowledge-adapters/types';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';

/** Offline adapter: evidence-backed results without network. */
function adapter(name: string, results: Array<Partial<KnowledgeResult> & { content: string }>): KnowledgeSourceAdapter {
  return {
    name,
    async search() { return results.map((result, index) => ({ id: `${name}:${index}`, title: result.title ?? `${name} ${index}`, content: result.content, source: name, url: result.url ?? `https://example.org/${name}/${index}`, confidence: result.confidence ?? 0.8, metadata: {} })); },
    async fetch() { return null; },
    async isAvailable() { return true; },
  };
}

describe('expert swarm verification dead end (spec §21)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
  });

  afterEach(() => db.close());

  it('heuristic judge never produces verified or VERIFIED_FOR_USE on its own (I14)', () => {
    const judge = new JudgeService(db);
    const strong: ExpertAnswer[] = Array.from({ length: 4 }, (_, index) => ({
      domain: `domain-${index}`, source: 'arxiv', confidence: 0.99,
      content: `Peer-reviewed measurements show consistent scaling behaviour across ${index + 3} independent replications with narrow error bars.`,
      evidence_refs: [`arxiv:250${index}.0000${index}`, `arxiv:250${index}.0001${index}`],
    }));
    const verdict = judge.evaluate(strong);
    expect(verdict.verification_status).not.toBe('verified');
    expect(verdict.promotion_decision).not.toBe('VERIFIED_FOR_USE');
    expect(verdict.promotion_decision).toBe('HUMAN_REVIEW_REQUIRED');
    expect(verdict.score_kind).toBe('heuristic');
    expect(judge.evaluate([]).promotion_decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(judge.decidePromotion(90, ['a contradicts b'], strong)).toBe('CONTRADICTED');
    expect(judge.decidePromotion(90, [], [{ domain: 'x', source: 'none', confidence: 0.1, content: 'nothing found', evidence_refs: [] }])).toBe('INSUFFICIENT_EVIDENCE');
    expect(judge.decidePromotion(10, [], strong)).toBe('UNVERIFIABLE');
  });

  it('records evidence-backed swarm output as a governed review candidate instead of dropping it', async () => {
    const registry = new KnowledgeAdapterRegistry(db);
    registry.register('offline-arxiv', adapter('offline-arxiv', [
      { title: 'Scaling laws for neural language models', content: 'Loss follows a power law in compute, data and parameters across several orders of magnitude.', confidence: 0.9 },
    ]));
    const orchestrator = new ExpertSwarmOrchestrator(db, { registry });
    const result = await orchestrator.dispatch({ topic: 'scaling laws', domains: ['scaling_laws', 'frontier_model_engineering'], sources: ['offline-arxiv'] });

    expect(result.expert_answers).toHaveLength(2);
    expect(result.verdict.verification_status).toBe('pending');
    expect(result.promotion_decision).toBe('HUMAN_REVIEW_REQUIRED');
    expect(result.knowledge_updated).toBe(true);
    expect(result.knowledge_candidate_id).toBeTruthy();

    const candidate = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(result.knowledge_candidate_id) as Record<string, any>;
    expect(candidate).toMatchObject({ memory_type: 'operational_memory', store: 'semantic', status: 'review_required', promotion_status: 'blocked_pending_human', human_required: 1, source_ref: `expert-swarm:${result.id}` });
    const metadata = JSON.parse(candidate.metadata);
    expect(metadata.judge.verdict_id).toBe(result.verdict.id);
    expect(metadata.judge.promotion_decision).toBe('HUMAN_REVIEW_REQUIRED');
    expect(metadata.answers.every((answer: { evidence_refs: string[] }) => answer.evidence_refs.length > 0)).toBe(true);
    expect(metadata.promotion_allowed).toBe(false);
    // I07/I08-style guard: nothing the swarm writes is promoted by itself.
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_candidates WHERE status = 'promoted' OR promotion_status = 'promoted'").get()).toEqual({ n: 0 });
  });

  it('keeps contradicted and evidence-free output out of the review queue', async () => {
    const registry = new KnowledgeAdapterRegistry(db);
    // One source, two domains, opposite findings: the query carries the domain, so each domain gets its own claim.
    registry.register('split', {
      name: 'split',
      async search(query: string) {
        const negated = query.includes('reinforcement_learning');
        return [{ id: `split:${negated ? 'contra' : 'pro'}`, title: 'sample efficiency', source: 'split', confidence: 0.8, url: 'https://example.org/split', metadata: {},
          content: negated ? 'Larger models are not more sample efficient than smaller ones.' : 'Larger models are more sample efficient than smaller ones.' }];
      },
      async fetch() { return null; },
      async isAvailable() { return true; },
    });
    registry.register('empty', { name: 'empty', async search() { return []; }, async fetch() { return null; }, async isAvailable() { return true; } });
    const orchestrator = new ExpertSwarmOrchestrator(db, { registry });

    const contradicted = await orchestrator.dispatch({ topic: 'sample efficiency', domains: ['scaling_laws', 'reinforcement_learning'], sources: ['split'] });
    expect(contradicted.verdict.contradictions.length).toBeGreaterThan(0);
    expect(contradicted.promotion_decision).toBe('CONTRADICTED');
    expect(contradicted.knowledge_updated).toBe(false);

    const empty = await orchestrator.dispatch({ topic: 'unknown topic', domains: ['ai_policy'], sources: ['empty'] });
    expect(empty.promotion_decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(empty.knowledge_updated).toBe(false);
    expect(empty.knowledge_candidate_id).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_candidates').get()).toEqual({ n: 0 });
  });
});
