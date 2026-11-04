import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTestDb } from './helpers/test-db';
import { SkillEvolutionEngine } from '../services/skill-evolution-engine';
import { SkillLoaderService } from '../services/skill-loader-service';
import { SkillArtifactEvolutionService } from '../services/skill-artifact-evolution-service';
import { ExecutionEngine } from '../execution/execution-engine';

const envKeys = ['OPENMYTHOS_CORPUS_PATH', 'OPENMYTHOS_CORPUS_MANIFEST_PATH', 'OPENMYTHOS_ORACLE_ANCHORS_PATH', 'OPENMYTHOS_SUBJECT_MODEL_DIGEST',
  'OPENMYTHOS_JUDGE_MODEL_DIGEST', 'OPENMYTHOS_JUDGE_MODEL', 'OPENMYTHOS_USE_JUDGE_SERVICE', 'DJIMITFLO_BUILD_SHA', 'SKILL_ARTIFACT_EVOLUTION_MODE'];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let db: ReturnType<typeof createTestDb>;
let root: string;
beforeEach(() => {
  db = createTestDb();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-artifact-evolution-'));
  process.env.SKILL_ARTIFACT_EVOLUTION_MODE = 'on';
});
afterEach(() => {
  db.close(); fs.rmSync(root, { recursive: true, force: true });
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** A SKILL.md skill with a verified delivered source outcome, a certified baseline evaluation and a pinned 30-case corpus. */
function fixture() {
  new SkillEvolutionEngine(db);
  const skillDir = path.join(root, 'skills', 'test-skill'); fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: fixture\n---\nUse one check.\n');
  fs.writeFileSync(path.join(skillDir, 'skill.manifest.yaml'), 'skill_id: test-skill\nversion: 1.0.0\nowner: tests\nallowed_tools: [Read]\n');
  const skillsDir = path.join(root, 'skills');
  const loader = new SkillLoaderService(db, skillsDir);
  const baseline = loader.getSkill('test-skill')!;
  const service = new SkillArtifactEvolutionService(db);
  const cases = Array.from({ length: 30 }, (_, index) => ({ id: `test-${String(index + 1).padStart(3, '0')}`,
    category: 'fixture', subcategory: 'comparison', difficulty: 1, prompt: 'fixture prompt',
    expected_behavior: 'fixture expected', failure_mode: 'fixture failure', rationale: 'fixture rationale' }));
  const corpusPath = path.join(root, 'corpus.jsonl');
  const corpusContent = cases.map((item) => JSON.stringify(item)).join('\n');
  fs.writeFileSync(corpusPath, corpusContent);
  const corpusHash = createHash('sha256').update(corpusContent).digest('hex');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema_version: 1, corpus_version: 'fixture-v1', case_count: 30,
    corpus_path: 'corpus.jsonl', sha256: corpusHash, certification_ready: true }));
  const anchorsPath = path.join(root, 'anchors.json');
  fs.writeFileSync(anchorsPath, JSON.stringify({ schema_version: 1, anchors: [{ case_id: 'test-001', oracle_type: 'required_text', rule: { expected: 'safe' } }] }));
  const anchorHash = createHash('sha256').update(fs.readFileSync(anchorsPath)).digest('hex');
  Object.assign(process.env, { OPENMYTHOS_CORPUS_PATH: corpusPath, OPENMYTHOS_CORPUS_MANIFEST_PATH: path.join(root, 'manifest.json'),
    OPENMYTHOS_ORACLE_ANCHORS_PATH: anchorsPath, OPENMYTHOS_SUBJECT_MODEL_DIGEST: 'm'.repeat(64),
    OPENMYTHOS_JUDGE_MODEL_DIGEST: 'j'.repeat(64), OPENMYTHOS_JUDGE_MODEL: 'fixture-oracle',
    OPENMYTHOS_USE_JUDGE_SERVICE: 'false', DJIMITFLO_BUILD_SHA: 'build-fixture' });
  const evolution = new SkillEvolutionEngine(db);
  // an assigned-but-undelivered and a delivered-but-unverified success never qualify as a source outcome
  evolution.recordOutcome(baseline.id, { taskId: 'assigned-task', success: true, tokensUsed: null, durationMs: 1, domain: 'fixture',
    skillVersion: baseline.version, skillContentHash: baseline.contentHash, evidenceRefs: ['skill_delivery:assigned', 'verification:test_result:passed'] });
  evolution.recordOutcome(baseline.id, { taskId: 'unverified-task', success: true, tokensUsed: null, durationMs: 1, domain: 'fixture',
    skillVersion: baseline.version, skillContentHash: baseline.contentHash, evidenceRefs: ['skill_delivery:delivered', 'outcome_class:completed_unverified'] });
  evolution.recordOutcome(baseline.id, { taskId: 'source-task', success: true, tokensUsed: null, durationMs: 1, domain: 'fixture',
    skillVersion: baseline.version, skillContentHash: baseline.contentHash, evidenceRefs: ['skill_delivery:delivered', 'verification:test_result:passed'] });
  db.prepare(`INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, metadata, started_at, finished_at)
    VALUES ('verified-baseline', 'test-skill', 'completed', 30, 30, 3, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')`).run(JSON.stringify({
      evaluation_mode: 'skill_conditioned_prompt', skill_id: baseline.id, skill_version: baseline.version,
      skill_content_hash: baseline.contentHash, score_valid: true, certification_eligible: true,
    }));
  const caseIds = cases.map((item) => item.id);
  let calls = 0;
  /** A fixture evaluator: every non-baseline instruction set scores 4, the baseline 3. */
  const evaluator = { runEval: async (_id: string, _categories: unknown, _model: string, ids: string[], subject: any) => {
    const id = `eval-${++calls}`;
    const score = subject.contentHash === baseline.contentHash ? 3 : 4;
    db.prepare(`INSERT INTO openmythos_eval_runs (id, agent_id, status, total_cases, completed_cases, overall_score, metadata, started_at, finished_at)
      VALUES (?, 'test-skill', 'completed', 30, 30, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')`)
      .run(id, score, JSON.stringify({ corpus_sha256: corpusHash,
        corpus_version: 'fixture-v1', subject_model: 'fixture-model', subject_model_digest: 'm'.repeat(64),
        judge_backend: 'ollama', judge_model: 'fixture-oracle', judge_model_digest: 'j'.repeat(64),
        oracle_anchors_sha256: anchorHash, oracle_anchor_cases: 1, corpus_certification_ready: true,
        case_ids: ids, score_valid: true, certification_eligible: true, evaluator_build_sha: 'build-fixture',
        generation_options: { temperature: 0, seed: 0, num_predict: 1024 }, skill_content_hash: subject.contentHash }));
    return { id, agentId: 'test-skill', status: 'completed', totalCases: 30, completedCases: 30,
      overallScore: score, categoryScores: {},
      results: ids.map((caseId) => ({ caseId, category: 'fixture', difficulty: 1, response: 'ok', judgeScore: score,
        judgeRationale: 'fixture', scoringSource: 'oracle' as const, oraclePass: true, latencyMs: 10, status: 'completed' as const })),
      startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z' };
  } };
  const create = (replace: string) => service.createCandidate({ loader, skillId: 'test-skill', baselineHash: baseline.contentHash,
    find: 'one check', replace, actor: 'operator', sourceTaskId: 'source-task' });
  const compare = (candidateId: string) => service.compare(candidateId, loader, evaluator as any, { model: 'fixture-model', caseIds, actor: 'reviewer' });
  return { skillsDir, loader, baseline, service, corpusPath, create, compare };
}

