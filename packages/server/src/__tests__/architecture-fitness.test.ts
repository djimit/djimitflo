import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(sourceRoot, path), 'utf8');

describe('architecture fitness', () => {
  it('keeps PolicyDecisionService as the single active policy evaluator', () => {
    const engine = read('execution/execution-engine.ts');
    const feedback = read('services/governance-feedback-loop.ts');
    expect(`${engine}\n${feedback}`).not.toContain(`Tool${'Broker'}`);
    expect(`${engine}\n${feedback}`).not.toMatch(/evaluateViaPolicy/);
    expect(`${engine}\n${feedback}`).not.toMatch(new RegExp(`getTool${'Broker'}`));
    expect(engine).toContain('new PolicyDecisionService(db)');
    expect(feedback).toContain('policyDecisionService.evaluate(assessment)');
  });

  it('routes approval decisions through ApprovalService', () => {
    const telegram = read('services/telegram-bot-service.ts');
    expect(telegram).toContain('approvalService.decideApproval');
    expect(telegram).not.toMatch(/UPDATE approvals[\s\S]{0,300}status = '(approved|denied)'/);
  });

  it('never forwards a mapped route error twice', () => {
    expect(read('routes/swarm-governance.ts')).not.toMatch(/next\(mapped\)[\s\S]{0,60}next\(error\)/);
  });
});
