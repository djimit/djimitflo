import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertCouncilService, firstJsonObject, type PerspectiveRunner } from '../services/expert-council-service';
import { ExpertSwarmOrchestrator } from '../services/expert-swarm-orchestrator';

describe('expert council: independent perspectives, claim graph, disagreement, adversary (§16 §17 §18 §19 §57)', () => {
  let db: Database.Database;
  let registry: FrontierExpertRegistryService;
  let evidenceByExpert: Record<string, string[]>;
  let calls: Array<{ role: string; system: string; user: string }>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    registry = new FrontierExpertRegistryService(db);
    registry.seedTaxonomy();
    evidenceByExpert = {};
    calls = [];
  });

  afterEach(() => db.close());

  it('cross-reviews two documented lenses, rejects self-review and invented evidence, and never approves either expert', async () => {
    const target = activate('Ada Example', 'alignment', ['https://example.org/ada']);
    const peer = activate('Grace Example', 'ai_security', ['https://example.org/grace']);
    let badReference = false;
    let uncertain = false;
    let lastSystem = '';
    const council = new ExpertCouncilService(db, { runner: async (_role, system) => { lastSystem = system; return { checks: [{ capability_id: 'alignment', decision: uncertain ? 'uncertain' : 'supported', rationale: 'Assessment within the cited experimental scope.', evidence_refs: [badReference ? 'invented' : evidenceByExpert[target][0]], reviewer_evidence_refs: uncertain ? [] : evidenceByExpert[peer] }] }; } });
    await expect(council.reviewExpert(target, target, 'operator')).rejects.toThrow('EXPERT_SELF_REVIEW_FORBIDDEN');
    const versions = [registry.get(target)!.version, registry.get(peer)!.version];
    const report = await council.reviewExpert(target, peer, 'operator');
    expect(report).toMatchObject({ expert_id: target, reviewer_id: peer, approval_granted: false, runtime: 'injected' });
    expect(report.audit_id).toBeTruthy();
    // reasoning models narrate until the token cap unless told otherwise (prod 2026-09-26: 10 of 10 people)
    expect(lastSystem).toContain('Output ONLY the JSON object');
    expect([registry.get(target)!.version, registry.get(peer)!.version]).toEqual(versions);
    badReference = true;
    await expect(council.reviewExpert(target, peer, 'operator')).rejects.toThrow('EXPERT_REVIEW_EVIDENCE_INVALID');
    badReference = false;
    uncertain = true;
    expect((await council.reviewExpert(target, peer, 'operator')).checks[0].decision).toBe('uncertain');
  });

  function activate(name: string, capability: string, papers: string[]): string {
    const expert = registry.discover({ canonicalName: name, provenance: { source: 'test' }, actor: 'ingestion:test' });
    registry.resolveIdentity(expert.id, { confidence: 0.95, actor: 'resolver' });
    evidenceByExpert[expert.id] = papers.map((url, index) => registry.addEvidence(expert.id, { kind: 'paper', title: `${name} paper ${index}`, sourceRef: url, url, metadata: { abstract: `Abstract ${index} about ${capability}` } }));
    registry.transition(expert.id, 'EVIDENCE_COLLECTED', { actor: 'ingestion:test' });
    registry.inferCapability(expert.id, { capability, confidence: 0.9, evidenceRefs: evidenceByExpert[expert.id], derivedBy: 'test' });
    registry.transition(expert.id, 'CAPABILITY_INFERRED', { actor: 'ingestion:test' });
    registry.transition(expert.id, 'CHECKED', { actor: 'checker' });
    registry.transition(expert.id, 'APPROVED', { actor: 'human' });
    registry.transition(expert.id, 'ACTIVE', { actor: 'human' });
    return expert.id;
  }

  /** Fake model: answers from the evidence ids it is shown; one expert denies what the other asserts; one fabricated ref. */
  const runner: PerspectiveRunner = async (role, system, user) => {
    calls.push({ role, system, user });
    if (role === 'adversary') {
      const ids = [...user.matchAll(/"claim_id": "([^"]+)"/g)].map((match) => match[1]);
      return { attacks: ids.slice(0, 1).map((id) => ({ claim_id: id, attack: 'The evidence is a single lab; external validity untested.', evidence_gap: 'No independent replication.' })).concat([{ claim_id: 'claim:ghost', attack: 'x', evidence_gap: 'y' }]) };
    }
    const shown = [...user.matchAll(/id=(evidence:[a-f0-9]+)/g)].map((match) => match[1]);
    const denies = /Security Expert/.test(system);
    return {
      analysis: denies ? 'The documented threat models show that interpretability alone does not guarantee control.' : 'The documented circuits work suggests interpretability enables control.',
      claims: [
        { subject: 'interpretability', relation: 'enables', object: 'model control', polarity: denies ? 'denies' : 'asserts', evidence_refs: [shown[0]], confidence: denies ? 0.7 : 0.8 },
        { subject: 'timelines', relation: 'reach', object: 'AGI by 2030', polarity: 'asserts', evidence_refs: ['evidence:fabricated'], confidence: 0.9 },
      ],
      uncertainties: [denies ? 'Threat models are adversary-dependent.' : 'Circuits studied are small.'],
      falsification: denies ? 'Show a control protocol that holds under an interpretability-informed attacker.' : 'Find a circuit-level intervention that fails to change behaviour.',
      evidence_refs: shown,
    };
  };

  it('runs perspectives independently, persists evidence-backed claims, preserves disagreement and drops fabricated attribution', async () => {
    const interp = activate('Interp Expert', 'mechanistic_interpretability', ['https://arxiv.org/abs/1', 'https://arxiv.org/abs/2']);
    const security = activate('Security Expert', 'ai_security', ['https://arxiv.org/abs/3']);
    const council = new ExpertCouncilService(db, { registry, runner, runtimeLabel: 'fake' });
    const result = await council.convene('Does mechanistic interpretability enable AI security control of frontier models?', { maxExperts: 3 });

    expect(result.abstained).toBe(false);
    expect(result.perspectives.map((perspective) => perspective.expert_id).sort()).toEqual([interp, security].sort());
    // Independence (§16): no perspective prompt contains another expert's name or evidence.
    const perspectiveCalls = calls.filter((call) => call.role === 'perspective');
    expect(perspectiveCalls).toHaveLength(2);
    for (const call of perspectiveCalls) {
      const mine = /Interp Expert/.test(call.system) ? evidenceByExpert[interp] : evidenceByExpert[security];
      const theirs = mine === evidenceByExpert[interp] ? evidenceByExpert[security] : evidenceByExpert[interp];
      expect(theirs.some((id) => call.user.includes(id))).toBe(false);
      expect(call.user).not.toContain('interpretability enables control'); // never sees the other analysis
      expect(call.system).toContain('You are NOT this person');
    }
    // Claims: fabricated refs dropped (I15), the rest persisted with evidence lineage (I07).
    expect(result.claims).toHaveLength(2);
    expect(result.perspectives.every((perspective) => perspective.dropped_claims === 1 && perspective.dropped_refs.includes('evidence:fabricated'))).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM expert_claims').get() as { n: number }).n).toBe(2);
    expect(result.unsupported_attribution_count).toBe(0);
    // Disagreement preserved, not averaged away (§19), with both evidence sides and a resolving observation.
    expect(result.relations).toEqual([expect.objectContaining({ relation: 'CONTRADICTS' })]);
    expect(result.disagreements).toHaveLength(1);
    expect(result.disagreements[0]).toMatchObject({ proposition: 'interpretability | enables | model control' });
    expect(result.disagreements[0].evidence_a).toHaveLength(1);
    expect(result.disagreements[0].resolving_observation.length).toBeGreaterThan(10);
    expect(result.uncertainties).toHaveLength(2);
    // Adversary attacked a real claim; the ghost claim id was ignored.
    expect(result.adversarial?.attacks).toHaveLength(1);
    expect(result.claims.map((claim) => claim.id)).toContain(result.adversarial!.attacks[0].claim_id);
    expect(calls.filter((call) => call.role === 'adversary')[0].system).toContain('you have no tools');
  });

  it('abstains without a configured runtime and integrates with the swarm orchestrator under the flag', async () => {
    activate('Interp Expert', 'mechanistic_interpretability', ['https://arxiv.org/abs/1']);
    const silent = new ExpertCouncilService(db, { registry });
    const blocked = await silent.convene('mechanistic interpretability of circuits');
    expect(blocked).toMatchObject({ abstained: true, reason: 'FRONTIER_EXPERTS_RUNTIME_NOT_CONFIGURED' });

    const council = new ExpertCouncilService(db, { registry, runner, runtimeLabel: 'fake' });
    const orchestrator = new ExpertSwarmOrchestrator(db, { council });
    // Flag off and no force: expertSelection is ignored and the legacy path runs (no adapters → insufficient evidence).
    delete process.env.DJIMITFLO_FRONTIER_EXPERTS_ENABLED;
    const legacy = await orchestrator.dispatch({ topic: 'mechanistic interpretability of circuits', domains: ['x'], sources: ['nope'], expertSelection: { maxExperts: 2 } });
    expect(legacy.council).toBeUndefined();
    expect(legacy.promotion_decision).toBe('INSUFFICIENT_EVIDENCE');

    const frontier = await orchestrator.dispatch({ topic: 'mechanistic interpretability of circuits', domains: [], expertSelection: { maxExperts: 2, force: true } });
    expect(frontier.council?.abstained).toBe(false);
    expect(frontier.expert_answers).toHaveLength(1);
    expect(frontier.expert_answers[0].source).toBe('frontier-expert');
    expect(frontier.promotion_decision).toBe('HUMAN_REVIEW_REQUIRED');
    expect(frontier.knowledge_candidate_id).toBeTruthy();
    const candidate = db.prepare('SELECT metadata FROM memory_candidates WHERE id = ?').get(frontier.knowledge_candidate_id) as { metadata: string };
    expect(JSON.parse(candidate.metadata).answers[0].expert_id).toBe(frontier.council!.perspectives[0].expert_id);

    const abstain = await orchestrator.dispatch({ topic: 'best risotto recipe', domains: [], expertSelection: { force: true } });
    expect(abstain.council).toMatchObject({ abstained: true, reason: 'no_capability_match' });
    expect(abstain.promotion_decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(abstain.knowledge_updated).toBe(false);
  });

  it('marks a disagreeing council as contradicted so nothing reaches the review queue unresolved (I08)', async () => {
    activate('Interp Expert', 'mechanistic_interpretability', ['https://arxiv.org/abs/1']);
    activate('Security Expert', 'ai_security', ['https://arxiv.org/abs/3']);
    const orchestrator = new ExpertSwarmOrchestrator(db, { council: new ExpertCouncilService(db, { registry, runner, runtimeLabel: 'fake' }) });
    const result = await orchestrator.dispatch({ topic: 'Does mechanistic interpretability enable AI security control?', domains: [], expertSelection: { force: true, maxExperts: 3 } });
    expect(result.council?.disagreements).toHaveLength(1);
    expect(result.promotion_decision).toBe('CONTRADICTED');
    expect(result.knowledge_updated).toBe(false);
    expect(result.verdict.contradictions.some((item) => item.startsWith('Council disagreement'))).toBe(true);
  });
});

describe('firstJsonObject (prod 2026-09-26: 43 of 50 reviews failed on model output shape)', () => {
  it('skips a think block, an echoed schema example and trailing prose', () => {
    const answer = '<think>plan: {"draft": true}</think>Schema: {"checks":[...]}\nHere you go:\n{"checks":[{"capability_id":"a","rationale":"uses } and { in text"}]}\nHope this helps {x}.';
    expect(firstJsonObject(answer)).toEqual({ checks: [{ capability_id: 'a', rationale: 'uses } and { in text' }] });
  });
  it('returns null when no object parses', () => {
    expect(firstJsonObject('no json {here')).toBeNull();
    expect(firstJsonObject('[1,2]')).toBeNull();
  });
});