it('creates an immutable instruction candidate, compares pinned cases, activates and rolls it back', async () => {
  const { loader, baseline, service, corpusPath, create, compare } = fixture();
  for (const sourceTaskId of ['missing-task', 'assigned-task', 'unverified-task']) {
    expect(() => service.createCandidate({ loader, skillId: 'test-skill', baselineHash: baseline.contentHash,
      find: 'one check', replace: 'valid edit', actor: 'operator', sourceTaskId }))
      .toThrow('SKILL_EVOLUTION_DELIVERED_SOURCE_OUTCOME_REQUIRED');
  }
  expect(() => service.createCandidate({ loader, skillId: 'test-skill', baselineHash: 'f'.repeat(64), find: 'one check', replace: 'two checks', actor: 'operator', sourceTaskId: 'source-task' }))
    .toThrow('SKILL_EVOLUTION_BASELINE_HASH_MISMATCH');
  const candidate = create('two checks');
  expect(() => create('two checks')).toThrow('SKILL_EVOLUTION_DUPLICATE_CANDIDATE');
  const alternative = create('three checks');
  expect(() => create('four checks')).toThrow('SKILL_EVOLUTION_CANDIDATE_VARIANT_LIMIT');
  expect(alternative.id).not.toBe(candidate.id);
  expect(candidate.instructions).toContain('two checks');
  expect(loader.getSkill('test-skill')?.instructions).toContain('one check');

  const compared = await compare(candidate.id);
  expect(compared.verdict).toBe('PASS');
  process.env.OPENMYTHOS_SUBJECT_MODEL_DIGEST = 'stale-digest';
  expect(() => service.activate(candidate.id)).toThrow('SKILL_EVOLUTION_EVALUATION_IDENTITY_STALE');
  process.env.OPENMYTHOS_SUBJECT_MODEL_DIGEST = 'm'.repeat(64);
  const originalCorpus = fs.readFileSync(corpusPath);
  fs.appendFileSync(corpusPath, ' ');
  expect(() => service.activate(candidate.id)).toThrow('SKILL_EVOLUTION_EVALUATION_IDENTITY_UNAVAILABLE');
  fs.writeFileSync(corpusPath, originalCorpus);
  service.activate(candidate.id);
  expect(loader.loadSkills().find((skill) => skill.id === 'test-skill')).toMatchObject({ version: candidate.version, contentHash: candidate.content_hash, instructions: 'Use two checks.' });
  expect(service.rollback(candidate.id)).toMatchObject({ active_version: '1.0.0', external_effects_reversed: false });
  expect(loader.loadSkills().find((skill) => skill.id === 'test-skill')).toMatchObject({ version: '1.0.0', contentHash: baseline.contentHash, instructions: 'Use one check.' });
});

