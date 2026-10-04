import { describe, expect, it } from 'vitest';
import { RiskLevel, Task } from '@djimitflo/shared';
import { CommandRiskClassifier } from '../services/command-risk-classifier';

const classifier = new CommandRiskClassifier();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Sample task',
    description: 'Does sample work',
    status: 'pending',
    priority: 'medium',
    risk_level: RiskLevel.LOW,
    execution_mode: 'local',
    agent_id: null,
    parent_task_id: null,
    repository_id: null,
    instruction_profile_id: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    execution_time_ms: null,
    token_usage: null,
    created_by: null,
    owner_user_id: null,
    updated_by: null,
    tags: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('CommandRiskClassifier — classify', () => {
  it('classifies low-risk read-only commands as allow', () => {
    for (const cmd of ['pwd', 'ls', 'ls -la', 'git status', 'git diff', 'npm test', 'pnpm lint', 'pnpm typecheck']) {
      const result = classifier.classify(cmd);
      expect(result.risk_level).toBe(RiskLevel.LOW);
      expect(result.recommended_decision).toBe('allow');
      expect(result.matched_rules).toContain('low-pattern');
      expect(result.action_type).toBe('command');
    }
  });

  it('classifies medium-risk mutation commands as require_approval', () => {
    const result = classifier.classify('npm install');
    expect(result.risk_level).toBe(RiskLevel.MEDIUM);
    expect(result.recommended_decision).toBe('require_approval');
    expect(result.matched_rules).toContain('medium-pattern');
  });

  it('classifies high-risk commands as require_approval', () => {
    const result = classifier.classify('rm -r tmp');
    expect(result.risk_level).toBe(RiskLevel.HIGH);
    expect(result.recommended_decision).toBe('require_approval');
    expect(result.matched_rules).toContain('high-pattern');
  });

  it('classifies critical-risk commands as deny', () => {
    const result = classifier.classify('cat ~/.ssh/id_rsa');
    expect(result.risk_level).toBe(RiskLevel.CRITICAL);
    expect(result.recommended_decision).toBe('deny');
    expect(result.matched_rules).toContain('critical-pattern');
  });

  it('falls back to medium risk for unknown commands', () => {
    const result = classifier.classify('some-unknown-binary --flag');
    expect(result.risk_level).toBe(RiskLevel.MEDIUM);
    expect(result.recommended_decision).toBe('require_approval');
    expect(result.matched_rules).toEqual(['fallback-unknown-command']);
  });

  it('trims whitespace before matching', () => {
    const result = classifier.classify('   pwd   ');
    expect(result.risk_level).toBe(RiskLevel.LOW);
    expect(result.metadata.command).toBe('pwd');
  });

  it('critical patterns take precedence over high patterns', () => {
    const result = classifier.classify('sudo rm -rf /');
    expect(result.risk_level).toBe(RiskLevel.CRITICAL);
    expect(result.recommended_decision).toBe('deny');
  });

  it('detects writes outside the workspace and denies them', () => {
    const result = classifier.classify('echo data | tee /outside/out.txt', { workspacePath: '/workspace' });
    expect(result.risk_level).toBe(RiskLevel.CRITICAL);
    expect(result.recommended_decision).toBe('deny');
    expect(result.matched_rules).toContain('outside-workspace-write');
  });

  it('allows writes inside the workspace', () => {
    const result = classifier.classify('echo data | tee ./out.txt', { workspacePath: '/workspace' });
    expect(result.matched_rules).not.toContain('outside-workspace-write');
  });

  it('does not apply outside-workspace check when no workspace is provided', () => {
    const result = classifier.classify('echo data | tee /outside/out.txt');
    expect(result.matched_rules).not.toContain('outside-workspace-write');
  });
});

describe('CommandRiskClassifier — assessTask', () => {
  it('keeps low risk for review-only tasks and allows them', () => {
    const result = classifier.assessTask(makeTask({ execution_mode: 'review_only' }), 'codex');
    expect(result.risk_level).toBe(RiskLevel.LOW);
    expect(result.recommended_decision).toBe('allow');
    expect(result.matched_rules).toContain('review-only');
  });

  it('raises risk when description contains sensitive keywords', () => {
    const result = classifier.assessTask(
      makeTask({ title: 'Deploy production migration', risk_level: RiskLevel.LOW }),
      'codex'
    );
    expect(result.risk_level).toBe(RiskLevel.HIGH);
    expect(result.recommended_decision).toBe('require_approval');
    expect(result.matched_rules).toContain('sensitive-keywords');
  });

  it('elevates low risk to medium for local opencode execution', () => {
    const result = classifier.assessTask(
      makeTask({ execution_mode: 'local', risk_level: RiskLevel.LOW }),
      'opencode'
    );
    expect(result.risk_level).toBe(RiskLevel.MEDIUM);
    expect(result.recommended_decision).toBe('require_approval');
    expect(result.matched_rules).toContain('local-opencode');
  });

  it('uses the embedded requested_command classification when present', () => {
    const result = classifier.assessTask(
      makeTask({ metadata: { requested_command: 'rm -rf tmp' } }),
      'opencode'
    );
    expect(result.risk_level).toBe(RiskLevel.HIGH);
    expect(result.recommended_decision).toBe('require_approval');
    expect(result.matched_rules).toContain('high-pattern');
    expect(result.metadata.requestedCommand).toBe('rm -rf tmp');
  });

  it('denies tasks whose embedded command is critical', () => {
    const result = classifier.assessTask(
      makeTask({ metadata: { requested_command: 'cat ~/.ssh/id_rsa' } }),
      'opencode'
    );
    expect(result.risk_level).toBe(RiskLevel.CRITICAL);
    expect(result.recommended_decision).toBe('deny');
  });

  it('defaults low-risk tasks to allow when no other rules fire', () => {
    const result = classifier.assessTask(
      makeTask({ risk_level: RiskLevel.LOW, execution_mode: 'review_only' }),
      'codex'
    );
    expect(result.recommended_decision).toBe('allow');
  });

  it('deduplicates matched rules', () => {
    const result = classifier.assessTask(
      makeTask({
        title: 'delete',
        description: 'delete',
        execution_mode: 'review_only',
        metadata: { requested_command: 'rm -rf tmp' },
      }),
      'opencode'
    );
    const unique = new Set(result.matched_rules);
    expect(result.matched_rules.length).toBe(unique.size);
  });

  it('uses riskAssessmentText alongside title for keyword detection', () => {
    const result = classifier.assessTask(
      makeTask({ title: 'Routine', description: 'nothing special', risk_level: RiskLevel.LOW }),
      'codex',
      undefined,
      'deploy to production'
    );
    expect(result.risk_level).toBe(RiskLevel.HIGH);
    expect(result.matched_rules).toContain('sensitive-keywords');
  });
});