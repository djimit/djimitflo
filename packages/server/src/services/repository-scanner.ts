import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Repository, GitStatusResult, StackDetection, RepositoryHealth, HealthScoreDriver, RepositoryHealthFinding, RepositoryScanResult, AgentsMdFile } from '@djimitflo/shared';

const SECRET_FILE_PATTERNS = [
  /\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials/i,
  /secrets?\.json/i,
  /secrets?\.yml/i,
  /id_rsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
  /\.kubeconfig/i,
];

export class RepositoryScanner {
  constructor(private db: Database) {}

  scan(repoPath: string): RepositoryScanResult {
    const startTime = Date.now();
    const resolvedPath = repoPath;

    if (!existsSync(resolvedPath)) {
      throw new Error(`Repository path does not exist: ${resolvedPath}`);
    }

    const gitStatus = this.detectGitStatus(resolvedPath);
    const stack = this.detectStack(resolvedPath);
    const agentsMdFiles = this.discoverAgentsMd(resolvedPath);
    const healthFindings = this.analyzeHealth(resolvedPath, gitStatus, stack, agentsMdFiles);
    const health = this.calculateHealthScore(gitStatus, stack, agentsMdFiles, healthFindings);

    let repository = this.db.prepare('SELECT * FROM repositories WHERE path = ?').get(resolvedPath) as any;

    if (!repository) {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO repositories (id, name, description, path, provider, status, detected_stacks, package_manager,
          test_commands, build_commands, lint_commands, typecheck_commands, has_git, has_agents_md, health_score,
          is_active, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}', ?, ?)
      `).run(
        id,
        resolvedPath.split('/').pop() || 'unknown',
        `Repository at ${resolvedPath}`,
        resolvedPath,
        'local',
        gitStatus?.isClean ? 'clean' : gitStatus?.isGitRepository ? 'dirty' : 'unknown',
        JSON.stringify(stack.detectedStacks),
        stack.packageManager,
        JSON.stringify(stack.testCommands),
        JSON.stringify(stack.buildCommands),
        JSON.stringify(stack.lintCommands),
        JSON.stringify(stack.typecheckCommands),
        gitStatus?.isGitRepository ? 1 : 0,
        agentsMdFiles.length > 0 ? 1 : 0,
        health.score,
        now,
        now
      );
      repository = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as any;
    } else {
      this.db.prepare(`
        UPDATE repositories SET
          status = ?, detected_stacks = ?, package_manager = ?,
          test_commands = ?, build_commands = ?, lint_commands = ?, typecheck_commands = ?,
          has_git = ?, has_agents_md = ?, health_score = ?,
          git_branch = ?, git_commit = ?, last_synced_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        gitStatus?.isClean ? 'clean' : gitStatus?.isGitRepository ? 'dirty' : 'unknown',
        JSON.stringify(stack.detectedStacks),
        stack.packageManager,
        JSON.stringify(stack.testCommands),
        JSON.stringify(stack.buildCommands),
        JSON.stringify(stack.lintCommands),
        JSON.stringify(stack.typecheckCommands),
        gitStatus?.isGitRepository ? 1 : 0,
        agentsMdFiles.length > 0 ? 1 : 0,
        health.score,
        gitStatus?.currentBranch || null,
        gitStatus?.headCommit || null,
        new Date().toISOString(),
        new Date().toISOString(),
        repository.id
      );
      repository = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(repository.id) as any;
    }

    const scanId = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO repository_scans (id, repository_id, is_git_repository, current_branch, default_branch, is_clean,
        staged_files, modified_files, untracked_files, head_commit, head_commit_message,
        detected_stacks, package_manager, test_commands, build_commands, lint_commands, typecheck_commands,
        has_type_script, has_tests, has_lint, has_ci, has_docker, health_score, scan_duration_ms,
        metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      scanId, repository.id,
      gitStatus?.isGitRepository ? 1 : 0,
      gitStatus?.currentBranch || null,
      gitStatus?.defaultBranch || null,
      gitStatus?.isClean ? 1 : 0,
      gitStatus?.stagedFiles ?? 0,
      gitStatus?.modifiedFiles ?? 0,
      gitStatus?.untrackedFiles ?? 0,
      gitStatus?.headCommit || null,
      gitStatus?.headCommitMessage || null,
      JSON.stringify(stack.detectedStacks),
      stack.packageManager,
      JSON.stringify(stack.testCommands),
      JSON.stringify(stack.buildCommands),
      JSON.stringify(stack.lintCommands),
      JSON.stringify(stack.typecheckCommands),
      stack.hasTypeScript ? 1 : 0,
      stack.hasTests ? 1 : 0,
      stack.hasLint ? 1 : 0,
      stack.hasCI ? 1 : 0,
      stack.hasDocker ? 1 : 0,
      health.score,
      Date.now() - startTime,
      now, now
    );

