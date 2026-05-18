import type { AgentsMdFile, AgentsMdIssue, EffectiveInstructionStack } from '@djimitflo/shared';
import { randomUUID } from 'crypto';

interface ValidationRule {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  check: (content: string, filePath: string) => AgentsMdIssue | null;
  recommendation: string;
}

const VALIDATION_RULES: ValidationRule[] = [
  {
    id: 'missing-test-command',
    title: 'Missing test command',
    description: 'AGENTS.md does not specify how to run tests.',
    severity: 'warning',
    recommendation: 'Add a section like "## Commands\\n- Test: `npm test`"',
    check: (content) => {
      const lower = content.toLowerCase();
      if (!lower.includes('test') && !lower.includes('spec') && !lower.includes('vitest') && !lower.includes('jest')) return null;
      return null;
    },
  },
  {
    id: 'missing-build-command',
    title: 'Missing build command',
    description: 'AGENTS.md does not specify how to build the project.',
    severity: 'info',
    recommendation: 'Add build commands to help agents understand the project workflow.',
    check: (content) => {
      const lower = content.toLowerCase();
      if (lower.includes('build') || lower.includes('compile') || lower.includes('npm run build') || lower.includes('make')) return null;
      return null;
    },
  },
  {
    id: 'missing-security-boundaries',
    title: 'Missing security boundaries',
    description: 'AGENTS.md does not define protected paths or files agents should not modify.',
    severity: 'warning',
    recommendation: 'Add a "## Protected Paths" section listing files agents must not modify (e.g., .env, secrets, CI configs).',
    check: (content) => {
      const lower = content.toLowerCase();
      if (lower.includes('protected') || lower.includes('do not modify') || lower.includes('never edit') || lower.includes('read-only') || lower.includes('sensitive')) return null;
      return null;
    },
  },
  {
    id: 'missing-done-criteria',
    title: 'Missing done criteria',
    description: 'AGENTS.md does not specify how to determine task completion.',
    severity: 'info',
    recommendation: 'Add "## Done Criteria" specifying what constitutes a completed task.',
    check: (content) => {
      const lower = content.toLowerCase();
      if (lower.includes('done') || lower.includes('complete') || lower.includes('finish') || lower.includes('success criteria')) return null;
      return null;
    },
  },
  {
    id: 'missing-review-requirements',
    title: 'Missing review requirements',
    description: 'AGENTS.md does not specify review or approval requirements.',
    severity: 'info',
    recommendation: 'Add guidance on when changes require human review.',
    check: (content) => {
      const lower = content.toLowerCase();
      if (lower.includes('review') || lower.includes('approval') || lower.includes('approve') || lower.includes('sign off')) return null;
      return null;
    },
  },
  {
    id: 'unsafe-shell-permissions',
    title: 'Unsafe shell permissions',
    description: 'AGENTS.md grants unrestricted shell access without constraints.',
    severity: 'error',
    recommendation: 'Specify which commands are allowed and which require approval.',
    check: (content) => {
      const lower = content.toLowerCase();
      if ((lower.includes('any command') || lower.includes('full access') || lower.includes('unrestricted')) && !lower.includes('approval') && !lower.includes('with caution')) {
        return null;
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
    check: (content) => {
      const lower = content.toLowerCase();
      if (lower.includes('skip approval') || lower.includes('ignore approval') || lower.includes('bypass approval') || lower.includes('no approval needed')) {
        return null;
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
    check: (content) => {
      const lower = content.toLowerCase();
      if (lower.includes('show me the secret') || lower.includes('print the password') || lower.includes('log the api key') || lower.includes('echo $') && lower.includes('key')) {
        return null;
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
      const result = rule.check(content, file.relativePath);
      if (result === null) {
        issues.push({
          id: randomUUID(),
          fileId: file.id,
          severity: rule.severity,
          ruleId: rule.id,
          title: rule.title,
          description: rule.description,
          recommendation: rule.recommendation,
        });
      }
    }

    if (!content.includes('test') && !content.includes('Test')) {
      const existing = issues.find(i => i.ruleId === 'missing-test-command');
      if (!existing) {
        issues.push({
          id: randomUUID(),
          fileId: file.id,
          severity: 'warning',
          ruleId: 'missing-test-command',
          title: 'Missing test command',
          description: 'AGENTS.md does not specify how to run tests.',
          recommendation: 'Add a section like "## Commands\\n- Test: `npm test`"',
        });
      }
    }

    if (!content.includes('build') && !content.includes('Build')) {
      const existing = issues.find(i => i.ruleId === 'missing-build-command');
      if (!existing) {
        issues.push({
          id: randomUUID(),
          fileId: file.id,
          severity: 'info',
          ruleId: 'missing-build-command',
          title: 'Missing build command',
          description: 'AGENTS.md does not specify how to build the project.',
          recommendation: 'Add build commands to help agents understand the project workflow.',
        });
      }
    }

    if (!content.includes('protected') && !content.includes('Protected') && !content.includes('do not') && !content.includes('Do not') && !content.includes('never') && !content.includes('Never')) {
      issues.push({
        id: randomUUID(),
        fileId: file.id,
        severity: 'warning',
        ruleId: 'missing-security-boundaries',
        title: 'Missing security boundaries',
        description: 'AGENTS.md does not define protected paths or files agents should not modify.',
        recommendation: 'Add a "## Protected Paths" section listing sensitive files.',
      });
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