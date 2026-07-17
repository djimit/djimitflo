import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

const DEFAULT_RUNNER = '/Users/dlandman/agent-skills/common/skill-training-eval-runner/scripts/run_skill_training_eval.mjs';

export interface PromotionGateCapability {
  id: string;
  kind: string;
}

export interface SkillTrainingPromotionGateResult {
  passed: boolean;
  skipped: boolean;
  evidenceRef: string | null;
}

export class SkillTrainingPromotionGate {
  assertPass(capability: PromotionGateCapability): SkillTrainingPromotionGateResult {
    if (capability.kind !== 'skill' && capability.kind !== 'openai_skill') {
      return { passed: true, skipped: true, evidenceRef: null };
    }

    const runner = process.env.DJIMIT_SKILL_TRAINING_EVAL_RUNNER || DEFAULT_RUNNER;
    if (!existsSync(runner)) {
      throw new Error(`SKILL_TRAINING_PROMOTION_GATE_UNAVAILABLE:${runner}`);
    }

    const result = spawnSync(process.execPath, [runner, '--require-openmythos'], {
      encoding: 'utf8',
      timeout: Number(process.env.DJIMIT_SKILL_TRAINING_GATE_TIMEOUT_MS || 120000),
      maxBuffer: 2 * 1024 * 1024,
    });

    if (result.error || result.status !== 0) {
      throw new Error(`SKILL_TRAINING_PROMOTION_GATE_FAILED:${capability.id}:${result.error?.message || result.stderr || result.stdout}`);
    }

    let report: any;
    try {
      report = JSON.parse(result.stdout || '{}');
    } catch {
      throw new Error(`SKILL_TRAINING_PROMOTION_GATE_INVALID_OUTPUT:${capability.id}`);
    }

    if (report.passed !== true) {
      throw new Error(`SKILL_TRAINING_PROMOTION_GATE_FAILED:${capability.id}:${JSON.stringify(report.threshold_failures || [])}`);
    }

    return {
      passed: true,
      skipped: false,
      evidenceRef: `skill_training_eval:${report.summary?.generated_at || 'passed'}`,
    };
  }
}
