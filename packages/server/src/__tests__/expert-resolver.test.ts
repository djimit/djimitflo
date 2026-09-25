import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { DEFAULT_RESOLVER_WEIGHTS, ExpertResolverService, tokenize } from '../services/expert-resolver-service';

describe('expert resolver (§12 §13 §14 §23 §53)', () => {
  let db: Database.Database;
  let registry: FrontierExpertRegistryService;
  let resolver: ExpertResolverService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    registry = new FrontierExpertRegistryService(db);
    registry.seedTaxonomy();
    resolver = new ExpertResolverService(db);
  });

  afterEach(() => db.close());

  /** Bring an expert to ACTIVE with the given capability and evidence items. */
  function activate(name: string, capability: string, evidence: Array<{ kind: 'paper' | 'institutional_page' | 'secondary' | 'scholarly_metadata'; url: string; title?: string; retrievedAt?: string }>, confidence = 0.9): string {
    const expert = registry.discover({ canonicalName: name, provenance: { source: 'test' }, actor: 'ingestion:test' });
    registry.resolveIdentity(expert.id, { confidence, actor: 'resolver' });
    const refs = evidence.map((item) => registry.addEvidence(expert.id, { kind: item.kind, title: item.title ?? `${name} ${item.kind}`, sourceRef: item.url, url: item.url, retrievedAt: item.retrievedAt }));
    registry.transition(expert.id, 'EVIDENCE_COLLECTED', { actor: 'ingestion:test' });
    const qualifying = refs.filter((_ref, index) => evidence[index].kind !== 'secondary');
    registry.inferCapability(expert.id, { capability, confidence: 0.85, evidenceRefs: qualifying, derivedBy: 'test' });
    registry.transition(expert.id, 'CAPABILITY_INFERRED', { actor: 'ingestion:test' });
    registry.transition(expert.id, 'CHECKED', { actor: 'checker' });
    registry.transition(expert.id, 'APPROVED', { actor: 'human' });
    registry.transition(expert.id, 'ACTIVE', { actor: 'human' });
    return expert.id;
  }

  it('matches capabilities from ids, labels and aliases and abstains when nothing matches', () => {
    expect(tokenize('How do scaling laws and RLHF interact?')).toEqual(['scaling', 'laws', 'rlhf', 'interact']);
    const matched = resolver.matchCapabilities('How do scaling laws and RLHF interact with mechanistic interpretability?');
    expect(matched.map((item) => item.id).slice(0, 3)).toEqual(expect.arrayContaining(['scaling_laws', 'reinforcement_learning', 'mechanistic_interpretability']));
    const none = resolver.resolve('What is the best risotto recipe?');
    expect(none).toMatchObject({ abstained: true, reason: 'no_capability_match', experts: [] });
    const noExperts = resolver.resolve('Explain scaling laws');
    expect(noExperts).toMatchObject({ abstained: true, reason: 'no_expert_for_capabilities' });
  });

  it('I13: an obscure but relevant researcher outranks a famous but irrelevant one', () => {
    const famous = activate('Famous Person', 'ai_policy', [
      { kind: 'paper', url: 'https://arxiv.org/abs/1' }, { kind: 'paper', url: 'https://arxiv.org/abs/2' }, { kind: 'paper', url: 'https://arxiv.org/abs/3' },
      { kind: 'institutional_page', url: 'https://bigcorp.example/leadership' }, { kind: 'secondary', url: 'https://news.example/profile' }, { kind: 'secondary', url: 'https://mag.example/cover' },
    ], 0.99);
    const obscure = activate('Obscure Researcher', 'mechanistic_interpretability', [{ kind: 'paper', url: 'https://arxiv.org/abs/9', title: 'Superposition and polysemantic neurons' }], 0.85);
    const result = resolver.resolve('Which circuits explain polysemantic neurons in mechanistic interpretability?');
    expect(result.abstained).toBe(false);
    expect(result.experts[0].expert_id).toBe(obscure);
    expect(result.experts[0].why_selected).toContain('mechanistic_interpretability');
    expect(result.experts.map((expert) => expert.expert_id)).not.toContain(famous);
    // Weights are visible and configurable; a fame feature does not exist.
    expect(Object.keys(result.weights).sort()).toEqual(Object.keys(DEFAULT_RESOLVER_WEIGHTS).sort());
    expect(JSON.stringify(result.weights)).not.toMatch(/fame|follower|prestige/);
  });

  it('§23/I11: three secondary references and duplicated origins do not outweigh one primary source', () => {
    const laundered = activate('Laundered Expert', 'alignment', [
      { kind: 'scholarly_metadata', url: 'https://index.example/a' },
      { kind: 'secondary', url: 'https://blog.example/copy1' }, { kind: 'secondary', url: 'https://blog.example/copy2' }, { kind: 'secondary', url: 'https://blog.example/copy3' },
    ]);
    const primary = activate('Primary Expert', 'alignment', [{ kind: 'paper', url: 'https://arxiv.org/abs/42', title: 'Scalable oversight through debate' }]);
    const result = resolver.resolve('Does debate provide scalable oversight for alignment?');
    expect(result.experts[0].expert_id).toBe(primary);
    const launderedScore = result.experts.find((expert) => expert.expert_id === laundered);
    expect(launderedScore?.components.evidence_quality ?? 0).toBeLessThan(result.experts[0].components.evidence_quality);
    // Secondary evidence never enters the evidence set that scores an expert.
    expect(launderedScore?.evidence.every((item) => item.kind !== 'secondary') ?? true).toBe(true);
  });

  it('prefers a heterogeneous council and explains every pick', () => {
    activate('Interp One', 'mechanistic_interpretability', [{ kind: 'paper', url: 'https://arxiv.org/abs/10' }]);
    activate('Interp Two', 'mechanistic_interpretability', [{ kind: 'paper', url: 'https://arxiv.org/abs/11' }]);
    activate('Security One', 'ai_security', [{ kind: 'paper', url: 'https://arxiv.org/abs/12' }]);
    const result = resolver.resolve('How does mechanistic interpretability inform AI security evaluations?', { maxExperts: 2 });
    expect(result.experts).toHaveLength(2);
    expect(new Set(result.experts.flatMap((expert) => expert.capabilities.map((capability) => capability.id))).size).toBe(2);
    expect(result.experts.every((expert) => expert.why_selected.length > 20)).toBe(true);
    expect(result.considered).toBe(3);
  });

  it('honours AS OF, floors and explicit restrictions', () => {
    const recent = activate('Recent', 'scaling_laws', [{ kind: 'paper', url: 'https://arxiv.org/abs/20', retrievedAt: '2026-06-01T00:00:00Z' }]);
    const old = activate('Old', 'scaling_laws', [{ kind: 'paper', url: 'https://arxiv.org/abs/21', retrievedAt: '2019-01-01T00:00:00Z' }]);
    const now = resolver.resolve('scaling laws for compute-optimal training');
    expect(now.experts[0].expert_id).toBe(recent);
    const asOf2020 = resolver.resolve('scaling laws for compute-optimal training', { asOf: '2020-01-01T00:00:00Z' });
    expect(asOf2020.experts.map((expert) => expert.expert_id)).toEqual([old]);
    expect(resolver.resolve('scaling laws', { expertIds: [old] }).experts.map((expert) => expert.expert_id)).toEqual([old]);
    expect(resolver.resolve('scaling laws', { minScore: 99 })).toMatchObject({ abstained: true, reason: 'no_expert_above_floor' });
    expect(new ExpertResolverService(db, { temporal_relevance: 0 }).weights.temporal_relevance).toBe(0);
  });
});
