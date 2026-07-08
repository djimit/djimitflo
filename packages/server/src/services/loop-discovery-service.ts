/**
 * LoopDiscoveryService — discovers findings for loop execution.
 *
 * Handles all loop-type-specific discovery: doc drift, repo maintenance,
 * skill quality, MCP connector validation, security regression, OKF sync,
 * and overwatch policy drift.
 *
 * Extracted from LoopService (~400 LOC) to isolate the discovery logic
 * from the core loop lifecycle.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const MAX_MARKDOWN_FILE_BYTES = 64 * 1024;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.djimitflo-loop-worktrees']);

export interface LoopFinding {
  id: string;
  type: string;
  severity: 'info' | 'warning' | 'error';
  file: string;
  line?: number;
  message: string;
  evidence: string;
  suggested_fix: string;
  parent_finding_id?: string;
  metadata?: Record<string, unknown>;
}

type LoopName =
  | 'doc-drift-and-small-fix-loop'
  | 'repo-maintenance-loop'
  | 'skill-quality-loop'
  | 'mcp-connector-validation-loop'
  | 'security-regression-loop'
  | 'okf-synchronization-loop'
  | 'overwatch-policy-drift-loop';

export class LoopDiscoveryService {
  /**
   * Discover findings for a given loop type.
   */
  discoverLoopFindings(loopName: LoopName, repositoryPath: string, maxFindings: number): LoopFinding[] {
    switch (loopName) {
      case 'doc-drift-and-small-fix-loop': return this.discoverDocDrift(repositoryPath, maxFindings);
      case 'repo-maintenance-loop': return this.discoverRepoMaintenance(repositoryPath, maxFindings);
      case 'skill-quality-loop': return this.discoverSkillQuality(repositoryPath, maxFindings);
      case 'mcp-connector-validation-loop': return this.discoverMcpConnectorValidation(repositoryPath, maxFindings);
      case 'security-regression-loop': return this.discoverSecurityRegression(repositoryPath, maxFindings);
      case 'okf-synchronization-loop': return this.discoverOkfSynchronization(repositoryPath, maxFindings);
      case 'overwatch-policy-drift-loop': return this.discoverOverwatchPolicyDrift(repositoryPath, maxFindings);
      default: return [];
    }
  }

  private discoverDocDrift(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const scripts = this.collectPackageScripts(repositoryPath);
    const markdownFiles = this.collectMarkdownFiles(repositoryPath);
    const findings: LoopFinding[] = [];

    for (const filePath of markdownFiles) {
      if (findings.length >= maxFindings) break;
      const rel = path.relative(repositoryPath, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length && findings.length < maxFindings; i += 1) {
        const line = lines[i];
        const lineNumber = i + 1;
        if (/\b(TODO|FIXME|XXX)\b/i.test(line)) {
          findings.push({
            id: randomUUID(), type: 'doc_todo', severity: 'info', file: rel, line: lineNumber,
            message: 'Documentation contains an explicit TODO/FIXME marker.',
            evidence: line.trim().slice(0, 240),
            suggested_fix: 'Resolve the marker or convert it to a tracked issue with owner and acceptance criteria.',
          });
        }

        const scriptMatches = line.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g);
        for (const match of scriptMatches) {
          const scriptName = match[1];
          if (!scripts.has(scriptName) && findings.length < maxFindings) {
            findings.push({
              id: randomUUID(), type: 'missing_script_reference', severity: 'warning', file: rel, line: lineNumber,
              message: `Markdown references npm script "${scriptName}", but no package.json in the scan scope defines it.`,
              evidence: line.trim().slice(0, 240),
              suggested_fix: `Update the command reference or add a real "${scriptName}" script where appropriate.`,
            });
          }
        }

        const linkMatches = line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
        for (const match of linkMatches) {
          const target = match[1].split('#')[0].trim();
          if (this.isCheckableRelativeLink(target) && !this.relativeTargetExists(path.dirname(filePath), target) && findings.length < maxFindings) {
            findings.push({
              id: randomUUID(), type: 'broken_relative_link', severity: 'warning', file: rel, line: lineNumber,
              message: `Markdown link target does not exist: ${target}`,
              evidence: line.trim().slice(0, 240),
              suggested_fix: 'Fix the relative link target or remove the stale reference.',
            });
          }
        }
      }

      if (rel.startsWith('packages/knowledge/skills/')) {
        this.collectDraftSkillFinding(rel, content, findings, maxFindings);
      }
    }
    return findings;
  }

  private discoverRepoMaintenance(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const packageJson = path.join(repositoryPath, 'package.json');
    if (fs.existsSync(packageJson)) {
      const scripts = this.readScriptsFromPackageJson(packageJson);
      for (const scriptName of ['test', 'lint', 'type-check']) {
        if (findings.length >= maxFindings) break;
        if (!scripts.has(scriptName)) {
          findings.push(this.createFinding('missing_validation_script', 'warning', repositoryPath, packageJson,
            `package.json does not define "${scriptName}".`, `script "${scriptName}" missing`,
            `Add a real "${scriptName}" script or document why this repository cannot run that gate.`));
        }
      }
    }
    this.collectTodoCommentFindings(repositoryPath, findings, maxFindings, {
      type: 'repo_todo', message: 'Repository source contains TODO/FIXME marker.',
      suggested_fix: 'Resolve the marker or convert it to a tracked issue with owner and acceptance criteria.',
    });
    return findings;
  }

  private discoverSkillQuality(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const skillDir = path.join(repositoryPath, 'packages', 'knowledge', 'skills');
    if (!fs.existsSync(skillDir)) {
      findings.push(this.createFinding('skill_inventory_missing', 'warning', repositoryPath, skillDir,
        'packages/knowledge/skills is missing.', 'skill directory missing',
        'Create the loop skill inventory or configure the OKF skill root explicitly.'));
      return findings.slice(0, maxFindings);
    }
    const skillFiles = this.collectFiles(skillDir, (file) => file.endsWith('.md'), 100);
    for (const file of skillFiles) {
      if (findings.length >= maxFindings) break;
      const rel = path.relative(repositoryPath, file);
      const content = fs.readFileSync(file, 'utf8');
      this.collectDraftSkillFinding(rel, content, findings, maxFindings);
      for (const field of ['actions_allowed:', 'actions_forbidden:', 'gates:', 'escalation:']) {
        if (findings.length >= maxFindings) break;
        if (!content.includes(field)) {
          findings.push({
            id: randomUUID(), type: 'invalid_skill_contract', severity: 'warning', file: rel,
            message: `Loop skill is missing required governance field ${field.replace(':', '')}.`,
            evidence: `${field} not found`,
            suggested_fix: `Add ${field.replace(':', '')} to the skill frontmatter before enabling orchestration.`,
          });
        }
      }
    }
    return findings;
  }

  private discoverMcpConnectorValidation(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const seedPath = path.join(repositoryPath, 'packages', 'server', 'src', 'database', 'seed-mcp-servers.ts');
    const routePath = path.join(repositoryPath, 'packages', 'server', 'src', 'routes', 'mcp.ts');
    if (!fs.existsSync(seedPath)) {
      findings.push(this.createFinding('mcp_inventory_missing', 'warning', repositoryPath, seedPath,
        'MCP seed inventory file is missing.', 'seed-mcp-servers.ts missing',
        'Add or document the canonical MCP inventory source.'));
    }
    if (!fs.existsSync(routePath)) {
      findings.push(this.createFinding('mcp_permission_route_missing', 'warning', repositoryPath, routePath,
        'MCP permission route is missing.', 'routes/mcp.ts missing',
        'Add read-only inventory and explicit permission endpoints for MCP tools.'));
    } else {
      const routeContent = fs.readFileSync(routePath, 'utf8');
      if (!routeContent.includes('mcp_tool_permissions') && findings.length < maxFindings) {
        findings.push(this.createFinding('mcp_permission_gap', 'warning', repositoryPath, routePath,
          'MCP route does not reference mcp_tool_permissions.', 'permission table not referenced',
          'Wire MCP permission decisions into connector inventory responses.'));
      }
    }
    return findings.slice(0, maxFindings);
  }

  private discoverSecurityRegression(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const packageJson = path.join(repositoryPath, 'package.json');
    if (fs.existsSync(packageJson)) {
      const scripts = this.readScriptsFromPackageJson(packageJson);
      const hasSecurityScript = [...scripts].some((s) => /(security|secret|sast|audit|semgrep)/i.test(s));
      if (!hasSecurityScript) {
        findings.push(this.createFinding('missing_security_script', 'warning', repositoryPath, packageJson,
          'No security/audit/secret scanning npm script is defined.', 'security script missing',
          'Add a deterministic security gate such as audit, secret scan, SAST, or document the external CI gate.'));
      }
    }
    const markdownFiles = this.collectMarkdownFiles(repositoryPath);
    for (const file of markdownFiles) {
      if (findings.length >= maxFindings) break;
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && findings.length < maxFindings; i += 1) {
        const line = lines[i];
        if (/\b(TODO|FIXME)\b.*\b(auth|oauth|oidc|secret|token|password|credential|policy)\b/i.test(line)) {
          findings.push({
            id: randomUUID(), type: 'security_sensitive_todo', severity: 'warning',
            file: path.relative(repositoryPath, file), line: i + 1,
            message: 'Security-sensitive TODO/FIXME requires explicit tracking and review.',
            evidence: line.trim().slice(0, 240),
            suggested_fix: 'Resolve the security-sensitive TODO or split it into a tracked high-risk task with security checker review.',
          });
        }
      }
    }
    return findings;
  }

  private discoverOkfSynchronization(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const knowledgeDir = path.join(repositoryPath, 'packages', 'knowledge');
    if (!fs.existsSync(knowledgeDir)) {
      findings.push(this.createFinding('okf_root_missing', 'warning', repositoryPath, knowledgeDir,
        'packages/knowledge is missing.', 'OKF root missing', 'Create the OKF knowledge root or configure OKF_BASE.'));
      return findings.slice(0, maxFindings);
    }
    for (const dirname of ['skills', 'agents', 'tasks', 'memory']) {
      if (findings.length >= maxFindings) break;
      const dir = path.join(knowledgeDir, dirname);
      if (!fs.existsSync(dir)) {
        findings.push(this.createFinding('okf_directory_missing', 'warning', repositoryPath, dir,
          `OKF directory packages/knowledge/${dirname} is missing.`, `${dirname} directory missing`,
          `Create packages/knowledge/${dirname} or document why this OKF facet is external.`));
      }
    }
    const skillsIndex = path.join(knowledgeDir, 'skills', 'index.md');
    if (fs.existsSync(path.join(knowledgeDir, 'skills')) && !fs.existsSync(skillsIndex) && findings.length < maxFindings) {
      findings.push(this.createFinding('okf_index_missing', 'warning', repositoryPath, skillsIndex,
        'packages/knowledge/skills/index.md is missing.', 'skills index missing',
        'Generate a skill index so dashboard and agents can inspect available loop skills.'));
    }
    return findings;
  }

  private discoverOverwatchPolicyDrift(repositoryPath: string, maxFindings: number): LoopFinding[] {
    const findings: LoopFinding[] = [];
    const policyRoute = path.join(repositoryPath, 'packages', 'server', 'src', 'routes', 'policies.ts');
    const migratePath = path.join(repositoryPath, 'packages', 'server', 'src', 'database', 'migrate.ts');
    const riskClassifier = path.join(repositoryPath, 'packages', 'server', 'src', 'services', 'command-risk-classifier.ts');
    for (const file of [policyRoute, migratePath, riskClassifier]) {
      if (findings.length >= maxFindings) break;
      if (!fs.existsSync(file)) {
        findings.push(this.createFinding('policy_control_missing', 'warning', repositoryPath, file,
          `Expected policy control file is missing: ${path.relative(repositoryPath, file)}`,
          'policy control file missing', 'Restore or document the policy control boundary before running mutating workers.'));
      }
    }
    if (fs.existsSync(migratePath)) {
      const content = fs.readFileSync(migratePath, 'utf8');
      for (const requiredPolicy of ['policy-critical-secrets-deny', 'policy-medium-task-approval']) {
        if (findings.length >= maxFindings) break;
        if (!content.includes(requiredPolicy)) {
          findings.push(this.createFinding('policy_seed_gap', 'warning', repositoryPath, migratePath,
            `Approval policy seed is missing ${requiredPolicy}.`, requiredPolicy,
            'Add or document the required approval policy seed.'));
        }
      }
    }
    return findings;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private collectPackageScripts(repositoryPath: string): Set<string> {
    const packageJsonFiles = this.collectFiles(repositoryPath, (file) => path.basename(file) === 'package.json', 40);
    const scripts = new Set<string>();
    for (const file of packageJsonFiles) {
      for (const scriptName of this.readScriptsFromPackageJson(file)) scripts.add(scriptName);
    }
    return scripts;
  }

  private readScriptsFromPackageJson(file: string): Set<string> {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
      return new Set(Object.keys(json.scripts || {}));
    } catch { return new Set(); }
  }

  private collectMarkdownFiles(repositoryPath: string): string[] {
    return this.collectFiles(repositoryPath,
      (file) => file.endsWith('.md') && fs.statSync(file).size <= MAX_MARKDOWN_FILE_BYTES, 300);
  }

  private collectFiles(root: string, predicate: (file: string) => boolean, maxFiles: number): string[] {
    const results: string[] = [];
    const visit = (dir: string) => {
      if (results.length >= maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // Directory doesn't exist or isn't readable
      }
      for (const entry of entries) {
        if (results.length >= maxFiles) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) visit(fullPath);
        } else if (entry.isFile() && predicate(fullPath)) {
          results.push(fullPath);
        }
      }
    };
    visit(root);
    return results.sort();
  }

  private isCheckableRelativeLink(target: string): boolean {
    if (!target || target.startsWith('#')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
    if (target.startsWith('/')) return false;
    return true;
  }

  private relativeTargetExists(baseDir: string, target: string): boolean {
    try {
      const decoded = decodeURIComponent(target);
      return fs.existsSync(path.resolve(baseDir, decoded));
    } catch { return false; }
  }

  private collectDraftSkillFinding(rel: string, content: string, findings: LoopFinding[], maxFindings: number): void {
    if (findings.length >= maxFindings) return;
    if (content.includes('status: draft') || content.includes('trust_level: proposed')) {
      findings.push({
        id: randomUUID(), type: 'draft_loop_skill', severity: 'info', file: rel,
        message: 'Loop skill is still draft/proposed and cannot orchestrate live workers.',
        evidence: 'status/trust_level indicates non-active loop skill',
        suggested_fix: 'Run skill validation and governance review before allowing live worker orchestration.',
      });
    }
  }

  private collectTodoCommentFindings(
    repositoryPath: string, findings: LoopFinding[], maxFindings: number,
    template: { type: string; message: string; suggested_fix: string }
  ): void {
    const files = this.collectFiles(repositoryPath, (file) => /\.(ts|tsx|js|jsx|py|sh|md|yml|yaml)$/.test(file), 300);
    for (const file of files) {
      if (findings.length >= maxFindings) break;
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && findings.length < maxFindings; i += 1) {
        const line = lines[i];
        if (/\b(TODO|FIXME|XXX)\b/i.test(line)) {
          findings.push({
            id: randomUUID(), type: template.type, severity: 'info',
            file: path.relative(repositoryPath, file), line: i + 1,
            message: template.message, evidence: line.trim().slice(0, 240),
            suggested_fix: template.suggested_fix,
          });
        }
      }
    }
  }

  private createFinding(
    type: string, severity: LoopFinding['severity'],
    repositoryPath: string, filePath: string,
    message: string, evidence: string, suggestedFix: string
  ): LoopFinding {
    return {
      id: randomUUID(), type, severity,
      file: path.relative(repositoryPath, filePath) || path.basename(filePath),
      message, evidence, suggested_fix: suggestedFix,
    };
  }
}
