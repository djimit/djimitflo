import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillTrainingPromotionGate } from '../services/skill-training-promotion-gate';

const previousRunner = process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER;
let runnerDir: string | null = null;

function runner(source: string) {
  runnerDir = mkdtempSync(join(tmpdir(), 'skill-training-gate-'));
  const file = join(runnerDir, 'runner.mjs');
  writeFileSync(file, source, 'utf8');
  process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER = file;
}

afterEach(() => {
  if (previousRunner === undefined) delete process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER;
  else process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER = previousRunner;
  if (runnerDir) rmSync(runnerDir, { recursive: true, force: true });
  runnerDir = null;
});

describe('SkillTrainingPromotionGate', () => {
  it('passes skill promotion when the runner reports passed', () => {
    runner('console.log(JSON.stringify({ passed: true, summary: { generated_at: "ok" } }));\n');
    const skillPath = join(runnerDir!, 'SKILL.md');
    writeFileSync(skillPath, '# Skill A\n', 'utf8');
    const contentHash = createHash('sha256').update('# Skill A\n').digest('hex');
    const result = new SkillTrainingPromotionGate().assertPass({
      id: 'skill-a',
      kind: 'skill',
      version: '1.0.0',
      metadata: { skill_path: skillPath, skill_content_hash: contentHash },
    }, [`openmythos:skill:skill-a:1.0.0:${contentHash}:run:eval-1`]);
    expect(result).toEqual({
      passed: true,
      skipped: false,
      evidenceRef: `skill_training_eval:skill-a:1.0.0:${contentHash}:ok`,
    });
  });

  it('blocks skill promotion when the runner fails', () => {
    runner('console.log(JSON.stringify({ passed: false, threshold_failures: ["x"] })); process.exit(1);\n');
    const skillPath = join(runnerDir!, 'SKILL.md');
    writeFileSync(skillPath, '# Skill A\n', 'utf8');
    const contentHash = createHash('sha256').update('# Skill A\n').digest('hex');
    expect(() => new SkillTrainingPromotionGate().assertPass({
      id: 'skill-a',
      kind: 'skill',
      version: '1.0.0',
      metadata: { skill_path: skillPath, skill_content_hash: contentHash },
    }, [`openmythos:skill:skill-a:1.0.0:${contentHash}:run:eval-1`]))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED/);
  });

  it('rejects missing candidates, changed content, and unrelated evidence', () => {
    runner('console.log(JSON.stringify({ passed: true, summary: { generated_at: "ok" } }));\n');
    const gate = new SkillTrainingPromotionGate();
    expect(() => gate.assertPass({ id: 'missing', kind: 'skill', version: '1.0.0' }, []))
      .toThrow(/CANDIDATE_NOT_FOUND/);

    const skillPath = join(runnerDir!, 'SKILL.md');
    writeFileSync(skillPath, '# Current\n', 'utf8');
    const staleHash = createHash('sha256').update('# Previous\n').digest('hex');
    expect(() => gate.assertPass({
      id: 'changed',
      kind: 'skill',
      version: '1.0.0',
      metadata: { skill_path: skillPath, skill_content_hash: staleHash },
    }, [] )).toThrow(/CONTENT_HASH_MISMATCH/);

    const currentHash = createHash('sha256').update('# Current\n').digest('hex');
    expect(() => gate.assertPass({
      id: 'changed',
      kind: 'skill',
      version: '1.0.0',
      metadata: { skill_path: skillPath, skill_content_hash: currentHash },
    }, [`openmythos:skill:other:1.0.0:${currentHash}:run:eval-1`]))
      .toThrow(/CANDIDATE_EVIDENCE_REQUIRED/);
  });

  it('skips non-skill capabilities', () => {
    const result = new SkillTrainingPromotionGate().assertPass({ id: 'adapter-a', kind: 'runtime_adapter' });
    expect(result).toEqual({ passed: true, skipped: true, evidenceRef: null });
  });
});
