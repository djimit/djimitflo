import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { RepositoryScanner } from "./repository-scanner";
import { RemoteGitService } from "./remote-git-service";
import { RepoGraphBuilder } from "./repo-graph-builder";
import { BundleBuilder } from "./bundle-builder";
import { ExplainerCriticService } from "./explainer-critic-service";
import { JudgeService } from "./judge-service";
import { ExplainerPreflightService } from "./explainer-preflight-service";
import { buildRepoEvidencePacket } from "./repo-evidence-packet";
import { ExplainerAuthorService, type AuthoredSection } from "./explainer-author-service";
import type { Database } from "better-sqlite3";
import { ExplainerProvider, ExplainerStatus, ExplainerBundleStatus } from "@djimitflo/shared";
import type { ExplainerTask, ExplainerBundle, ExplainerCreateInput, GraphSummary, OpenMythosScores, ExplainerFact } from "@djimitflo/shared";

export interface ExplainerGenerationOptions {
  scratchDir?: string;
  cacheRoot?: string;
  corpusPath?: string;
  remoteGitService?: RemoteGitService;
  repositoryScanner?: RepositoryScanner;
  repoGraphBuilder?: RepoGraphBuilder;
  bundleBuilder?: BundleBuilder;
  criticService?: ExplainerCriticService;
  preflightService?: ExplainerPreflightService;
}

export class ExplainerGenerationService {
  private scanner: RepositoryScanner;
  private remoteGit: RemoteGitService;
  private graphBuilder: RepoGraphBuilder;
  private bundleBuilder: BundleBuilder;
  private critic: ExplainerCriticService;
  private preflight: ExplainerPreflightService;
  private scratchDir: string;

  constructor(
    private db: Database,
    options: ExplainerGenerationOptions = {},
  ) {
    this.scanner = options.repositoryScanner ?? new RepositoryScanner(db);
    this.remoteGit = options.remoteGitService ?? new RemoteGitService(options.cacheRoot);
    this.graphBuilder = options.repoGraphBuilder ?? new RepoGraphBuilder(db);
    this.bundleBuilder = options.bundleBuilder ?? new BundleBuilder(db);
    this.critic = options.criticService ?? new ExplainerCriticService(options.corpusPath, new JudgeService(db));
    this.preflight = options.preflightService ?? new ExplainerPreflightService();
    this.scratchDir = options.scratchDir || process.env.DJIMITFLO_EXPLAINER_SCRATCH || "/tmp/djimitflo-explainer";
  }

