import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { SelfCodeAnalysisService, type CodeAnalysisReport } from './self-code-analysis-service';
import { SelfImprovementService } from './self-improvement-service';

export interface GitHubIssue {
  id: string;
  title: string;
  body: string;
  labels: string[];
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  source: string;
}

export interface GitHubPr {
  id: string;
  title: string;
  body: string;
  branch: string;
  source: string;
  findings: string[];
}

export interface BridgeResult {
  issuesGenerated: number;
  prsGenerated: number;
  issues: GitHubIssue[];
  prs: GitHubPr[];
  timestamp: string;
}

interface BridgeRow {
  id: string;
  result_json: string;
  created_at: string;
}

export class SelfAnalysisGitHubBridge {
  private analysisService: SelfCodeAnalysisService;
  private improvementService: SelfImprovementService;

  constructor(private db: Database) {
    this.analysisService = new SelfCodeAnalysisService(db);
    this.improvementService = new SelfImprovementService(db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS github_bridge_results (
        id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS github_issues_generated (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        labels TEXT NOT NULL,
        severity TEXT NOT NULL,
        source TEXT NOT NULL,
        github_issue_number INTEGER,
        github_issue_url TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS github_prs_generated (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        branch TEXT,
        source TEXT NOT NULL,
        findings_json TEXT NOT NULL,
        github_pr_number INTEGER,
        github_pr_url TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  runFullPipeline(targetPath: string = 'packages/server/src'): BridgeResult {
    const report = this.analysisService.analyze(targetPath);
    const issues = this.generateIssuesFromReport(report);
    const prs = this.generatePrsFromImprovements();

    const result: BridgeResult = {
      issuesGenerated: issues.length,
      prsGenerated: prs.length,
      issues,
      prs,
      timestamp: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO github_bridge_results (id, result_json) VALUES (?, ?)
    `).run(randomUUID(), JSON.stringify(result));

    return result;
  }

  generateIssuesFromReport(report: CodeAnalysisReport): GitHubIssue[] {
    const issues: GitHubIssue[] = [];

    for (const finding of report.securityIssues.slice(0, 10)) {
      const issue: GitHubIssue = {
        id: randomUUID(),
        title: `[Security] ${finding.slice(0, 80)}`,
        body: this.buildIssueBody(finding, 'security'),
        labels: ['security', 'auto-generated', 'djimflo-self-analysis'],
        severity: finding.includes('DoS') ? 'high' : 'medium',
        source: 'security-scan',
      };
      issues.push(issue);
      this.persistIssue(issue);
    }

    for (const gap of report.testCoverageGaps.slice(0, 5)) {
      const issue: GitHubIssue = {
        id: randomUUID(),
        title: `[Test Coverage] Add tests for ${gap.split('/').pop() || gap}`,
        body: this.buildIssueBody(gap, 'test-coverage'),
        labels: ['test-coverage', 'auto-generated', 'good-first-issue'],
        severity: 'low',
        source: 'coverage-analysis',
      };
      issues.push(issue);
      this.persistIssue(issue);
    }

    for (const hotspot of report.complexityHotspots.slice(0, 3)) {
      const fileName = hotspot.file.split('/').pop() || hotspot.file;
      const issue: GitHubIssue = {
        id: randomUUID(),
        title: `[Refactor] Reduce complexity in ${fileName} (${hotspot.complexity} LOC)`,
        body: this.buildIssueBody(`${hotspot.file}: ${hotspot.complexity} lines`, 'complexity'),
        labels: ['refactoring', 'auto-generated', 'tech-debt'],
        severity: hotspot.complexity > 2000 ? 'high' : 'medium',
        source: 'complexity-analysis',
      };
      issues.push(issue);
      this.persistIssue(issue);
    }

    return issues;
  }

  generatePrsFromImprovements(): GitHubPr[] {
    const prs: GitHubPr[] = [];
    const proposed = this.improvementService.getProposedImprovements();

    for (const improvement of proposed.slice(0, 5)) {
      const pr: GitHubPr = {
        id: randomUUID(),
        title: `[Auto-Fix] ${improvement.title.slice(0, 80)}`,
        body: this.buildPrBody(improvement.description, improvement.rationale, improvement.type),
        branch: `djimflo/auto-fix/${improvement.type}-${Date.now().toString(36)}`,
        source: improvement.source,
        findings: [improvement.description],
      };
      prs.push(pr);
      this.persistPr(pr);
    }

    return prs;
  }

  createGitHubIssue(issue: GitHubIssue, repo: string): { success: boolean; url?: string; error?: string } {
    try {
      const labelsArg = issue.labels.join(',');
      const output = execSync(
        `gh issue create --repo "${repo}" --title "${issue.title.replace(/"/g, '\\"')}" --body "${issue.body.replace(/"/g, '\\"').replace(/\n/g, ' ')}" --label "${labelsArg}"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
      ).trim();

      const url = output.match(/https:\/\/github\.com\/[^\s]+/)?.[0];
      if (url) {
        const numMatch = url.match(/issues\/(\d+)/);
        this.db.prepare(`
          UPDATE github_issues_generated SET github_issue_number = ?, github_issue_url = ?, status = 'created' WHERE id = ?
        `).run(numMatch?.[1] ? Number(numMatch[1]) : null, url, issue.id);
      }

      return { success: true, url };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return { success: false, error: e.message };
    }
  }

  createGitHubPr(pr: GitHubPr, repo: string, base: string = 'main'): { success: boolean; url?: string; error?: string } {
    try {
      const output = execSync(
        `gh pr create --repo "${repo}" --head "${pr.branch}" --base "${base}" --title "${pr.title.replace(/"/g, '\\"')}" --body "${pr.body.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
      ).trim();

      const url = output.match(/https:\/\/github\.com\/[^\s]+/)?.[0];
      if (url) {
        const numMatch = url.match(/pull\/(\d+)/);
        this.db.prepare(`
          UPDATE github_prs_generated SET github_pr_number = ?, github_pr_url = ?, status = 'created' WHERE id = ?
        `).run(numMatch?.[1] ? Number(numMatch[1]) : null, url, pr.id);
      }

      return { success: true, url };
    } catch (err: unknown) {
      const e = err as { message?: string };
      return { success: false, error: e.message };
    }
  }

  getProposedIssues(): GitHubIssue[] {
    const rows = this.db.prepare("SELECT * FROM github_issues_generated WHERE status = 'proposed' ORDER BY created_at DESC").all() as Array<{
      id: string; title: string; body: string; labels: string; severity: string; source: string;
    }>;
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      body: r.body,
      labels: r.labels.split(','),
      severity: r.severity as GitHubIssue['severity'],
      source: r.source,
    }));
  }

  getProposedPrs(): GitHubPr[] {
    const rows = this.db.prepare("SELECT * FROM github_prs_generated WHERE status = 'proposed' ORDER BY created_at DESC").all() as Array<{
      id: string; title: string; body: string; branch: string; source: string; findings_json: string;
    }>;
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      body: r.body,
      branch: r.branch,
      source: r.source,
      findings: JSON.parse(r.findings_json) as string[],
    }));
  }

  getHistory(limit: number = 20): BridgeResult[] {
    const rows = this.db.prepare('SELECT result_json FROM github_bridge_results ORDER BY created_at DESC LIMIT ?').all(limit) as BridgeRow[];
    return rows.map(r => JSON.parse(r.result_json) as BridgeResult);
  }

  private persistIssue(issue: GitHubIssue): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO github_issues_generated (id, title, body, labels, severity, source)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(issue.id, issue.title, issue.body, issue.labels.join(','), issue.severity, issue.source);
  }

  private persistPr(pr: GitHubPr): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO github_prs_generated (id, title, body, branch, source, findings_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(pr.id, pr.title, pr.body, pr.branch, pr.source, JSON.stringify(pr.findings));
  }

  private buildIssueBody(finding: string, category: string): string {
    return `## Auto-Generated Issue

**Category**: ${category}
**Finding**: ${finding}
**Generated by**: DjimFlo Self-Analysis Bridge
**Timestamp**: ${new Date().toISOString()}

### Description
This issue was automatically generated by DjimFlo's self-analysis pipeline.
The analysis detected a ${category} concern that should be addressed.

### Recommended Action
${this.getRecommendation(category)}

### Metadata
- Source: ${category}
- Severity: auto-detected
- Auto-generated: true

---
*This issue was created automatically by DjimFlo. Please review and prioritize accordingly.*
`;
  }

  private buildPrBody(description: string, rationale: string, type: string): string {
    return `## Auto-Generated Improvement

**Type**: ${type}
**Description**: ${description}
**Rationale**: ${rationale}

### What This PR Does
This PR was automatically generated by DjimFlo's self-improvement pipeline.
It addresses a detected issue in the codebase.

### Testing
- [ ] All existing tests pass
- [ ] New tests added for changes
- [ ] Manual verification performed

### Metadata
- Generated by: DjimFlo Self-Analysis Bridge
- Timestamp: ${new Date().toISOString()}
- Type: ${type}

---
*This PR was created automatically by DjimFlo. Please review before merging.*
`;
  }

  private getRecommendation(category: string): string {
    switch (category) {
      case 'security': return 'Fix the security issue by following OWASP guidelines. Add tests to prevent regression.';
      case 'test-coverage': return 'Add unit tests for the uncovered code. Aim for >80% coverage.';
      case 'complexity': return 'Refactor the large function into smaller, testable units. Extract helper functions.';
      case 'dead-code': return 'Remove unused exports. Verify no external consumers depend on them.';
      default: return 'Review and address the detected issue.';
    }
  }
}