it('rejects activating a second candidate whose compared parent is no longer the active artifact (STALE_PARENT)', async () => {
  const { loader, baseline, service, create, compare } = fixture();
  const first = create('two checks');
  const second = create('three checks');
  expect((await compare(first.id)).verdict).toBe('PASS');
  expect((await compare(second.id)).verdict).toBe('PASS');
  service.activate(first.id);
  expect(() => service.activate(second.id)).toThrow('SKILL_EVOLUTION_STALE_PARENT');
  // the first candidate stays the only active artifact
  expect(loader.loadSkills().find((skill) => skill.id === 'test-skill')).toMatchObject({ contentHash: first.content_hash });
  expect(baseline.contentHash).toBe(first.parent_hash);
});

it('refreshes the execution engine loader on activate and rollback without a restart', async () => {
  const { skillsDir, baseline, service, create, compare } = fixture();
  const engine = new ExecutionEngine(db, undefined, skillsDir);
  const resolve = () => (engine as any).skillLoaderForTask({ metadata: {} }).getSkill('test-skill');
  expect(resolve()).toMatchObject({ contentHash: baseline.contentHash });
  const candidate = create('two checks');
  await compare(candidate.id);
  service.activate(candidate.id);
  expect(resolve()).toMatchObject({ contentHash: candidate.content_hash, instructions: 'Use two checks.' });
  service.rollback(candidate.id);
  expect(resolve()).toMatchObject({ contentHash: baseline.contentHash, instructions: 'Use one check.' });
});

it('SKILL_ARTIFACT_EVOLUTION_MODE off: the loader ignores active artifact rows and the service refuses every evolution step', async () => {
  const { skillsDir, baseline, service, create, compare } = fixture();
  const candidate = create('two checks');
  await compare(candidate.id);
  service.activate(candidate.id);
  expect(new SkillLoaderService(db, skillsDir).getSkill('test-skill')).toMatchObject({ contentHash: candidate.content_hash });

  process.env.SKILL_ARTIFACT_EVOLUTION_MODE = 'off';
  const offLoader = new SkillLoaderService(db, skillsDir);
  const skill = offLoader.getSkill('test-skill')!;
  expect(skill).toMatchObject({ version: '1.0.0', contentHash: baseline.contentHash, instructions: 'Use one check.' });
  expect(skill).not.toHaveProperty('sourcePackageHash'); // byte-identical to the pre-evolution loader output
  expect(() => create('three checks')).toThrow('SKILL_EVOLUTION_DISABLED');
  await expect(compare(candidate.id)).rejects.toThrow('SKILL_EVOLUTION_DISABLED');
  expect(() => service.activate(candidate.id)).toThrow('SKILL_EVOLUTION_DISABLED');
  expect(() => service.rollback(candidate.id)).toThrow('SKILL_EVOLUTION_DISABLED');
  delete process.env.SKILL_ARTIFACT_EVOLUTION_MODE; // unset = off
  expect(new SkillLoaderService(db, skillsDir).getSkill('test-skill')).toMatchObject({ contentHash: baseline.contentHash });
});
