import { ActionType, PolicyDecision, RiskAssessment, RiskLevel, Task } from '@djimitflo/shared';
import { resolve } from 'path';

export interface ExecutionContext {
  workspacePath?: string;
  task?: Task;
}

const LOW_PATTERNS = [/^pwd$/i, /^ls(\s|$)/i, /^git status$/i, /^git diff(\s|$)/i, /^(npm|pnpm) (test|run typecheck|run lint|lint|typecheck)$/i];
const MEDIUM_PATTERNS = [/^(npm|pnpm) install(\s|$)/i, /^git (checkout|switch)(\s|$)/i, /^(npm|pnpm) run /i];
const HIGH_PATTERNS = [/^rm(\s|$)/i, /^chmod(\s|$)/i, /^chown(\s|$)/i, /^sudo(\s|$)/i, /^git reset --hard/i, /^git clean -fd/i, /curl.+\|.+(sh|bash)/i, /wget.+\|.+(sh|bash)/i, /^docker run .* -v /i];
const CRITICAL_PATTERNS = [/~\/\.ssh/i, /~\/\.aws/i, /~\/\.config/i, /\/etc\//i, /curl.+\|.+(sh|bash|zsh)/i, /eval\s*\(/i, /rm -rf \/(\s|$)/i, /scp\s+/i];

function buildAssessment(
  actionType: ActionType,
  riskLevel: RiskLevel,
  matchedRules: string[],
  explanation: string,
  recommendedDecision: PolicyDecision,
  metadata: Record<string, unknown> = {}
): RiskAssessment {
  return {
    action_type: actionType,
    risk_level: riskLevel,
    matched_rules: matchedRules,
    explanation,
    recommended_decision: recommendedDecision,
    metadata,
  };
}

export class CommandRiskClassifier {
  classify(command: string, context: ExecutionContext = {}): RiskAssessment {
    const normalized = command.trim();
    const matches: string[] = [];

    if (CRITICAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
      matches.push('critical-pattern');
      return buildAssessment('command', RiskLevel.CRITICAL, matches, 'Command matches a critical-risk pattern.', 'deny', {
        command: normalized,
      });
    }

    if (this.writesOutsideWorkspace(normalized, context.workspacePath)) {
      matches.push('outside-workspace-write');
      return buildAssessment('command', RiskLevel.CRITICAL, matches, 'Command appears to write outside the configured workspace.', 'deny', {
        command: normalized,
        workspacePath: context.workspacePath,
      });
    }

    if (HIGH_PATTERNS.some((pattern) => pattern.test(normalized))) {
      matches.push('high-pattern');
      return buildAssessment('command', RiskLevel.HIGH, matches, 'Command matches a high-risk mutation or shell pattern.', 'require_approval', {
        command: normalized,
      });
    }

    if (MEDIUM_PATTERNS.some((pattern) => pattern.test(normalized))) {
      matches.push('medium-pattern');
      return buildAssessment('command', RiskLevel.MEDIUM, matches, 'Command may mutate dependencies, branches, or run scripts with side effects.', 'require_approval', {
        command: normalized,
      });
    }

    if (LOW_PATTERNS.some((pattern) => pattern.test(normalized))) {
      matches.push('low-pattern');
      return buildAssessment('command', RiskLevel.LOW, matches, 'Command is read-only or validation-oriented.', 'allow', {
        command: normalized,
      });
    }

    return buildAssessment('command', RiskLevel.MEDIUM, ['fallback-unknown-command'], 'Unknown command defaults to medium risk until explicitly permitted.', 'require_approval', {
      command: normalized,
    });
  }

  assessTask(task: Task, executorKind: string, workspacePath?: string): RiskAssessment {
    const description = `${task.title} ${task.description}`.toLowerCase();
    const matchedRules: string[] = [];
    let riskLevel = task.risk_level;
    let recommendedDecision: PolicyDecision = riskLevel === RiskLevel.LOW ? 'allow' : 'require_approval';
    let explanation = 'Task risk is based on stored task metadata and execution context.';

    if (task.execution_mode === 'review_only') {
      matchedRules.push('review-only');
      riskLevel = RiskLevel.LOW;
      recommendedDecision = 'allow';
      explanation = 'Review-only tasks are treated as low risk by default.';
    }

    if (/delete|remove|reset|deploy|production|migration|secret|credential|ssh|aws/.test(description)) {
      matchedRules.push('sensitive-keywords');
      if (riskLevel === RiskLevel.LOW || riskLevel === RiskLevel.MEDIUM) {
        riskLevel = RiskLevel.HIGH;
      }
      recommendedDecision = 'require_approval';
      explanation = 'Task description contains sensitive or destructive keywords.';
    }

    if (executorKind === 'opencode' && task.execution_mode === 'local') {
      matchedRules.push('local-opencode');
      if (riskLevel === RiskLevel.LOW) {
        riskLevel = RiskLevel.MEDIUM;
        recommendedDecision = 'require_approval';
        explanation = 'Local OpenCode execution raises the baseline task risk.';
      }
    }

    const requestedCommand = typeof task.metadata?.requested_command === 'string'
      ? String(task.metadata.requested_command)
      : null;

    if (requestedCommand) {
      const commandAssessment = this.classify(requestedCommand, { workspacePath, task });
      matchedRules.push(...commandAssessment.matched_rules);
      riskLevel = commandAssessment.risk_level;
      recommendedDecision = commandAssessment.recommended_decision;
      explanation = `Task includes an explicit command. ${commandAssessment.explanation}`;
    }

    if (riskLevel === RiskLevel.CRITICAL) {
      recommendedDecision = 'deny';
      if (!explanation.includes('denied')) {
        explanation = `Critical risk detected: ${explanation}`;
      }
    }

    return buildAssessment('task_execution', riskLevel, Array.from(new Set(matchedRules)), explanation, recommendedDecision, {
      executorKind,
      executionMode: task.execution_mode,
      workspacePath,
      requestedCommand,
    });
  }

  private writesOutsideWorkspace(command: string, workspacePath?: string): boolean {
    if (!workspacePath) {
      return false;
    }

    const redirects = command.match(/(?:>|>>|tee\s+)(\S+)/g) || [];
    for (const redirect of redirects) {
      const target = redirect.split(/\s+/).pop();
      if (!target || target.startsWith('&')) {
        continue;
      }
      const resolvedTarget = resolve(workspacePath, target);
      if (!resolvedTarget.startsWith(resolve(workspacePath))) {
        return true;
      }
    }

    return false;
  }
}