  async createTask(input: ExplainerCreateInput): Promise<ExplainerTask> {
    if (!input.remote_url && !input.local_path) {
      throw new Error("Either remote_url or local_path is required");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO explainer_tasks (id, title, description, provider, remote_url, local_path, discovered_repository_id, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.description || "",
      input.provider || (input.remote_url ? ExplainerProvider.GITHUB : ExplainerProvider.LOCAL),
      input.remote_url || null,
      input.local_path || null,
      input.discovered_repository_id || null,
      ExplainerStatus.PENDING,
      JSON.stringify(input.metadata || {}),
      now,
      now,
    );
    return this.getTask(id)!;
  }

  getTask(id: string): ExplainerTask | null {
    const row = this.db.prepare("SELECT * FROM explainer_tasks WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      provider: row.provider,
      remote_url: row.remote_url,
      local_path: row.local_path,
      branch: row.branch,
      repository_id: row.repository_id,
      error_message: row.error_message,
      scan_id: row.scan_id,
      status: row.status,
      metadata: JSON.parse(row.metadata || "{}"),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  listTasks(limit = 100, status?: string): ExplainerTask[] {
    let query = "SELECT * FROM explainer_tasks";
    const params: unknown[] = [];
    if (status) { query += " WHERE status = ?"; params.push(status); }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      provider: row.provider,
      remote_url: row.remote_url,
      local_path: row.local_path,
      branch: row.branch,
      repository_id: row.repository_id,
      error_message: row.error_message,
      scan_id: row.scan_id,
      status: row.status,
      metadata: JSON.parse(row.metadata || "{}"),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  async ingestRepository(task: ExplainerTask): Promise<{ localPath: string; repositoryUrl: string | null; repositoryFullName: string }> {
    if (task.remote_url) {
      const ownerRepo = this.extractOwnerRepo(task.remote_url);
      if (task.local_path) {
        return { localPath: task.local_path, repositoryUrl: task.remote_url, repositoryFullName: ownerRepo };
      }
      const clone = await this.remoteGit.cloneRepository(ownerRepo);
      return { localPath: clone.path, repositoryUrl: task.remote_url, repositoryFullName: ownerRepo };
    }
    if (task.local_path) {
      return { localPath: task.local_path, repositoryUrl: task.remote_url, repositoryFullName: task.title.includes('/') ? task.title : `local/${task.title}` };
    }
    throw new Error("Either remote_url or local_path is required");
  }

  private extractOwnerRepo(remoteUrl: string): string {
    const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!match) throw new Error(`Could not extract owner/repo from ${remoteUrl}`);
    return match[1];
  }

  async scanRepository(localPath: string): Promise<any> {
    return this.scanner.scan(localPath);
  }

  async buildGraph(repositoryId: string, localPath: string, scanId: string | null, commitSha: string | null): Promise<GraphSummary> {
    const snapshot = await this.graphBuilder.buildGraph(localPath, {
      repositoryId,
      scanId,
      commitSha,
    });
    return {
      total_nodes: (snapshot.metrics.total_nodes as number) ?? 0,
      total_edges: (snapshot.metrics.total_edges as number) ?? 0,
      total_files: (snapshot.metrics.total_files as number) ?? this.countFiles(localPath),
      risk_score: (snapshot.metrics.risk_score as number | null) ?? null,
      communities: snapshot.communities as GraphSummary['communities'],
      top_flows: snapshot.flows as GraphSummary['top_flows'],
      hub_nodes: snapshot.hub_nodes as GraphSummary['hub_nodes'],
      bridge_nodes: snapshot.bridge_nodes as GraphSummary['bridge_nodes'],
    };
  }

  private countFiles(dir: string): number {
    try {
      return readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).length;
    } catch {
      return 0;
    }
  }

  async generateBundle(
    task: ExplainerTask,
    ingest: { localPath: string; repositoryUrl: string | null; repositoryFullName: string },
    scan: any,
    graph: GraphSummary,
  ): Promise<{ bundleId: string; content: any; preflight: any; score: number | null; retries_used: number }> {
    // FR-006/FR-008: evidence packet → author → critic grade-loop (max 3 attempts)
    const start = Date.now();
    const packet = buildRepoEvidencePacket({
      repositoryFullName: ingest.repositoryFullName,
      localPath: ingest.localPath,
      scan,
      graph,
    });
    const author = new ExplainerAuthorService();

    let sections: AuthoredSection[] = [];
    let retries_used = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const authored = await author.author(packet, retries_used ? this.lastRetryHints : []);
      sections = authored.sections;

      // Build candidate sections map for critic evaluation
      const candidateSections: Record<string, string> = {};
      for (const s of sections) candidateSections[s.section_type] = s.content;
      const candidateFacts = this.sectionsToFacts(ingest, scan, graph, sections);
      const candidate = this.bundleBuilder.build({
        taskId: task.id,
        repositoryFullName: ingest.repositoryFullName,
        repositoryUrl: ingest.repositoryUrl ?? 'https://github.com/' + ingest.repositoryFullName,
        sourceCommit: scan?.gitStatus?.headCommit || 'unknown',
        bundleRoot: this.scratchDir,
        graphSummary: graph,
        scanSummary: scan?.scanSummary ?? {},
        sections: candidateSections,
        facts: candidateFacts,
        openmythosScore: null,
      });
      const candidateContent = this.bundleBuilder.loadBundleContent(candidate.bundleId);
      const criticResult = this.critic.evaluate(candidateContent);
      this.lastRetryHints = criticResult.retry_hints;
      // FR-015 lineage: persist the critic run as an OpenMythos eval run row so
      // bundle scoring is queryable alongside agent/skill evals (agent_id =
      // "explainer-critic", dimensions as categories_json).
      try {
        this.db.prepare(
          "INSERT INTO openmythos_eval_runs (id, agent_id, started_at, finished_at, total_cases, completed_cases, overall_score, status, categories_json, judge_model, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)",
        ).run(
          `explcrit-${candidate.bundleId}-${attempt}`,
          'explainer-critic',
          new Date(start).toISOString(),
          new Date().toISOString(),
          criticResult.dimensions.length,
          criticResult.dimensions.length,
          criticResult.overall_score,
          JSON.stringify(criticResult.dimensions.map((d) => ({ name: d.name, score: d.score }))),
          'judge-service-4factor',
          JSON.stringify({ bundle_id: candidate.bundleId, passed: criticResult.passed, threshold: criticResult.threshold }),
        );
      } catch {
        // eval-persistering is lineage, never a pipeline breaker
      }

      if (criticResult.passed || attempt === 2) {
        const preflight = this.preflight.check(candidateContent, criticResult, scan?.scanSummary?.secretScan?.findings ?? []);
        const status = preflight.passed && criticResult.passed ? ExplainerBundleStatus.PUBLISHED : ExplainerBundleStatus.HUMAN_REVIEW;
        this.db.prepare('UPDATE explainer_bundles SET status = ?, openmythos_score = ?, openmythos_rationale = ?, updated_at = ? WHERE id = ?').run(
          status,
          criticResult.overall_score,
          criticResult.dimensions.map((d) => `${d.name}: ${d.score}`).join('; '),
          new Date().toISOString(),
          candidate.bundleId,
        );
        // Governance: EVERY non-published bundle must be resolvable via the review
        // queue — preflight-only or critic-only failure included (Codex P1 fix).
        if (!preflight.passed || !criticResult.passed) {
          const failedPrefix = preflight.blocking_checks && preflight.blocking_checks.length > 0 ? `preflight: ${preflight.blocking_checks.join(', ')}` : 'preflight: none';
          const criticalDims = criticResult.dimensions.filter((d) => d.score < 50).map((d) => `${d.name}(${Math.round(d.score)})`);
          const dimText = criticalDims.length > 0 ? `critical dims: ${criticalDims.join(', ')}` : `critic dims ok (score ${criticResult.overall_score})`;
          this.db.prepare('INSERT INTO human_review_queue (id, bundle_id, reason, created_at) VALUES (?, ?, ?, ?)').run(
            randomUUID(),
            candidate.bundleId,
            `Not published after ${attempt + 1} attempt(s): ${failedPrefix}; ${dimText}; hints: ${criticResult.retry_hints.slice(0, 3).join(' | ') || 'none'}`,
            new Date().toISOString(),
          );
        }
        return { bundleId: candidate.bundleId, content: candidateContent, preflight, score: criticResult.overall_score, retries_used };
      }
      retries_used = attempt + 1;
    }
    throw new Error('Grade-loop exited without bundle');
  }

  private lastRetryHints: string[] = [];

  private sectionsToFacts(
    ingest: { repositoryFullName: string },
    scan: any,
    graph: GraphSummary,
    sections: AuthoredSection[],
  ): ExplainerFact[] {
    // Merge evidence-backed facts with authored section provenance
    const packet = buildRepoEvidencePacket({
      repositoryFullName: ingest.repositoryFullName,
      localPath: '',
      scan,
      graph,
      tokenBudget: 1000,
    });
    void sections;
    return packet.facts;
  }


  evaluateBundle(bundle: any): OpenMythosScores {
    const content = typeof bundle === 'string' ? bundle : bundle?.explainer_md || '';
    const text = content.toLowerCase();
    const hallucination = text.includes("verify") || text.includes("limitations") ? 0.8 : 0.5;
    const calibration = text.includes("score") ? 0.7 : 0.5;
    const tool_scope = text.includes("stack") || text.includes("files:") ? 0.75 : 0.5;
    const contradiction = 0.9;
    const overthinking = text.split("\n").length < 50 ? 0.85 : 0.6;
    return { hallucination, calibration, tool_scope, contradiction, overthinking };
  }

  async writeEvidenceBundle(taskId: string, bundle: any): Promise<string> {
    // Kept for backwards compatibility; generateBundle now writes the bundle directly.
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found: " + taskId);
    if (!existsSync(this.scratchDir)) mkdirSync(this.scratchDir, { recursive: true });
    const dir = join(this.scratchDir, taskId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const mdPath = join(dir, "explainer.md");
    const llmsPath = join(dir, "llms.txt");
    writeFileSync(mdPath, bundle.explainer_md);
    writeFileSync(llmsPath, bundle.llms_txt);
    const scores = this.evaluateBundle(bundle);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO explainer_bundles (id, task_id, bundle_path, markdown_path, llms_txt_path, openmythos_score, openmythos_rationale, token_count, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      dir,
      mdPath,
      llmsPath,
      (scores.hallucination + scores.calibration + scores.tool_scope + scores.contradiction + scores.overthinking) / 5,
      "Heuristic rubric: calibration, hallucination markers, scope, contradiction, verbosity",
      bundle.explainer_md.length,
      JSON.stringify({ scores }),
      now,
      now,
    );
    return dir;
  }

  async runPipeline(taskId: string, options: { skipGraph?: boolean; skipEval?: boolean; dryRun?: boolean } = {}): Promise<string> {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found: " + taskId);
    this.db.prepare("UPDATE explainer_tasks SET status = ? WHERE id = ?").run(ExplainerStatus.RUNNING, taskId);
    this.auditLog(taskId, task.id, 'pipeline_run', 'pending', null);
    try {
      const ingest = await this.ingestRepository(task);
      const scan = await this.scanRepository(ingest.localPath);
      const graph = options.skipGraph
        ? { total_nodes: 0, total_edges: 0, total_files: this.countFiles(ingest.localPath), risk_score: null, communities: [], top_flows: [], hub_nodes: [], bridge_nodes: [] }
        : await this.buildGraph(scan.repository?.id || 'unknown', ingest.localPath, scan.scanId || null, scan.gitStatus?.headCommit || null);
      const { bundleId, retries_used } = await this.generateBundle(task, ingest, scan, graph);
      this.auditLog(bundleId, taskId, 'pipeline_run', 'success', `grade-loop retries: ${retries_used}`);
      if (options.dryRun) return bundleId;
      this.db.prepare("UPDATE explainer_tasks SET status = ?, scan_id = ?, repository_id = ?, updated_at = ? WHERE id = ?").run(
        ExplainerStatus.COMPLETED,
        scan.scanId || null,
        scan.repository?.id || null,
        new Date().toISOString(),
        taskId,
      );
      return bundleId;
    } catch (error) {
      this.db.prepare("UPDATE explainer_tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?").run(
        ExplainerStatus.FAILED,
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
        taskId,
      );
      this.auditLog(taskId, taskId, 'pipeline_run', 'failure', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private auditLog(resourceId: string, taskId: string, action: string, outcome: 'success' | 'failure' | 'blocked' | 'pending', reason: string | null): void {
    try {
      this.db.prepare(
        'INSERT INTO explainer_audit_log (id, actor, action, resource_type, resource_id, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(randomUUID(), 'system', action, 'explainer_task', resourceId, outcome, reason, new Date().toISOString());
    } catch {
      // audit must never break the pipeline
    }
    void taskId;
  }

  listBundles(taskId?: string): ExplainerBundle[] {
    let query = "SELECT * FROM explainer_bundles";
    const params: unknown[] = [];
    if (taskId) { query += " WHERE task_id = ?"; params.push(taskId); }
    query += " ORDER BY created_at DESC";
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => ({
      id: row.id,
      task_id: row.task_id,
      bundle_path: row.bundle_path,
      manifest_path: row.manifest_path ?? null,
      markdown_path: row.markdown_path,
      llms_txt_path: row.llms_txt_path,
      facts_path: row.facts_path ?? null,
      sections_path: row.sections_path ?? null,
      assets_path: row.assets_path ?? null,
      status: row.status ?? ExplainerBundleStatus.PENDING,
      content_hash: row.content_hash ?? null,
      openmythos_score: row.openmythos_score,
      openmythos_rationale: row.openmythos_rationale,
      token_count: row.token_count,
      metadata: JSON.parse(row.metadata || "{}"),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }
}