    for (const finding of healthFindings) {
      this.db.prepare(`
        INSERT INTO repository_health_findings (id, repository_id, severity, category, title, description, recommendation, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), repository.id, finding.severity, finding.category, finding.title, finding.description, finding.recommendation || null, now);
    }

    const agentsMdRepoFiles = this.persistAgentsMdFiles(repository.id, agentsMdFiles);

    const parsedRepo: Repository = {
      ...repository,
      detected_stacks: JSON.parse(repository.detected_stacks || '[]'),
      test_commands: JSON.parse(repository.test_commands || '[]'),
      build_commands: JSON.parse(repository.build_commands || '[]'),
      lint_commands: JSON.parse(repository.lint_commands || '[]'),
      typecheck_commands: JSON.parse(repository.typecheck_commands || '[]'),
      metadata: JSON.parse(repository.metadata || '{}'),
      is_active: Boolean(repository.is_active),
      has_git: Boolean(repository.has_git),
      has_agents_md: Boolean(repository.has_agents_md),
    };

    return { repository: parsedRepo, gitStatus, stack, health, agentsMdFiles: agentsMdRepoFiles, healthFindings };
  }

  private detectGitStatus(repoPath: string): GitStatusResult | null {
    try {
      const isGitRepo = existsSync(join(repoPath, '.git'));
      if (!isGitRepo) {
        return { isGitRepository: false, currentBranch: null, defaultBranch: null, isClean: true, stagedFiles: 0, modifiedFiles: 0, untrackedFiles: 0, aheadBehind: null, headCommit: null, headCommitMessage: null };
      }

      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
      const headCommit = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
      const headCommitMessage = execSync('git log -1 --format=%s', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();

      let defaultBranch: string | null = null;
      try {
        defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s|^refs/remotes/origin/||"', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim() || null;
      } catch { defaultBranch = null; }
      if (!defaultBranch) {
        try {
          const remoteHeads = execSync('git ls-remote --symref origin HEAD 2>/dev/null', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
          const match = remoteHeads.match(/refs\/heads\/(\S+)/);
          if (match) defaultBranch = match[1];
        } catch { defaultBranch = null; }
      }

      const porcelainStatus = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
      const statusLines = porcelainStatus ? porcelainStatus.split('\n').filter(Boolean) : [];
      const stagedFiles = statusLines.filter((l: string) => /^[MADRC]/.test(l)).length;
      const modifiedFiles = statusLines.filter((l: string) => /^\s?[MADRC]/.test(l) || /^[MADRC]\s/.test(l)).length;
      const untrackedFiles = statusLines.filter((l: string) => /^\?\?/.test(l)).length;
      const isClean = statusLines.length === 0;

      let aheadBehind: { ahead: number; behind: number } | null = null;
      try {
        const abRaw = execSync('git rev-list --left-right --count HEAD...@{u} 2>/dev/null', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 }).trim();
        const [ahead, behind] = abRaw.split(/\s+/).map(Number);
        aheadBehind = { ahead, behind };
      } catch { aheadBehind = null; }

      return { isGitRepository: true, currentBranch, defaultBranch, isClean, stagedFiles, modifiedFiles, untrackedFiles, aheadBehind, headCommit, headCommitMessage };
    } catch {
      return null;
    }
  }

  private detectStack(repoPath: string): StackDetection {
    const detectedStacks: string[] = [];
    const commands = { testCommands: [] as string[], buildCommands: [] as string[], lintCommands: [] as string[], typecheckCommands: [] as string[], devCommands: [] as string[] };
    let packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown' = 'unknown';
    let hasTypeScript = false;
    let hasTests = false;
    let hasLint = false;
    let hasCI = false;
    let hasDocker = false;

    if (existsSync(join(repoPath, 'pnpm-workspace.yaml')) || existsSync(join(repoPath, 'pnpm-lock.yaml'))) {
      packageManager = 'pnpm';
      detectedStacks.push('pnpm');
    } else if (existsSync(join(repoPath, 'yarn.lock'))) {
      packageManager = 'yarn';
      detectedStacks.push('yarn');
    } else if (existsSync(join(repoPath, 'bun.lockb')) || existsSync(join(repoPath, 'bunfig.toml'))) {
      packageManager = 'bun';
      detectedStacks.push('bun');
    } else if (existsSync(join(repoPath, 'package-lock.json')) || existsSync(join(repoPath, 'package.json'))) {
      packageManager = 'npm';
      detectedStacks.push('node');
    }

    hasTypeScript = existsSync(join(repoPath, 'tsconfig.json'));
    if (hasTypeScript) detectedStacks.push('typescript');
    if (existsSync(join(repoPath, 'next.config.js')) || existsSync(join(repoPath, 'next.config.mjs')) || existsSync(join(repoPath, 'next.config.ts'))) detectedStacks.push('nextjs');
    if (existsSync(join(repoPath, 'vue.config.js'))) detectedStacks.push('vue');
    if (existsSync(join(repoPath, 'angular.json'))) detectedStacks.push('angular');
    if (existsSync(join(repoPath, 'pyproject.toml')) || existsSync(join(repoPath, 'requirements.txt'))) detectedStacks.push('python');
    if (existsSync(join(repoPath, 'go.mod'))) detectedStacks.push('go');
    if (existsSync(join(repoPath, 'Cargo.toml'))) detectedStacks.push('rust');

    hasDocker = existsSync(join(repoPath, 'Dockerfile')) || existsSync(join(repoPath, 'docker-compose.yml'));
    hasCI = existsSync(join(repoPath, '.github/workflows')) || existsSync(join(repoPath, '.gitlab-ci.yml')) || existsSync(join(repoPath, '.circleci'));

    const pkgPath = join(repoPath, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const scripts = pkg.scripts || {};
        if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') { commands.testCommands.push(`npm test`); hasTests = true; }
        if (scripts.build) commands.buildCommands.push(`npm run build`);
        if (scripts.lint) { commands.lintCommands.push(`npm run lint`); hasLint = true; }
        if (scripts.typecheck || scripts['type-check']) { commands.typecheckCommands.push(`npm run typecheck`); }
        if (scripts.dev) commands.devCommands.push(`npm run dev`);
      } catch {}
      if (packageManager === 'pnpm') {
        commands.testCommands = commands.testCommands.map(c => c.replace('npm', 'pnpm'));
        commands.buildCommands = commands.buildCommands.map(c => c.replace('npm', 'pnpm'));
        commands.lintCommands = commands.lintCommands.map(c => c.replace('npm', 'pnpm'));
        commands.typecheckCommands = commands.typecheckCommands.map(c => c.replace('npm', 'pnpm'));
        commands.devCommands = commands.devCommands.map(c => c.replace('npm', 'pnpm'));
      }
    }

    const makeFilePath = join(repoPath, 'Makefile');
    if (existsSync(makeFilePath)) {
      try {
        const makeContent = readFileSync(makeFilePath, 'utf-8');
        if (/\btest\b/.test(makeContent)) { commands.testCommands.push('make test'); hasTests = true; }
        if (/\bbuild\b/.test(makeContent)) commands.buildCommands.push('make build');
        if (/\blint\b/.test(makeContent)) { commands.lintCommands.push('make lint'); hasLint = true; }
      } catch {}
    }

    if (existsSync(join(repoPath, 'pytest.ini')) || existsSync(join(repoPath, 'setup.cfg')) && existsSync(join(repoPath, 'tests'))) {
      commands.testCommands.push('pytest');
      hasTests = true;
    }
    if (existsSync(join(repoPath, 'Cargo.toml')) && existsSync(join(repoPath, 'tests'))) {
      commands.testCommands.push('cargo test');
      hasTests = true;
    }

    return { detectedStacks, packageManager, ...commands, hasTypeScript, hasTests, hasLint, hasCI, hasDocker };
  }

  private discoverAgentsMd(repoPath: string): AgentsMdFile[] {
    const files: AgentsMdFile[] = [];
    const rootFile = join(repoPath, 'AGENTS.md');
    if (existsSync(rootFile)) {
      try {
        const content = readFileSync(rootFile, 'utf-8');
        const stat = statSync(rootFile);
        const hash = this.simpleHash(content);
        files.push({
          id: randomUUID(),
          repositoryId: '',
          path: rootFile,
          relativePath: 'AGENTS.md',
          appliesToPath: '/',
      contentHash: hash,
        sizeBytes: stat.size,
        content,
        discoveredAt: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        });
      } catch {}
    }

    try {
      const dirs = [join(repoPath, 'packages'), join(repoPath, 'src'), join(repoPath, 'apps'), join(repoPath, 'services')];
      for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const nestedFile = join(dir, entry.name, 'AGENTS.md');
            if (existsSync(nestedFile)) {
              try {
                const content = readFileSync(nestedFile, 'utf-8');
                const stat = statSync(nestedFile);
                files.push({
                  id: randomUUID(),
                  repositoryId: '',
                  path: nestedFile,
                  relativePath: relative(repoPath, nestedFile),
                  appliesToPath: `/${entry.name}`,
                  contentHash: this.simpleHash(content),
                  sizeBytes: stat.size,
                  content,
                  discoveredAt: new Date().toISOString(),
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                });
              } catch {}
            }
          }
        }
      }
    } catch {}

    return files;
  }

  private simpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const chr = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  private analyzeHealth(repoPath: string, gitStatus: GitStatusResult | null, stack: StackDetection, agentsMdFiles: AgentsMdFile[]): RepositoryHealthFinding[] {
    const findings: RepositoryHealthFinding[] = [];
    const now = new Date().toISOString();
    const repoName = repoPath.split('/').pop() || 'repository';

    if (!gitStatus?.isGitRepository) {
      findings.push({ id: randomUUID(), repositoryId: '', severity: 'critical', category: 'version_control', title: 'Not a git repository', description: `${repoName} is not under version control.`, recommendation: 'Initialize a git repository with `git init`.', discoveredAt: now });
    } else if (!gitStatus.isClean) {
      findings.push({ id: randomUUID(), repositoryId: '', severity: 'warning', category: 'version_control', title: 'Dirty working tree', description: `Working tree has ${gitStatus.modifiedFiles} modified and ${gitStatus.untrackedFiles} untracked files.`, recommendation: 'Commit or stash changes before executing tasks.', discoveredAt: now });
    }

    if (!agentsMdFiles.length) {
      findings.push({ id: randomUUID(), repositoryId: '', severity: 'warning', category: 'governance', title: 'No AGENTS.md found', description: 'No AGENTS.md file was found. Agents will not receive repository-specific instructions.', recommendation: 'Create an AGENTS.md file at the repository root with build, test, and lint commands.', discoveredAt: now });
    }

    if (!stack.hasTests) {
      findings.push({ id: randomUUID(), repositoryId: '', severity: 'warning', category: 'testing', title: 'No test commands detected', description: 'No test scripts were detected in package.json or Makefile.', recommendation: 'Add a test script to enable validation before deployment.', discoveredAt: now });
    }

    if (!stack.hasLint && stack.detectedStacks.includes('typescript')) {
      findings.push({ id: randomUUID(), repositoryId: '', severity: 'info', category: 'code_quality', title: 'No lint command detected', description: 'No lint script found for a TypeScript project.', recommendation: 'Add a lint script (e.g., eslint) for code quality enforcement.', discoveredAt: now });
    }

    if (!stack.hasTypeScript && stack.detectedStacks.includes('node')) {
      findings.push({ id: randomUUID(), repositoryId: '', severity: 'info', category: 'type_safety', title: 'No TypeScript detected', description: 'Node.js project without TypeScript configuration.', recommendation: 'Consider adopting TypeScript for type safety.', discoveredAt: now });
    }

    try {
      const walk = (dir: string, depth: number) => {
        if (depth > 3) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
          if (entry.isDirectory()) { walk(join(dir, entry.name), depth + 1); continue; }
          if (SECRET_FILE_PATTERNS.some(p => p.test(entry.name))) {
            findings.push({ id: randomUUID(), repositoryId: '', severity: 'critical', category: 'security', title: 'Potential secret file detected', description: `Found file matching sensitive pattern: ${entry.name}`, recommendation: 'Ensure this file is in .gitignore and never committed. Use environment variables instead.', discoveredAt: now });
          }
        }
      };
      walk(repoPath, 0);
    } catch {}

    return findings;
  }

  private calculateHealthScore(gitStatus: GitStatusResult | null, stack: StackDetection, agentsMdFiles: AgentsMdFile[], findings: RepositoryHealthFinding[]): RepositoryHealth {
    let score = 60;
    const drivers: HealthScoreDriver[] = [];

    if (gitStatus?.isGitRepository) { score += 15; drivers.push({ factor: 'Version control', impact: 15, description: 'Repository is under git version control.' }); }
    else { drivers.push({ factor: 'Version control', impact: -30, description: 'Repository is not under git version control.' }); }

    if (gitStatus?.isClean) { score += 5; drivers.push({ factor: 'Clean working tree', impact: 5, description: 'No uncommitted changes.' }); }
    else if (gitStatus?.isGitRepository) { drivers.push({ factor: 'Dirty tree', impact: -5, description: 'Working tree has uncommitted changes.' }); }

    if (stack.hasTests) { score += 10; drivers.push({ factor: 'Tests', impact: 10, description: 'Test commands are available.' }); }
    else { drivers.push({ factor: 'Tests', impact: -10, description: 'No test commands detected.' }); }

    if (stack.hasLint) { score += 5; drivers.push({ factor: 'Lint', impact: 5, description: 'Lint commands are available.' }); }

    if (stack.hasTypeScript) { score += 5; drivers.push({ factor: 'TypeScript', impact: 5, description: 'TypeScript is configured.' }); }

    if (agentsMdFiles.length > 0) { score += 5; drivers.push({ factor: 'AGENTS.md', impact: 5, description: `${agentsMdFiles.length} AGENTS.md file(s) found.` }); }
    else { drivers.push({ factor: 'AGENTS.md', impact: -5, description: 'No AGENTS.md governance file found.' }); }

    if (stack.hasCI) { score += 5; drivers.push({ factor: 'CI', impact: 5, description: 'CI pipeline is configured.' }); }

    const criticalFindings = findings.filter(f => f.severity === 'critical').length;
    if (criticalFindings > 0) { score -= criticalFindings * 10; drivers.push({ factor: 'Critical findings', impact: -criticalFindings * 10, description: `${criticalFindings} critical health finding(s).` }); }

    score = Math.max(0, Math.min(100, score));
    return { score, drivers };
  }

  private persistAgentsMdFiles(repositoryId: string, files: AgentsMdFile[]): AgentsMdFile[] {
    this.db.prepare('DELETE FROM agents_md_files WHERE repository_id = ?').run(repositoryId);
    const persisted: AgentsMdFile[] = [];
    for (const file of files) {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO agents_md_files (id, repository_id, path, relative_path, applies_to_path, content_hash, size_bytes, content, discovered_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, repositoryId, file.path, file.relativePath, file.appliesToPath, file.contentHash, file.sizeBytes, file.content || null, now, now, now);
      persisted.push({ ...file, id, repositoryId });
    }
    return persisted;
  }

  getRepositories(): Repository[] {
    const rows = this.db.prepare('SELECT * FROM repositories ORDER BY created_at DESC').all() as any[];
    return rows.map(r => ({
      ...r,
      detected_stacks: JSON.parse(r.detected_stacks || '[]'),
      test_commands: JSON.parse(r.test_commands || '[]'),
      build_commands: JSON.parse(r.build_commands || '[]'),
      lint_commands: JSON.parse(r.lint_commands || '[]'),
      typecheck_commands: JSON.parse(r.typecheck_commands || '[]'),
      metadata: JSON.parse(r.metadata || '{}'),
      is_active: Boolean(r.is_active),
      has_git: Boolean(r.has_git ?? 0),
      has_agents_md: Boolean(r.has_agents_md ?? 0),
    }));
  }

  getRepository(id: string): Repository | null {
    const row = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      ...row,
      detected_stacks: JSON.parse(row.detected_stacks || '[]'),
      test_commands: JSON.parse(row.test_commands || '[]'),
      build_commands: JSON.parse(row.build_commands || '[]'),
      lint_commands: JSON.parse(row.lint_commands || '[]'),
      typecheck_commands: JSON.parse(row.typecheck_commands || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
      is_active: Boolean(row.is_active),
      has_git: Boolean(row.has_git ?? 0),
      has_agents_md: Boolean(row.has_agents_md ?? 0),
    };
  }

  getHealthFindings(repositoryId: string): RepositoryHealthFinding[] {
    return this.db.prepare('SELECT * FROM repository_health_findings WHERE repository_id = ? ORDER BY discovered_at DESC').all(repositoryId) as any[];
  }

  getAgentsMdFiles(repositoryId: string): AgentsMdFile[] {
    const rows = this.db.prepare('SELECT * FROM agents_md_files WHERE repository_id = ? ORDER BY relative_path').all(repositoryId) as any[];
    return rows.map(r => ({
      ...r,
      metadata: JSON.parse(r.metadata || '{}'),
    }));
  }
}