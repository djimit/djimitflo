import type { AgentsMdFile, AgentsMdIssue, EffectiveInstructionStack } from '@djimitflo/shared';
import { randomUUID } from 'crypto';

interface ValidationRule {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  check: (content: string, file: AgentsMdFile) => AgentsMdIssue | null;
  recommendation: string;
}

function issue(rule: ValidationRule, file: AgentsMdFile): AgentsMdIssue {
  return {
    id: randomUUID(),
    fileId: file.id,
    severity: rule.severity,
    ruleId: rule.id,
    title: rule.title,
    description: rule.description,
    recommendation: rule.recommendation,
  };
}

const VALIDATION_RULES: ValidationRule[] = [
  {
    id: 'missing-test-command',
    title: 'Missing test command',
    description: 'AGENTS.md does not specify how to run tests.',
    severity: 'warning',
    recommendation: 'Add a section like "## Commands\n- Test: `npm test`"',
    check: (content, file) => {
      const lower = content.toLowerCase();
      if (lower.includes('test') || lower.includes('spec') || lower.includes('vitest') || lower.includes('jest')) return null;
      return issue(VALIDATION_RULES[0], file);
    },
  },
  {
    id: 'missing-build-command',
    title: 'Missing build command',
    description: 'AGENTS.md does not specify how to build the project.',
    severity: 'info',
    recommendation: 'Add build commands to help agents understand the project workflow.',
    check: (content, file) => {
      const lower = content.toLowerCase();
      if (lower.includes('build') || lower.includes('compile') || lower.includes('npm run build') || lower.includes('make')) return null;
      return issue(VALIDATION_RULES[1], file);
    },
  },
  {
    id: 'missing-security-boundaries',
    title: 'Missing security boundaries',
    description: 'AGENTS.md does not define protected paths or files agents should not modify.',
    severity: 'warning',
    recommendation: 'Add a "## Protected Paths" section listing files agents must not modify (e.g., .env, secrets, CI configs).',
    check: (content, file) => {
      const lower = content.toLowerCase();
      if (lower.includes('protected') || lower.includes('do not modify') || lower.includes('never edit') || lower.includes('read-only') || lower.includes('sensitive')) return null;
      return issue(VALIDATION_RULES[2], file);
    },
  },
  {
    id: 'missing-done-criteria',
    title: 'Missing done criteria',
    description: 'AGENTS.md does not specify how to determine task completion.',
    severity: 'info',
    recommendation: 'Add "## Done Criteria" specifying what constitutes a completed task.',
    check: (content, file) => {
      const lower = content.toLowerCase();
      if (lower.includes('done') || lower.includes('complete') || lower.includes('finish') || lower.includes('success criteria')) return null;
      return issue(VALIDATION_RULES[3], file);
    },
  },
  {
    id: 'missing-review-requirements',
    title: 'Missing review requirements',
    description: 'AGENTS.md does not specify review or approval requirements.',
    severity: 'info',
    recommendation: 'Add guidance on when changes require human review.',
    check: (content, file) => {
      const lower = content.toLowerCase();
      if (lower.includes('review') || lower.includes('approval') || lower.includes('approve') || lower.includes('sign off')) return null;
      return issue(VALIDATION_RULES[4], file);
    },
  },
  {
    id: 'unsafe-shell-permissions',
    title: 'Unsafe shell permissions',
    description: 'AGENTS.md grants unrestricted shell access without constraints.',
    severity: 'error',
    recommendation: 'Specify which commands are allowed and which require approval.',
    check: (content, file) => {
      const lower = content.toLowerCase();
      if ((lower.includes('any command') || lower.includes('full access') || lower.includes('unrestricted')) && !lower.includes('approval') && !lower.includes('with caution')) {
        return issue(VALIDATION_RULES[5], file);
      }
      return null;
    },
  },
  {
    id: 'ignore-approvals',
    title: 'Instructs to ignore approvals',
    description: 'AGENTS.md contains instructions to bypass approval workflows.',
    severity: 'critical',
    recommendation: 'Remove instructions that tell agents to skip or ignore approval processes.',
    check: (content, file) => {
      const lower = content.toLowerCase();
      if (lower.includes('skip approval') || lower.includes('ignore approval') || lower.includes('bypass approval') || lower.includes('no approval needed')) {
        return issue(VALIDATION_RULES[6], file);
      }
      return null;
    },
  },
  {
    id: 'instructed-to-expose-secrets',
    title: 'Instructed to expose secrets',
    description: 'AGENTS.md instructs agents to reveal or log secrets.',
    severity: 'critical',
    recommendation: 'Remove any instructions that ask agents to display, log, or expose secret values.',
    check: (content, file) => {
      const lower = content.toLowerCase();
      if (lower.includes('show me the secret') || lower.includes('print the password') || lower.includes('log the api key') || (lower.includes('echo $') && lower.includes('key'))) {
        return issue(VALIDATION_RULES[7], file);
      }
      return null;
    },
  },
];

export class AgentsMdValidator {
  validateFile(file: AgentsMdFile): AgentsMdIssue[] {
    const issues: AgentsMdIssue[] = [];
    const content = file.content || '';

    for (const rule of VALIDATION_RULES) {
      const result = rule.check(content, file);
      if (result !== null) {
        issues.push(result);
      }
    }

    return issues;
  }

  getEffectiveStack(repositoryId: string, files: AgentsMdFile[], targetPath: string): EffectiveInstructionStack {
    const allIssues: AgentsMdIssue[] = [];
    const applicableFiles: AgentsMdFile[] = [];

    const sorted = [...files].sort((a, b) => {
      if (a.relativePath === 'AGENTS.md') return -1;
      if (b.relativePath === 'AGENTS.md') return 1;
      return a.appliesToPath.localeCompare(b.appliesToPath);
    });

    for (const file of sorted) {
      const appliesToPath = file.appliesToPath;
      if (appliesToPath === '/' || targetPath.startsWith(appliesToPath) || targetPath.startsWith(file.relativePath.replace('/AGENTS.md', ''))) {
        applicableFiles.push(file);
      }

      const fileIssues = this.validateFile(file);
      allIssues.push(...fileIssues);
    }

    const summaryParts: string[] = [];
    for (const file of applicableFiles) {
      const firstLine = (file.content || '').split('\n')[0] || file.relativePath;
      summaryParts.push(`[${file.relativePath}] ${firstLine}`);
    }

    const criticalIssues = allIssues.filter(i => i.severity === 'critical').length;
    const errorIssues = allIssues.filter(i => i.severity === 'error').length;
    const warningIssues = allIssues.filter(i => i.severity === 'warning').length;

    let summary = `${applicableFiles.length} AGENTS.md file(s) apply to "${targetPath}".`;
    if (criticalIssues > 0) summary += ` ${criticalIssues} critical issue(s).`;
    if (errorIssues > 0) summary += ` ${errorIssues} error(s).`;
    if (warningIssues > 0) summary += ` ${warningIssues} warning(s).`;

    return {
      repositoryId,
      targetPath,
      files: applicableFiles,
      issues: allIssues,
      summary,
    };
  }
}