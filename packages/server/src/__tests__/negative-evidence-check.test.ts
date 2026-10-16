import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SelfImprovementService } from '../services/self-improvement-service';
import { dreamOnce } from '../services/dream-evolution';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertSourceUnitsService } from '../services/expert-source-units-service';
import { buildEvolutionEvidence } from '../services/evolution-evidence';
import { checkNegativeEvidence, loadNegativeEvidence } from '../services/negative-evidence-check';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = OFF'); db.exec(schema); runMigrations(db); });
afterEach(() => { vi.unstubAllEnvs(); db.close(); });

const matches = () => db.prepare("SELECT subject_type, subject_id, state_hash, mode, decision, answers_json FROM judgments WHERE judgment = 'negative_evidence_match' ORDER BY state_hash")
  .all() as Array<{ subject_type: string; subject_id: string; state_hash: string; mode: string; decision: string; answers_json: string }>;
const reflect = (svc: SelfImprovementService, text: string) => svc.generateFromReflection({ whatFailed: ['x'], lessonsLearned: ['lesson'], proposedImprovements: [text] });

describe('checkNegativeEvidence', () => {
  it('reads the registry and matches a forbidden code pattern exactly and a match term as a whole word', () => {
    expect(loadNegativeEvidence()?.length).toBeGreaterThan(5);
    const exact = checkNegativeEvidence('Store the agent memory in zep-cloud for recall', { source: 'proposal' });
    expect(exact).toEqual([expect.objectContaining({ entry_id: 'NE-010', matched: 'zep-cloud', confidence: 'exact_pattern', verdict: 'REJECT' })]);
    expect(exact[0].reopen_condition).toMatch(/pre-registered/);
    expect(checkNegativeEvidence('Run a mirofish swarm simulation to forecast merges', { source: 'proposal' }))
      .toEqual([expect.objectContaining({ entry_id: 'NE-010', matched: 'MiroFish', confidence: 'keyword' })]);
  });

  it('does not match unrelated text, a term inside a longer word, or a case-changed code pattern', () => {
    expect(checkNegativeEvidence('Add a unit test for approval-service expiry handling', { source: 'proposal' })).toEqual([]);
    expect(checkNegativeEvidence('the mirofisher package', { source: 'proposal' })).toEqual([]);
    expect(checkNegativeEvidence('ZEP-CLOUD', { source: 'proposal' })).toEqual([]);
    expect(checkNegativeEvidence('MiroFish', { source: 'proposal', entries: null })).toEqual([]); // registry unknown → no claim
  });
});

describe('NE_GENERATOR_CHECK_MODE', () => {
  it('shadow: a proposal naming a forbidden pattern records a match with entry id + reopen condition and is itself unchanged', () => {
    vi.stubEnv('NE_GENERATOR_CHECK_MODE', 'shadow');
    const svc = new SelfImprovementService(db);
    const [p] = reflect(svc, 'Adopt MiroFish social simulation to predict which proposals verify');
    const [m] = matches();
    expect(m).toMatchObject({ subject_type: 'self_improvement', subject_id: p.id, state_hash: 'NE-010', mode: 'shadow', decision: 'match' });
    expect(JSON.parse(m.answers_json)).toMatchObject({ entry_id: 'NE-010', source: 'proposal', confidence: 'keyword', reopen_condition: expect.stringContaining('pre-registered') });
    expect(svc.getImprovement(p.id)).toMatchObject({ title: p.title, description: p.description, status: p.status }); // never altered
    reflect(svc, 'Add a unit test for approval-service expiry handling');
    expect(matches()).toHaveLength(1); // unrelated text: nothing
  });

  it('off (default): nothing is recorded', () => {
    reflect(new SelfImprovementService(db), 'Adopt MiroFish social simulation to predict which proposals verify');
    expect(matches()).toEqual([]);
  });

  it('shadow: a dream mutant naming a registry entry records a match on the genome', async () => {
    vi.stubEnv('NE_GENERATOR_CHECK_MODE', 'shadow'); vi.stubEnv('DREAM_EVOLUTION_ENABLED', 'true');
    db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, findings_json, plan_json, gates_json, next_actions_json, metadata, created_at, updated_at)
      VALUES ('f1', 'evolution-gym', 'closed', 'completed', '[]', '{}', '[]', '[]', ?, ?, ?)`)
      .run(JSON.stringify({ gym: { commit: 'c1', source: 'packages/server/src/services/x.ts' }, gym_result: { status: 'failure', reason: 'red' } }), '2026-10-01T01:00:00Z', '2026-10-01T01:00:00Z');
    const { created } = await dreamOnce(db, Date.parse('2026-10-01T02:00:00Z'), async () =>
      '{"mutants":[{"gene":"strategy_lines","lines":["Sketch the fix like a Pheromind swarm would."],"rationale":"red"},{"gene":"strategy_lines","lines":["Read the assertion first."],"rationale":"red"}]}');
    expect(created).toHaveLength(2);
    expect(matches()).toEqual([expect.objectContaining({ subject_type: 'maker_genome', subject_id: created[0], state_hash: 'NE-011' })]);
  });

  it('shadow: a discovery unit naming a registry entry records a match on the unit, admission unchanged', () => {
    vi.stubEnv('NE_GENERATOR_CHECK_MODE', 'shadow');
    new FrontierExpertRegistryService(db).seedTaxonomy();
    const svc = new ExpertSourceUnitsService(db);
    expect(svc.ingestDiscovery({ event_type: 'discovery.repository', ref: 'github:666ghj/MiroFish', title: 'Scalable oversight toolkit', agent: 'eve-v' })).toBe('unit');
    expect(svc.ingestDiscovery({ event_type: 'discovery.repository', ref: 'github:Org/Oversight-Kit', title: 'Scalable oversight toolkit', agent: 'eve-v' })).toBe('unit');
    expect(matches()).toEqual([expect.objectContaining({ subject_type: 'expert_unit', state_hash: 'NE-010' })]);
  });

  it('evolution evidence: matches per entry per source, and matched proposals that later verified', () => {
    vi.stubEnv('NE_GENERATOR_CHECK_MODE', 'shadow');
    const svc = new SelfImprovementService(db);
    const [a] = reflect(svc, 'Adopt MiroFish social simulation to predict which proposals verify');
    reflect(svc, 'Wire zep-cloud memory and a MiroFish run into discovery');
    db.prepare("UPDATE self_improvements SET status = 'verified' WHERE id = ?").run(a.id);
    const ne = buildEvolutionEvidence(db, process.env).negative_evidence;
    expect(ne.mode).toBe('shadow');
    expect(ne.by_entry).toEqual([
      { entry_id: 'NE-010', source: 'proposal', confidence: 'exact_pattern', matches: 1, subjects: 1 },
      { entry_id: 'NE-010', source: 'proposal', confidence: 'keyword', matches: 1, subjects: 1 },
    ]);
    expect(ne.proposals).toEqual({ matched: 2, verified: 1, regressed: 0, settled: 1, verified_share: 1 });
  });
});
