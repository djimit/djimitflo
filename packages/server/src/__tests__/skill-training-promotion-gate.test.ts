import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
    const result = new SkillTrainingPromotionGate().assertPass({ id: 'skill-a', kind: 'skill' });
    expect(result).toEqual({ passed: true, skipped: false, evidenceRef: 'skill_training_eval:ok' });
  });

  it('blocks skill promotion when the runner fails', () => {
    runner('console.log(JSON.stringify({ passed: false, threshold_failures: ["x"] })); process.exit(1);\n');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-a', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED/);
  });

  it('skips non-skill capabilities', () => {
    const result = new SkillTrainingPromotionGate().assertPass({ id: 'adapter-a', kind: 'runtime_adapter' });
    expect(result).toEqual({ passed: true, skipped: true, evidenceRef: null });
  });
});
