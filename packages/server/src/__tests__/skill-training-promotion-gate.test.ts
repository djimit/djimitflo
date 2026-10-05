import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillTrainingPromotionGate } from '../services/skill-training-promotion-gate';

const previousRunner = process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER;
const previousTimeout = process.env.DJIMIT_SKILL_TRAINING_GATE_TIMEOUT_MS;
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
  if (previousTimeout === undefined) delete process.env.DJIMIT_SKILL_TRAINING_GATE_TIMEOUT_MS;
  else process.env.DJIMIT_SKILL_TRAINING_GATE_TIMEOUT_MS = previousTimeout;
  if (runnerDir) rmSync(runnerDir, { recursive: true, force: true });
  runnerDir = null;
});

describe('SkillTrainingPromotionGate', () => {
  it('passes skill promotion when the runner reports passed', () => {
    runner('console.log(JSON.stringify({ passed: true, summary: { generated_at: "ok" } }));\n');
    const result = new SkillTrainingPromotionGate().assertPass({ id: 'skill-a', kind: 'skill' });
    expect(result).toEqual({ passed: true, skipped: false, evidenceRef: 'skill_training_eval:ok' });
  });

  it('passes openai_skill promotion through the runner (not skipped)', () => {
    runner('console.log(JSON.stringify({ passed: true, summary: { generated_at: "ok" } }));\n');
    const result = new SkillTrainingPromotionGate().assertPass({ id: 'skill-b', kind: 'openai_skill' });
    expect(result).toEqual({ passed: true, skipped: false, evidenceRef: 'skill_training_eval:ok' });
  });

  it('uses "passed" evidenceRef when summary is missing', () => {
    runner('console.log(JSON.stringify({ passed: true }));\n');
    const result = new SkillTrainingPromotionGate().assertPass({ id: 'skill-c', kind: 'skill' });
    expect(result).toEqual({ passed: true, skipped: false, evidenceRef: 'skill_training_eval:passed' });
  });

  it('blocks skill promotion when the runner exits non-zero with passed:false', () => {
    runner('console.log(JSON.stringify({ passed: false, threshold_failures: ["x"] })); process.exit(1);\n');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-a', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED/);
  });

  it('blocks skill promotion when runner exits 0 but report.passed is false', () => {
    runner('console.log(JSON.stringify({ passed: false, threshold_failures: ["miss-a"] }));\n');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-d', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED:skill-d:\["miss-a"\]/);
  });

  it('throws UNAVAILABLE when the runner path does not exist', () => {
    process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER = join(tmpdir(), 'definitely-not-here-' + Date.now() + '.mjs');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-e', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_UNAVAILABLE:/);
  });

  it('throws FAILED including stderr content when runner exits non-zero', () => {
    runner('process.stderr.write("boom"); process.exit(2);\n');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-f', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED:skill-f:boom/);
  });

  it('throws FAILED with stderr content over stdout when both present', () => {
    runner('console.log("out"); process.stderr.write("stderr-msg"); process.exit(3);\n');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-g', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED:skill-g:stderr-msg/);
  });

  it('throws FAILED including stdout content when runner exits non-zero with no stderr', () => {
    runner('console.log("stdout-msg"); process.exit(4);\n');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-h', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED:skill-h:stdout-msg/);
  });

  it('throws INVALID_OUTPUT when runner stdout is not JSON', () => {
    runner('console.log("not-json");\n');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-i', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_INVALID_OUTPUT:skill-i/);
  });

  it('throws FAILED when report.passed is not exactly true (truthy but not true)', () => {
    runner('console.log(JSON.stringify({ passed: 1, threshold_failures: ["not-bool"] }));\n');
    expect(() => new SkillTrainingPromotionGate().assertPass({ id: 'skill-j', kind: 'skill' }))
      .toThrow(/SKILL_TRAINING_PROMOTION_GATE_FAILED:skill-j:\["not-bool"\]/);
  });

  it('skips non-skill capabilities', () => {
    const result = new SkillTrainingPromotionGate().assertPass({ id: 'adapter-a', kind: 'runtime_adapter' });
    expect(result).toEqual({ passed: true, skipped: true, evidenceRef: null });
  });

  it('skips for empty kind', () => {
    const result = new SkillTrainingPromotionGate().assertPass({ id: 'adapter-b', kind: '' });
    expect(result).toEqual({ passed: true, skipped: true, evidenceRef: null });
  });
});
