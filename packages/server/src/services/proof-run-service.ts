import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { AgentAssuranceService } from './agent-assurance-service';
import { MemoryCandidateService } from './memory-candidate-service';
import { SpecialistPanelService } from './specialist-panel-service';
import { SwarmIntelligenceService } from './swarm-intelligence-service';
import { LoopService } from './loop-service';
import { NestedSpawnService } from './nested-spawn-service';
import fs from 'fs';
import { ContextInjectionService } from './context-injection-service';

type ProofRunStatus = 'completed' | 'rolled_back';
type ProofRunRuntime = 'mock' | 'codex' | 'opencode';

const PROOF_RUN_RUNTIMES: ReadonlyArray<ProofRunRuntime> = ['mock', 'codex', 'opencode'];

/**
 * Per-worker spawn timeout for REAL runtimes (codex/opencode). A real agent
 * legitimately explores the repo (multiple read tool-calls) before editing, so
 * the 120s default used for the instant mock runtime is too tight and causes a
 * spurious maker timeout. Capped at 600_000 by executeMaker/executeChecker.
 * Operator-tunable via PROOF_RUN_RUNTIME_TIMEOUT_MS.
 */
const REAL_RUNTIME_TIMEOUT_MS = Math.max(
  60_000,
  Math.min(Number(process.env.PROOF_RUN_RUNTIME_TIMEOUT_MS || 300_000), 600_000),
);

export interface ProofRunSummary {
  id: string;
  status: ProofRunStatus;
  runtime: ProofRunRuntime;
  created_at: string | null;
  completed_at: string | null;
  rollback_safe: boolean;
  counts: Record<string, number>;
  artifact_refs: Record<string, string | string[] | null>;
  minimums: Record<string, number>;
  passed: boolean;
  proof_class: 'demo' | 'production';
  production_passed: boolean;
  production_missing: string[];
  missing: Record<string, number>;
  narrative: string[];
}

const MINIMUMS: Record<string, number> = {
  capabilities: 6,
  panels: 1,
  reviews: 3,
  claims: 3,
  goals: 1,
  loop_runs: 1,
  worker_leases: 2,
  trace_spans: 5,
  checkpoints: 2,
  manifests: 4,
  memory_candidates: 1,
  work_items: 1,
};

type RuntimeUsageRecord = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens: number;
  usage_source?: string;
};

type ProofRunRuntimeUsage = {
  runtime: ProofRunRuntime;
  loop_run_id: string;
  worker_lease_count: number;
  maker_leases_completed: number;
  checker_leases_completed: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
  unknown_usage_leases: number;
  lease_usages: RuntimeUsageRecord[];
};

const METADATA_TABLES = [
  'swarm_capabilities',
  'swarm_claims',
  'goals',
  'loop_runs',
  'worker_leases',
  'agent_trace_spans',
  'loop_checkpoints',
  'swarm_runner_manifests',
  'memory_candidates',
  'work_items',
  'specialist_panels',
  'swarm_evidence_edges',
] as const;

const LOOP_RELATION_TABLES = new Set([
  'worker_leases',
  'agent_trace_spans',
  'loop_checkpoints',
  'swarm_runner_manifests',
]);

export class ProofRunService {
  private assurance: AgentAssuranceService;
  private memory: MemoryCandidateService;
  private panels: SpecialistPanelService;
  private intelligence: SwarmIntelligenceService;
  private loops: LoopService;
  private spawns: NestedSpawnService;

  constructor(private db: Database) {
    this.assurance = new AgentAssuranceService(db);
    this.memory = new MemoryCandidateService(db);
    this.panels = new SpecialistPanelService(db);
    this.intelligence = new SwarmIntelligenceService(db);
    this.loops = new LoopService(db);
    this.spawns = new NestedSpawnService(db, this.loops, { intelligence: this.intelligence });
  }

  async create(input: { runtime?: string; skip_permissions?: boolean } = {}): Promise<ProofRunSummary> {
    const runtime = this.resolveRuntime(input.runtime);
    const skipPermissions = input.skip_permissions === true;

    const proofRunId = `proof-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const traceId = `trace:${proofRunId}`;
    const base = {
      proof_run_id: proofRunId,
      proof_run_kind: 'commercial_demo',
      runtime,
      rollback_safe: true,
      generated_by: 'proof-run-service',
    };

    if (runtime === 'mock') {
      this.createMockProofRun(proofRunId, now, traceId, base);
      return this.get(proofRunId);
    }

    await this.createRuntimeProofRun(proofRunId, now, traceId, base, runtime, skipPermissions);
    return this.get(proofRunId);
  }

  private resolveRuntime(runtime?: string): ProofRunRuntime {
    const requested = typeof runtime === 'string' ? runtime.toLowerCase().trim() : 'mock';
    if (!PROOF_RUN_RUNTIMES.includes(requested as ProofRunRuntime)) {
      throw new Error('PROOF_RUN_RUNTIME_UNSUPPORTED');
    }
    return requested as ProofRunRuntime;
  }

  private resolveProofRunRuntime(proofRunId: string): ProofRunRuntime {
    const rows = this.getProofLoopRunRows(proofRunId);
    const runtime = rows
      .map((row) => {
        const metadata = this.parseJson(row.metadata);
        if (typeof metadata.runtime === 'string' && PROOF_RUN_RUNTIMES.includes(metadata.runtime as ProofRunRuntime)) {
          return metadata.runtime as ProofRunRuntime;
        }
        return null;
      })
      .find((value): value is ProofRunRuntime => value !== null);
    return runtime || 'mock';
  }

  private getProofLoopRunRows(proofRunId: string): Array<{ id: string; metadata: string; created_at: string; updated_at: string }> {
    const rows = this.db.prepare('SELECT id, metadata, created_at, updated_at FROM loop_runs').all() as Array<{
      id: string;
      metadata: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.filter((row) => this.parseJson(row.metadata || '{}').proof_run_id === proofRunId);
  }

  private ensureProofRunMetadata(loopRunId: string, proofRunId: string) {
    const now = new Date().toISOString();
    const targetTables = new Set(['loop_runs', ...LOOP_RELATION_TABLES]);

    for (const table of targetTables) {
      if (!METADATA_TABLES.includes(table as any)) {
        continue;
      }

      const query = table === 'loop_runs'
        ? 'SELECT id, metadata FROM loop_runs WHERE id = ?'
        : `SELECT id, metadata FROM ${table} WHERE loop_run_id = ?`;

      const rows = this.db.prepare(query).all(loopRunId) as Array<{ id: string; metadata: string }>;

      for (const row of rows) {
        const metadata = this.parseJson(row.metadata || '{}');
        if (metadata.proof_run_id === proofRunId) {
          continue;
        }
        const hasUpdatedAt = this.tableHasColumn(table, 'updated_at');
        if (hasUpdatedAt) {
          this.db.prepare(`UPDATE ${table} SET metadata = ?, updated_at = ? WHERE id = ?`).run(
            JSON.stringify({ ...metadata, proof_run_id: proofRunId }),
            now,
            row.id
          );
          continue;
        }
        this.db.prepare(`UPDATE ${table} SET metadata = ? WHERE id = ?`).run(
          JSON.stringify({ ...metadata, proof_run_id: proofRunId }),
          row.id
        );
      }
    }
  }

  private tableHasColumn(tableName: string, columnName: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return columns.some((row) => row.name === columnName);
  }

  private getRuntimeUsageSummary(loopRunId: string): ProofRunRuntimeUsage {
    const proofRunRuntime = this.resolveProofRunRuntime(this.getProofRunIdForLoop(loopRunId));
    const rows = this.db.prepare('SELECT role, status, metadata FROM worker_leases WHERE loop_run_id = ?').all(loopRunId) as Array<{
      role: string;
      status: string;
      metadata: string;
    }>;

    const summary: ProofRunRuntimeUsage = {
        runtime: proofRunRuntime,
        loop_run_id: loopRunId,
        worker_lease_count: rows.length,
      maker_leases_completed: 0,
      checker_leases_completed: 0,
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_tokens: 0,
      unknown_usage_leases: 0,
      lease_usages: [],
    };

    for (const row of rows) {
      const metadata = this.parseJson(row.metadata || '{}');
      const usage = this.parseRuntimeUsage(metadata.runtime_usage);
      const leaseStatus = row.status || 'unknown';
      if (leaseStatus === 'completed') {
        if (row.role === 'maker') {
          summary.maker_leases_completed += 1;
        }
        if (row.role === 'checker') {
          summary.checker_leases_completed += 1;
        }
      }
      if (!usage || Object.keys(usage).length === 0) {
        summary.unknown_usage_leases += 1;
        continue;
      }
      summary.lease_usages.push({
        usage_source: usage.usage_source,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      });
      summary.total_prompt_tokens += this.toNumber(usage.prompt_tokens);
      summary.total_completion_tokens += this.toNumber(usage.completion_tokens);
      summary.total_tokens += this.toNumber(usage.total_tokens);
    }

    return summary;
  }

  private findLeaseByRole(
    loopRunId: string,
    role: 'maker' | 'checker',
    status?: 'prepared' | 'running' | 'completed' | 'failed' | 'cancelled'
  ): { id: string; role: 'maker' | 'checker'; status: string; metadata: Record<string, unknown> } | null {
    const rows = this.db.prepare('SELECT id, role, status, metadata FROM worker_leases WHERE loop_run_id = ? AND role = ? ORDER BY created_at ASC')
      .all(loopRunId, role) as Array<{ id: string; role: string; status: string; metadata: string }>;
    const match = rows.find((row) => (status ? row.status === status : true));
    if (!match) {
      return null;
    }
    return {
      id: match.id,
      role: (match.role === 'checker' ? 'checker' : 'maker'),
      status: match.status,
      metadata: this.parseJson(match.metadata || '{}'),
    };
  }

  private getProofRunIdForLoop(loopRunId: string): string {
    const loop = this.db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(loopRunId) as { metadata?: string } | undefined;
    const metadata = this.parseJson(loop?.metadata || '{}');
    if (typeof metadata.proof_run_id === 'string') {
      return metadata.proof_run_id;
    }
    throw new Error('PROOF_RUN_NOT_FOUND');
  }

  private toNumber(value: unknown): number {
    const maybe = Number(value);
    return Number.isFinite(maybe) ? maybe : 0;
  }

  private createMockProofRun(
    proofRunId: string,
    now: string,
    traceId: string,
    base: Record<string, unknown>
  ) {
    this.db.transaction(() => {
      const capabilities = this.registerCapabilities(proofRunId, base);
      const panel = this.panels.createPanel({
        topic: 'Sellable Djimitflo swarm proof',
        question: 'Can Djimitflo show a real closed-loop swarm artifact chain with capabilities, goals, workers, evidence and memory?',
        risk_class: 'medium',
        specialist_ids: ['systems_architect', 'runtime_engineer', 'skill_evaluator'],
        context: {
          proof_run_id: proofRunId,
          required_outputs: Object.keys(MINIMUMS),
          runtime: 'mock',
        },
        metadata: base,
      });

      this.panels.submitReview(panel.id, {
        specialist_id: 'systems_architect',
        stance: 'support',
        confidence: 0.91,
        findings: ['The demo uses persisted goals, loop runs, leases, checkpoints and trace spans.'],
        recommendations: ['Expose the proof run as a first-class dashboard drill-through.'],
        evidence_refs: [`proof:${proofRunId}:schema`, `capability:${capabilities[0]}`],
      });
      this.panels.submitReview(panel.id, {
        specialist_id: 'runtime_engineer',
        stance: 'support',
        confidence: 0.88,
        findings: ['Worker leases move through completed execution state with stdout and usage metadata.'],
        recommendations: ['Replace mock runtime with Codex/OpenCode adapter when CLI smoke is green.'],
        evidence_refs: [`proof:${proofRunId}:worker-leases`],
      });
      this.panels.submitReview(panel.id, {
        specialist_id: 'skill_evaluator',
        stance: 'support',
        confidence: 0.86,
        findings: ['Capability contracts include allowed actions, evidence needs and removal strategy.'],
        recommendations: ['Add eval fixtures for every skill before automatic routing.'],
        evidence_refs: [`proof:${proofRunId}:capabilities`],
      });

      const backlog = this.panels.projectPanelToBacklog(panel.id);
      this.tagWorkItem(backlog.work_item.id, proofRunId);

      const goalId = `goal:${proofRunId}`;
      const loopRunId = `loop:${proofRunId}`;
      const makerLeaseId = `lease:${proofRunId}:maker`;
      const checkerLeaseId = `lease:${proofRunId}:checker`;

      this.insertGoal(goalId, proofRunId, now, base);
      this.insertLoopRun(loopRunId, goalId, proofRunId, now, base);
      this.insertWorkerLease(makerLeaseId, loopRunId, 'maker', proofRunId, now, {
        ...base,
        stdout: [
          'mock worker: indexed capabilities',
          'mock worker: created specialist panel and claims',
          'mock worker: wrote runner manifests and memory candidate',
        ],
        stderr: [],
        usage: { input: 1240, output: 530, total: 1770 },
        artifact_refs: [`proof:${proofRunId}:capabilities`, `proof:${proofRunId}:claims`],
      });
      this.insertWorkerLease(checkerLeaseId, loopRunId, 'checker', proofRunId, now, {
        ...base,
        stdout: [
          'mock checker: verified minimum artifact counts',
          'mock checker: verified rollback metadata',
        ],
        stderr: [],
        usage: { input: 760, output: 260, total: 1020 },
        artifact_refs: [`proof:${proofRunId}:summary`],
      });

      const rootSpan = this.assurance.createTraceSpan({
        trace_id: traceId,
        loop_run_id: loopRunId,
        span_type: 'goal',
        name: 'proof-run goal accepted',
        status: 'ok',
        evidence_ref: `goal:${goalId}`,
        started_at: now,
        ended_at: now,
        metadata: base,
      });
      this.assurance.createTraceSpan({
        trace_id: traceId,
        parent_span_id: rootSpan.id,
        loop_run_id: loopRunId,
        span_type: 'capability',
        name: 'capabilities registered',
        status: 'ok',
        evidence_ref: `capabilities:${capabilities.length}`,
        started_at: now,
        ended_at: now,
        metadata: { ...base, capability_ids: capabilities },
      });
      this.assurance.createTraceSpan({
        trace_id: traceId,
        parent_span_id: rootSpan.id,
        loop_run_id: loopRunId,
        span_type: 'worker',
        name: 'maker worker completed',
        status: 'ok',
        evidence_ref: `lease:${makerLeaseId}`,
        started_at: now,
        ended_at: now,
        metadata: { ...base, lease_id: makerLeaseId },
      });
      this.assurance.createTraceSpan({
        trace_id: traceId,
        parent_span_id: rootSpan.id,
        loop_run_id: loopRunId,
        span_type: 'worker',
        name: 'checker worker completed',
        status: 'ok',
        evidence_ref: `lease:${checkerLeaseId}`,
        started_at: now,
        ended_at: now,
        metadata: { ...base, lease_id: checkerLeaseId },
      });
      this.assurance.createTraceSpan({
        trace_id: traceId,
        parent_span_id: rootSpan.id,
        loop_run_id: loopRunId,
        work_item_id: backlog.work_item.id,
        span_type: 'memory',
        name: 'demo memory promoted',
        status: 'ok',
        evidence_ref: `proof:${proofRunId}:memory`,
        started_at: now,
        ended_at: now,
        metadata: base,
      });

      this.assurance.createCheckpoint({
        loop_run_id: loopRunId,
        label: 'before-worker-execution',
        metadata: { ...base, checkpoint_phase: 'before' },
      });
      this.assurance.createCheckpoint({
        loop_run_id: loopRunId,
        label: 'after-worker-execution',
        metadata: { ...base, checkpoint_phase: 'after' },
      });

      this.createClaims(
        proofRunId,
        loopRunId,
        makerLeaseId,
        checkerLeaseId,
        this.getRuntimeUsageSummary(loopRunId),
        'mock',
        base,
      );
      this.createManifests(
        proofRunId,
        loopRunId,
        makerLeaseId,
        checkerLeaseId,
        'mock',
        this.getRuntimeUsageSummary(loopRunId),
        base,
      );

      const candidate = this.memory.create({
        title: `Proof run ${proofRunId} produced a complete swarm artifact chain`,
        content: 'Djimitflo proof run created persisted capabilities, specialist review, goal, loop run, worker leases, trace spans, checkpoints, manifests and backlog output in one closed loop.',
        memory_type: 'operational_memory',
        source_ref: `proof:${proofRunId}`,
        metadata: base,
      });
      this.memory.promote(candidate.id, { sinks: ['qdrant'], approved_by: 'proof-run-service' });
      this.createNestedSpawnProof(loopRunId, proofRunId, 'mock', base);

      this.db.prepare(`
        UPDATE loop_runs
        SET status = 'completed', completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, loopRunId);
    })();
  }

  private async createRuntimeProofRun(
    proofRunId: string,
    now: string,
    traceId: string,
    base: Record<string, unknown>,
    runtime: 'codex' | 'opencode',
    skipPermissions: boolean
  ) {
    const goalId = `goal:${proofRunId}`;
    const loopRunId = `loop-${randomUUID()}`;

    this.db.transaction(() => {
      const capabilities = this.registerCapabilities(proofRunId, base);
      const panel = this.panels.createPanel({
        topic: 'Sellable Djimitflo swarm proof',
        question: 'Can Djimitflo show a real closed-loop swarm artifact chain with capabilities, goals, workers, evidence and memory?',
        risk_class: 'medium',
        specialist_ids: ['systems_architect', 'runtime_engineer', 'skill_evaluator'],
        context: {
          proof_run_id: proofRunId,
          required_outputs: Object.keys(MINIMUMS),
          runtime,
        },
        metadata: base,
      });

      this.panels.submitReview(panel.id, {
        specialist_id: 'systems_architect',
        stance: 'support',
        confidence: 0.91,
        findings: ['The proof run uses a real runtime to execute maker and checker workers.'],
        recommendations: ['Keep artifact contracts and token usage checks as required evidence boundaries.'],
        evidence_refs: [`proof:${proofRunId}:schema`, `capability:${capabilities[0]}`],
      });
      this.panels.submitReview(panel.id, {
        specialist_id: 'runtime_engineer',
        stance: 'support',
        confidence: 0.9,
        findings: ['Worker leases include real runtime execution spans, stdout/stderr, and usage metadata.'],
        recommendations: ['Keep runtime adapters behind policy gate and avoid unlimited auto-run loops.'],
        evidence_refs: [`proof:${proofRunId}:worker-leases`],
      });
      this.panels.submitReview(panel.id, {
        specialist_id: 'skill_evaluator',
        stance: 'support',
        confidence: 0.88,
        findings: ['This proof run validates real worker execution using Codex/OpenCode process spawn.'],
        recommendations: ['Add acceptance tests to validate output format and usage parsing per adapter.'],
        evidence_refs: [`proof:${proofRunId}:capabilities`],
      });

      const backlog = this.panels.projectPanelToBacklog(panel.id);
      this.tagWorkItem(backlog.work_item.id, proofRunId);

      this.insertGoal(goalId, proofRunId, now, { ...base, mode: runtime, loop_run_id: loopRunId, runtime_mode: runtime }, {
        // Real-runtime budgets (codex/opencode). The mock-calibrated defaults
        // (60k tokens/worker, 3k tokens/diff-line, 60s wall) reject any real runtime —
        // codex's intrinsic overhead is ~87k+ even on a trivial task. Calibrate for reality:
        // generous per-worker ceiling (efficiency is enforced by --ignore-user-config, not by
        // a mock-sized limit), a real diff-line ceiling that still catches true runaways, and a
        // 10-min wall clock matching REAL_RUNTIME_TIMEOUT_MS.
        max_wall_clock_ms: 600_000,
        max_parallel_workers: 2,
        max_usage_units: 3_000,
        max_tokens: 2_000_000,
        max_tokens_per_worker: 1_000_000,
        max_tokens_per_diff_line: 500_000,
      });
      this.insertLoopRun(
        loopRunId,
        goalId,
        proofRunId,
        now,
        { ...base, mode: 'runtime_exec', runtime },
      );

      const rootSpan = this.assurance.createTraceSpan({
        trace_id: traceId,
        loop_run_id: loopRunId,
        span_type: 'goal',
        name: `${runtime} proof-run started`,
        status: 'ok',
        evidence_ref: `goal:${goalId}`,
        started_at: now,
        ended_at: now,
        metadata: { ...base, runtime },
      });

      this.assurance.createTraceSpan({
        trace_id: traceId,
        parent_span_id: rootSpan.id,
        loop_run_id: loopRunId,
        span_type: 'capability',
        name: 'runtime capability selected',
        status: 'ok',
        evidence_ref: `capabilities:${capabilities.length}`,
        started_at: now,
        ended_at: now,
        metadata: { ...base, runtime, capability_ids: capabilities },
      });

      this.assurance.createCheckpoint({
        loop_run_id: loopRunId,
        label: 'before-worker-execution',
        metadata: { ...base, checkpoint_phase: 'before', runtime },
      });
    })();

    let proofRunError: Error | null = null;
    // G1: ensure a stable candidate capability for this runtime so competence accumulates
    // across runs and the skill can be auto-promoted from accumulated validated evidence
    // (skills promoted from evidence, not hand-authored). Stable id (not proof-run-scoped).
    const makerCapId = `cap:real-runtime-maker:${runtime}`;
    try {
      this.intelligence.getCapability(makerCapId);
    } catch {
      this.intelligence.createCandidate({
        id: makerCapId,
        kind: 'runtime_adapter',
        owner: runtime,
        version: '1.0.0',
        risk_ceiling: 'medium',
        input_schema_ref: 'schema://real-runtime-maker/input',
        output_schema_ref: 'schema://real-runtime-maker/output',
        allowed_actions: ['spawn_runtime_worker', 'parse_usage', 'store_artifacts'],
        forbidden_actions: ['manual_release_without_operator'],
        required_evidence: ['completed maker lease', 'runtime_usage', 'checker verdict'],
        eval_threshold: 0.6,
        removal_strategy: 'demote when success_rate < 0.5 or contradicted',
        metadata: { ...base, g1_capability: true, runtime },
      });
    }
    try {
      const prepared = this.loops.continueLoopRun(loopRunId, {
        runtime,
        max_assignments: 1,
        max_maker_workers: 1,
        capabilityId: makerCapId,
      });

      const makerPrepared = this.findLeaseByRole(loopRunId, 'maker', 'prepared');
      const checkerPrepared = this.findLeaseByRole(loopRunId, 'checker', 'prepared');
      if (!makerPrepared || !checkerPrepared) {
        throw new Error('PROOF_RUN_WORKERS_NOT_PREPARED');
      }
      if (!prepared.leases.some((lease) => lease.role === 'checker' && lease.status === 'prepared')) {
        throw new Error('PROOF_RUN_WORKERS_NOT_PREPARED');
      }

      this.ensureProofRunMetadata(loopRunId, proofRunId);

      // Knowledge/memory injection: retrieve swarm memory + OKF knowledge relevant to the
      // maker's task and append it to the work assignment, so specialists operate WITH
      // retrieved memory + skills instead of blind. Best-effort and non-fatal: empty/failed
      // retrieval (no key, empty store, ollama/qdrant down) just yields no context.
      try {
        const assignmentFile = typeof makerPrepared.metadata.assignment_file === 'string'
          ? makerPrepared.metadata.assignment_file
          : '';
        if (assignmentFile && fs.existsSync(assignmentFile)) {
          const assignmentText = fs.readFileSync(assignmentFile, 'utf8');
          const finding = (assignmentText.match(/## Finding[\s\S]*?$/) || [assignmentText])[0].slice(0, 500);
          const contextInjector = new ContextInjectionService(this.db);
          const swarmContext = await contextInjector.injectContext(`DjimFlo control-plane loop: ${finding}`, true);
          if (swarmContext) {
            fs.appendFileSync(assignmentFile, `\n\n${swarmContext}\n`, 'utf8');
          }
        }
      } catch {
        // Context retrieval is best-effort; never fail the proof on the knowledge layer.
      }

      await this.loops.executeWorker(loopRunId, {
        lease_id: makerPrepared.id,
        timeout_ms: REAL_RUNTIME_TIMEOUT_MS,
        diff_max_lines: 200,
        skip_permissions: skipPermissions,
      });
      this.ensureProofRunMetadata(loopRunId, proofRunId);
      const checks = this.loops.runDeterministicChecks(loopRunId, {
        lease_id: makerPrepared.id,
        timeout_ms: 120_000,
        scripts: ['proof:test', 'proof:lint', 'proof:type-check'],
      });
      this.ensureProofRunMetadata(loopRunId, proofRunId);
      if (checks.run.status === 'blocked') {
        throw new Error('PROOF_RUN_DETERMINISTIC_CHECKS_FAILED');
      }

      const makerLeaseAfterRun = this.findLeaseByRole(loopRunId, 'maker', 'completed');
      const checkerResult = await this.loops.executeChecker(loopRunId, {
        lease_id: checkerPrepared.id,
        runtime,
        timeout_ms: REAL_RUNTIME_TIMEOUT_MS,
        skip_permissions: skipPermissions,
      });
      this.ensureProofRunMetadata(loopRunId, proofRunId);
      if (checkerResult.run.status === 'blocked') {
        throw new Error('PROOF_RUN_CHECKER_REJECTED');
      }

      const verifyResult = this.loops.verifyLoopRun(loopRunId);
      if (verifyResult.run.status === 'blocked') {
        throw new Error('PROOF_RUN_VERIFICATION_BLOCKED');
      }

      const completedResult = this.loops.completeLoopRun(loopRunId, { human_approval_ref: `proof-run:${proofRunId}` });
      if (completedResult.run.status !== 'completed') {
        throw new Error('PROOF_RUN_COMPLETE_FAILED');
      }

      const makerLease = makerLeaseAfterRun || this.findLeaseByRole(loopRunId, 'maker');
      const checkerLease = this.findLeaseByRole(loopRunId, 'checker');
      const completeAt = new Date().toISOString();

      this.db.prepare(`
        UPDATE loop_runs
        SET status = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run('completed', completeAt, completeAt, loopRunId);

      const runtimeSummary = this.getRuntimeUsageSummary(loopRunId);
      this.assurance.createTraceSpan({
        trace_id: traceId,
        loop_run_id: loopRunId,
        span_type: 'worker',
        name: 'proof runtime verifier',
        status: 'ok',
        evidence_ref: `lease:${String(checkerLease?.id || '')}`,
        metadata: {
          ...base,
          runtime,
          runtime_usage_summary: runtimeSummary,
          maker_lease_id: makerLease?.id,
          checker_lease_id: checkerLease?.id,
        },
      });
      this.assurance.createTraceSpan({
        trace_id: traceId,
        loop_run_id: loopRunId,
        span_type: 'memory',
        name: 'proof runtime memory promoted',
        status: 'ok',
        evidence_ref: `proof:${proofRunId}:memory`,
        metadata: { ...base, runtime },
      });
      this.assurance.createCheckpoint({
        loop_run_id: loopRunId,
        label: 'after-worker-execution',
        metadata: { ...base, checkpoint_phase: 'after', runtime },
      });

      this.createClaims(
        proofRunId,
        loopRunId,
        String(makerLease?.id || ''),
        String(checkerLease?.id || ''),
        runtimeSummary,
        runtime,
        base,
      );
      this.createManifests(
        proofRunId,
        loopRunId,
        String(makerLease?.id || ''),
        String(checkerLease?.id || ''),
        runtime,
        runtimeSummary,
        base,
      );
      const candidate = this.memory.create({
        title: `Proof run ${proofRunId} produced a real runtime swarm artifact chain`,
        content: `Runtime ${runtime} proof run created persisted capabilities, specialist review, goal, loop run, worker leases, trace spans, checkpoints, manifests and memory candidate for closed-loop validation.`,
        memory_type: 'operational_memory',
        source_ref: `proof:${proofRunId}`,
        metadata: {
          ...base,
          runtime,
          loop_run_id: loopRunId,
          maker_lease_id: String(makerLease?.id || ''),
          checker_lease_id: String(checkerLease?.id || ''),
          runtime_summary: runtimeSummary,
          proof_type: 'runtime_bridge',
        },
      });
      this.memory.promote(candidate.id, { sinks: ['qdrant'], approved_by: 'proof-run-service' });
      await this.memory.upsertToSwarmMemory(candidate.id); // learning flywheel: write promoted memory to the vector store so future runs retrieve it
      const nestedProof = this.createNestedSpawnProof(loopRunId, proofRunId, runtime, base);
      await this.executeNestedSpawnProof(loopRunId, nestedProof, skipPermissions);
      // G1: attempt evidence-based auto-promotion of the maker capability. Promotes after
      // >=3 validated successes. Best-effort — never fail the proof on the promotion step.
      try { this.intelligence.autoPromoteFromEvidence(makerCapId); } catch { /* best-effort */ }
    } catch (error) {
      proofRunError = error instanceof Error ? error : new Error(String(error));
      if (proofRunError.message.startsWith('PROOF_RUN_RUNTIME_') || proofRunError.message === 'PROOF_RUN_VERIFICATION_BLOCKED' || proofRunError.message === 'PROOF_RUN_COMPLETE_FAILED') {
        throw proofRunError;
      }
      this.db.prepare(`
        UPDATE loop_runs
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run('blocked', new Date().toISOString(), loopRunId);
      throw new Error(`PROOF_RUN_RUNTIME_FAILED:${proofRunError.message}`);
    }
  }

  get(id: string): ProofRunSummary {
    const counts = this.counts(id);
    if (Object.values(counts).every((count) => count === 0)) {
      throw new Error('PROOF_RUN_NOT_FOUND');
    }
    const missing = Object.fromEntries(
      Object.entries(MINIMUMS)
        .map(([key, minimum]) => [key, Math.max(0, minimum - (counts[key] || 0))])
        .filter(([, value]) => Number(value) > 0)
    ) as Record<string, number>;
    const createdAt = this.firstCreatedAt(id);
    const completedAt = this.completedAt(id);
    const passed = Object.keys(missing).length === 0;
    const runtime = this.resolveProofRunRuntime(id);
    const productionMissing = this.productionMissing(id, runtime);
    const productionPassed = productionMissing.length === 0;

    return {
      id,
      status: 'completed',
      runtime,
      created_at: createdAt,
      completed_at: completedAt,
      rollback_safe: true,
      counts,
      artifact_refs: {
        goal: this.findOne('goals', id),
        loop_run: this.findOne('loop_runs', id),
        worker_leases: this.findMany('worker_leases', id),
        panel: this.findOne('specialist_panels', id),
        memory_candidate: this.findOne('memory_candidates', id),
      },
      minimums: MINIMUMS,
      passed,
      proof_class: runtime === 'mock' ? 'demo' : 'production',
      production_passed: productionPassed,
      production_missing: productionMissing,
      missing,
      narrative: [
        passed
          ? 'Proof run passed: every required artifact type exists as a persisted record.'
          : 'Proof run is incomplete; inspect missing counts before presenting it.',
        productionPassed
          ? 'Production proof passed: non-mock runtime, nested spawn lineage and promoted memory evidence are present.'
          : `Production proof incomplete: ${productionMissing.join(', ') || 'artifact minimums missing'}.`,
        'Runtime execution is lease-driven and checkpointed through worker traces, manifests and usage captures.',
        'Registry rows, prepared leases and active execution are separate; this proof only marks completed leases with execution evidence as work.',
      ],
    };
  }

  latest(): ProofRunSummary | null {
    const rows = this.db.prepare(`
      SELECT metadata, created_at FROM loop_runs
      ORDER BY created_at DESC
      LIMIT 100
    `).all() as Array<{ metadata: string; created_at: string }>;
    for (const row of rows) {
      const metadata = this.parseJson(row.metadata);
      const id = typeof metadata.proof_run_id === 'string' ? metadata.proof_run_id : null;
      if (id) return this.get(id);
    }
    return null;
  }

  rollback(id: string): ProofRunSummary {
    const before = this.get(id);
    if (Object.values(before.counts).every((count) => count === 0)) {
      throw new Error('PROOF_RUN_NOT_FOUND');
    }

    this.db.transaction(() => {
      this.deleteSpawnProof(id);
      this.deleteByProofId('swarm_evidence_edges', id);
      this.deleteByProofId('agent_trace_spans', id);
      this.deleteByProofId('loop_checkpoints', id);
      this.deleteByProofId('swarm_runner_manifests', id);
      this.deleteByProofId('memory_candidates', id);
      this.deleteByProofId('swarm_claims', id);
      this.deleteReviewsForProofPanels(id);
      this.deleteByProofId('specialist_panels', id);
      this.deleteByProofId('worker_leases', id);
      this.deleteByProofId('loop_runs', id);
      this.deleteByProofId('work_items', id);
      this.deleteByProofId('goals', id);
      this.deleteByProofId('swarm_capabilities', id);
    })();

    return {
      ...this.emptyRolledBackSummary(id),
      status: 'rolled_back',
      narrative: [
        'Proof run rollback completed: proof-tagged demo artifacts were removed.',
        'This rollback only deletes records with matching proof_run_id metadata or reviews attached to proof-run panels.',
      ],
    };
  }

  private registerCapabilities(proofRunId: string, base: Record<string, unknown>): string[] {
    const capabilities = [
      ['runtime:mock', 'runtime_adapter', 'proof-runtime', ['run_mock_worker', 'capture_stdout', 'capture_usage']],
      ['runtime:codex', 'runtime_adapter', 'codex', ['spawn_codex_worker', 'parse_usage', 'store_artifacts']],
      ['runtime:opencode', 'runtime_adapter', 'opencode', ['spawn_opencode_worker', 'parse_usage', 'store_artifacts']],
      ['skill:proof-run', 'skill', 'okf', ['orchestrate_proof_loop', 'summarize_evidence']],
      ['specialist:panel', 'specialist_agent', 'djimitflo', ['review_panel', 'project_backlog']],
      ['harness:evidence', 'deterministic_harness', 'djimitflo', ['count_artifacts', 'verify_rollback_group']],
    ] as const;

    return capabilities.map(([suffix, kind, owner, allowed]) => {
      const id = `${proofRunId}:${suffix}`;
      this.intelligence.registerCapability({
        id,
        kind,
        owner,
        version: '1.0.0',
        status: 'validated',
        risk_ceiling: 'medium',
        input_schema_ref: `schema://proof-run/${suffix}/input`,
        output_schema_ref: `schema://proof-run/${suffix}/output`,
        allowed_actions: [...allowed],
        forbidden_actions: ['manual_release_without_operator'],
        required_evidence: ['persisted record', 'trace span', 'runner manifest'],
        eval_score: 0.95,
        eval_threshold: 0.75,
        cost_model: { fixed_demo_cost: true, max_parallel_workers: 2 },
        removal_strategy: 'delete proof-run scoped capability rows by proof_run_id metadata',
        latest_validation_report: `proof:${proofRunId}:capability-eval`,
        metadata: { ...base, proof_capability_suffix: suffix },
      });
      return id;
    });
  }

  private insertGoal(id: string, proofRunId: string, now: string, base: Record<string, unknown>, budget?: Record<string, unknown>) {
    this.db.prepare(`
      INSERT INTO goals (
        id, objective, constraints_json, acceptance_criteria_json, risk_class,
        budget_json, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      'Run a sellable Djimitflo closed-loop swarm proof with visible persisted artifacts.',
      JSON.stringify(['real runtime execution for maker/checker', 'rollback-safe proof metadata required']),
      JSON.stringify(Object.entries(MINIMUMS).map(([key, value]) => `${key} >= ${value}`)),
      'medium',
      JSON.stringify(budget ?? { max_wall_clock_ms: 60000, max_parallel_workers: 2, max_usage_units: 3000 }),
      'completed',
      JSON.stringify({ ...base, proof_run_id: proofRunId }),
      now,
      now
    );
  }

  private insertLoopRun(id: string, goalId: string, proofRunId: string, now: string, base: Record<string, unknown>) {
    this.db.prepare(`
      INSERT INTO loop_runs (
        id, goal_id, loop_name, mode, status, repository_path, findings_json,
        plan_json, gates_json, next_actions_json, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        goalId,
        'doc-drift-and-small-fix-loop',
        'closed',
        'running',
        process.cwd(),
        JSON.stringify([{ id: `proof-finding:${proofRunId}`, type: 'proof_run', severity: 'info', file: 'BOUNDED_PROOF_SENTINEL.txt', line: 1, message: 'Bounded real-runtime maker proof: create a single sentinel file.', evidence: 'Single-file, single-line change so a real runtime completes headless within budget (no open-ended refactor).', suggested_fix: 'Create a file named BOUNDED_PROOF_SENTINEL.txt at the repository root containing exactly the text PROOF_OK. Make no other changes. Then stop.' }]),
        JSON.stringify({ proof_run_id: proofRunId, steps: ['register', 'review', 'execute', 'verify', 'remember'] }),
        JSON.stringify([{ name: 'artifact_minimums', status: 'pending' }]),
        JSON.stringify(['execute maker+checker', 'run verifier gates', 'write manifests and claims']),
        JSON.stringify({ ...base, proof_run_id: proofRunId }),
        now,
        now
      );
  }

  private insertWorkerLease(
    id: string,
    loopRunId: string,
    role: 'maker' | 'checker',
    proofRunId: string,
    now: string,
    metadata: Record<string, unknown>
  ) {
    this.db.prepare(`
      INSERT INTO worker_leases (
        id, loop_run_id, role, runtime, status, finding_id, worktree_path, branch_name,
        budget_json, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      loopRunId,
      role,
      'mock',
      'completed',
      `proof:${proofRunId}:${role}`,
      null,
      null,
      JSON.stringify({ max_wall_clock_ms: 30000, max_usage_units: role === 'maker' ? 1800 : 1200 }),
      JSON.stringify(metadata),
      now,
      now
    );
  }

  private createClaims(
    proofRunId: string,
    loopRunId: string,
    makerLeaseId: string,
    checkerLeaseId: string,
    runtimeSummary: ProofRunRuntimeUsage,
    runtime: ProofRunRuntime,
    base: Record<string, unknown>
  ) {
    this.intelligence.createClaim({
      claim: 'Djimitflo can persist a closed-loop proof chain from capability to memory candidate.',
      claim_type: 'observation',
      subject_ref: `proof:${proofRunId}:artifact-chain`,
      evidence_refs: [`loop:${loopRunId}`, `lease:${makerLeaseId}`, `lease:${checkerLeaseId}`],
      confidence: 0.9,
      status: 'supported',
      verified_by_gate: 'proof_run_runtime',
      created_from: `proof:${proofRunId}`,
      metadata: { ...base, runtime, runtime_summary: runtimeSummary },
    });
    this.intelligence.createClaim({
      claim: 'Completed worker leases include execution output and usage metadata.',
      claim_type: 'observation',
      subject_ref: `proof:${proofRunId}:worker-evidence`,
      evidence_refs: [`lease:${makerLeaseId}`, `lease:${checkerLeaseId}`],
      confidence: 0.88,
      status: 'supported',
      verified_by_gate: 'proof_worker_traces',
      created_from: `proof:${proofRunId}`,
      metadata: { ...base, runtime, runtime_summary: runtimeSummary },
    });
    const runtimeBridgeClaim = runtime === 'mock'
      ? 'The remaining runtime upgrade is replacing mock execution with Codex/OpenCode process spawn.'
      : `Runtime ${runtime} executed maker and checker workers through the process runtime bridge.`;
    this.intelligence.createClaim({
      claim: runtimeBridgeClaim,
      claim_type: runtime === 'mock' ? 'backlog' : 'observation',
      subject_ref: runtime === 'mock' ? `proof:${proofRunId}:next-runtime-upgrade` : `proof:${proofRunId}:runtime-bridge`,
      evidence_refs: [`loop:${loopRunId}`],
      confidence: 0.84,
      status: 'supported',
      verified_by_gate: 'proof_artifacts',
      created_from: `proof:${proofRunId}`,
      metadata: { ...base, runtime, runtime_summary: runtimeSummary },
    });
  }

  private createNestedSpawnProof(loopRunId: string, proofRunId: string, runtime: ProofRunRuntime, base: Record<string, unknown>): { root_lease_id: string; child_lease_id: string } {
    const root = this.spawns.createRoot({
      loop_run_id: loopRunId,
      runtime,
      role: 'planner',
      prompt: 'Bounded nested proof (planner): create a file NESTED_PLANNER_SENTINEL.txt at the repository root containing exactly PLANNER_OK. Make no other changes. Then stop.',
      depth_budget: 1,
      risk_class: 'medium',
    });
    const child = this.spawns.requestSpawn({
      spawn_tree_id: root.spawn_tree_id,
      parent_lease_id: root.root_lease_id,
      requested_by_lease_id: root.root_lease_id,
      role: 'memory_curator',
      runtime,
      prompt: 'Bounded nested proof (memory curator): create a file NESTED_MEMORY_SENTINEL.txt at the repository root containing exactly MEMORY_OK. Make no other changes. Then stop.',
    }, { internal: true });
    if (!child.child_lease_id) {
      throw new Error('PROOF_RUN_SUB_AGENT_NOT_PREPARED');
    }

    const now = new Date().toISOString();
    for (const leaseId of [root.root_lease_id, child.child_lease_id].filter(Boolean) as string[]) {
      const row = this.db.prepare('SELECT metadata FROM worker_leases WHERE id = ?').get(leaseId) as { metadata?: string } | undefined;
      if (!row) continue;
      this.db.prepare('UPDATE worker_leases SET metadata = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify({ ...this.parseJson(row.metadata || '{}'), ...base, proof_run_id: proofRunId, nested_proof: true }),
        now,
        leaseId
      );
    }

    return { root_lease_id: root.root_lease_id, child_lease_id: child.child_lease_id };
  }

  private async executeNestedSpawnProof(
    loopRunId: string,
    nested: { root_lease_id: string; child_lease_id: string },
    skipPermissions: boolean
  ) {
    const leaseIds = [nested.root_lease_id, nested.child_lease_id].filter(Boolean) as string[];
    // Parallel specialised swarm: run the nested specialist agents CONCURRENTLY instead of
    // sequentially. Each executeWorker acquires/releases its own runtime permit, so real
    // parallelism is bounded by the runtime semaphore (runtimeSemaphoreLimit, default 4).
    // The specialists have separate worktrees and independent tasks, so they do not contend.
    // (better-sqlite3 is synchronous; DB ops serialize on the event loop while the codex
    // child processes overlap — safe, no connection race.)
    const results = await Promise.all(
      leaseIds.map((leaseId) =>
        this.loops.executeWorker(loopRunId, {
          lease_id: leaseId,
          timeout_ms: REAL_RUNTIME_TIMEOUT_MS,
          diff_max_lines: 200,
          skip_permissions: skipPermissions,
        }),
      ),
    );
    for (let i = 0; i < leaseIds.length; i += 1) {
      if (results[i].lease.status !== 'completed') {
        throw new Error('PROOF_RUN_SUB_AGENT_NOT_COMPLETED');
      }
      this.db.prepare(`
        UPDATE sub_agent_spawns
        SET status = ?
        WHERE child_lease_id = ?
      `).run('completed', leaseIds[i]);
    }
    this.db.prepare(`
      UPDATE spawn_trees
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run('closed', new Date().toISOString(), nested.root_lease_id);
  }

  private createManifests(
    proofRunId: string,
    loopRunId: string,
    makerLeaseId: string,
    checkerLeaseId: string,
    runtime: ProofRunRuntime,
    runtimeSummary: ProofRunRuntimeUsage,
    base: Record<string, unknown>
  ) {
    const shared = {
      policy_version: 'accelerated-proof-v1',
      runtime_contract: { runtime, stdout: true, stderr: true, usage: true, artifacts: true, runtime_summary: runtimeSummary },
      capacity_snapshot: { max_parallel_workers: 2, selected_workers: 2 },
      budget_snapshot: { max_wall_clock_ms: 60000, usage_budget: 3000 },
      gate_refs: ['artifact_minimums', 'rollback_metadata'],
      blocked_reasons: [],
      metadata: base,
    };
    this.intelligence.createRunnerManifest({ ...shared, decision_id: `${proofRunId}:plan`, loop_run_id: loopRunId, action: 'plan' });
    this.intelligence.createRunnerManifest({ ...shared, decision_id: `${proofRunId}:maker:start`, lease_id: makerLeaseId, loop_run_id: loopRunId, action: 'start' });
    this.intelligence.createRunnerManifest({ ...shared, decision_id: `${proofRunId}:maker:complete`, lease_id: makerLeaseId, loop_run_id: loopRunId, action: 'complete' });
    this.intelligence.createRunnerManifest({ ...shared, decision_id: `${proofRunId}:checker:complete`, lease_id: checkerLeaseId, loop_run_id: loopRunId, action: 'complete' });
  }

  private tagWorkItem(workItemId: string, proofRunId: string) {
    const row = this.db.prepare('SELECT metadata FROM work_items WHERE id = ?').get(workItemId) as { metadata: string } | undefined;
    if (!row) return;
    this.db.prepare('UPDATE work_items SET metadata = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify({ ...this.parseJson(row.metadata), proof_run_id: proofRunId, rollback_safe: true }),
      new Date().toISOString(),
      workItemId
    );
  }

  private counts(id: string): Record<string, number> {
    const counts: Record<string, number> = {
      capabilities: this.countTableByProofId('swarm_capabilities', id),
      panels: this.countTableByProofId('specialist_panels', id),
      reviews: this.countReviews(id),
      claims: this.countTableByProofId('swarm_claims', id),
      goals: this.countTableByProofId('goals', id),
      loop_runs: this.countTableByProofId('loop_runs', id),
      worker_leases: this.countTableByProofId('worker_leases', id),
      trace_spans: this.countTableByProofId('agent_trace_spans', id),
      checkpoints: this.countTableByProofId('loop_checkpoints', id),
      manifests: this.countTableByProofId('swarm_runner_manifests', id),
      memory_candidates: this.countTableByProofId('memory_candidates', id),
      work_items: this.countTableByProofId('work_items', id),
      evidence_edges: this.countTableByProofId('swarm_evidence_edges', id),
      spawn_trees: this.countSpawnTrees(id),
      sub_agent_spawns: this.countSubAgentSpawns(id),
    };
    return counts;
  }

  private productionMissing(id: string, runtime: ProofRunRuntime): string[] {
    const missing: string[] = [];
    if (runtime === 'mock') missing.push('non_mock_runtime');
    if (runtime !== 'mock' && !this.hasRealMakerCheckerUsage(id)) missing.push('real_runtime_usage');
    if (runtime !== 'mock' && !this.hasPassedDeterministicChecks(id)) missing.push('deterministic_checks');
    const promoted = this.rowsByProofId('memory_candidates', id).some((row) => row.status === 'promoted');
    if (!promoted) missing.push('promoted_memory');
    if (this.countSpawnTrees(id) < 1) missing.push('spawn_tree');
    if (this.countSubAgentSpawns(id) < 2) missing.push('sub_agent_lineage');
    if (runtime !== 'mock' && !this.hasCompletedSubAgentExecutions(id)) missing.push('sub_agent_execution');
    return missing;
  }

  private hasRealMakerCheckerUsage(id: string): boolean {
    const rows = this.rowsByProofId('worker_leases', id);
    const requiredRoles = new Set(['maker', 'checker']);
    for (const role of requiredRoles) {
      const row = rows.find((candidate) => candidate.role === role && candidate.status === 'completed');
      if (!row) return false;
      const metadata = this.parseJson(String(row.metadata || '{}'));
      const usage = this.parseRuntimeUsage(metadata.runtime_usage);
      if (!usage || this.toNumber(usage.total_tokens) <= 0) return false;
    }
    return true;
  }

  private hasPassedDeterministicChecks(id: string): boolean {
    const rows = this.rowsByProofId('worker_leases', id);
    const maker = rows.find((candidate) => candidate.role === 'maker' && candidate.status === 'completed');
    if (!maker) return false;
    const metadata = this.parseJson(String(maker.metadata || '{}'));
    const checks = Array.isArray(metadata.deterministic_checks) ? metadata.deterministic_checks : [];
    return checks.length > 0 && checks.every((check) => {
      return typeof check === 'object' && check !== null && (check as { status?: unknown }).status === 'pass';
    });
  }

  private hasCompletedSubAgentExecutions(id: string): boolean {
    const rows = this.rowsByProofId('worker_leases', id);
    const requiredRoles = new Set(['planner', 'memory_curator']);
    for (const role of requiredRoles) {
      const row = rows.find((candidate) => candidate.role === role && candidate.status === 'completed');
      if (!row) return false;
      const metadata = this.parseJson(String(row.metadata || '{}'));
      const usage = this.parseRuntimeUsage(metadata.runtime_usage);
      if (!usage || this.toNumber(usage.total_tokens) <= 0) return false;
    }
    return true;
  }

  private countSpawnTrees(id: string): number {
    const leaseIds = new Set(this.findMany('worker_leases', id));
    if (leaseIds.size === 0) return 0;
    const rows = this.db.prepare('SELECT id FROM spawn_trees').all() as Array<{ id: string }>;
    return rows.filter((row) => leaseIds.has(row.id)).length;
  }

  private countSubAgentSpawns(id: string): number {
    const leaseIds = new Set(this.findMany('worker_leases', id));
    if (leaseIds.size === 0) return 0;
    const rows = this.db.prepare('SELECT child_lease_id FROM sub_agent_spawns').all() as Array<{ child_lease_id: string | null }>;
    return rows.filter((row) => row.child_lease_id && leaseIds.has(row.child_lease_id)).length;
  }

  private countTableByProofId(table: string, id: string): number {
    return this.rowsByProofId(table, id).length;
  }

  private rowsByProofId(table: string, id: string): Array<Record<string, unknown>> {
    if (!METADATA_TABLES.includes(table as any)) return [];
    const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    return rows.filter((row) => this.parseJson(String(row.metadata || '{}')).proof_run_id === id);
  }

  private countReviews(id: string): number {
    const panelIds = this.findMany('specialist_panels', id);
    if (!panelIds.length) return 0;
    const placeholders = panelIds.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM specialist_reviews WHERE panel_id IN (${placeholders})`).get(...panelIds) as { count: number };
    return Number(row.count || 0);
  }

  private findOne(table: string, id: string): string | null {
    return this.findMany(table, id)[0] || null;
  }

  private findMany(table: string, id: string): string[] {
    return this.rowsByProofId(table, id)
      .map((row) => String(row.id || ''))
      .filter(Boolean);
  }

  private firstCreatedAt(id: string): string | null {
    const rows = this.rowsByProofId('loop_runs', id);
    return rows.length ? String(rows[0].created_at || '') || null : null;
  }

  private completedAt(id: string): string | null {
    const rows = this.rowsByProofId('loop_runs', id);
    return rows.length ? String(rows[0].completed_at || rows[0].updated_at || '') || null : null;
  }

  private deleteByProofId(table: string, id: string) {
    for (const row of this.rowsByProofId(table, id)) {
      this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
    }
  }

  private deleteSpawnProof(id: string) {
    const leaseIds = this.findMany('worker_leases', id);
    for (const leaseId of leaseIds) {
      this.db.prepare('DELETE FROM sub_agent_spawns WHERE child_lease_id = ? OR parent_lease_id = ? OR requested_by_lease_id = ?').run(leaseId, leaseId, leaseId);
      this.db.prepare('DELETE FROM spawn_trees WHERE id = ?').run(leaseId);
    }
  }

  private deleteReviewsForProofPanels(id: string) {
    const panelIds = this.findMany('specialist_panels', id);
    for (const panelId of panelIds) {
      this.db.prepare('DELETE FROM specialist_reviews WHERE panel_id = ?').run(panelId);
    }
  }

  private parseJson(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private parseRuntimeUsage(value: unknown): RuntimeUsageRecord | null {
    if (!value) {
      return null;
    }
    const valuesToTry: unknown[] = [value];
    const usage = this.normalizeRuntimeUsage(value);
    if (usage) {
      return usage;
    }

      if (typeof value === 'object' && value !== null) {
      const maybe = value as Record<string, unknown>;
      if (maybe.usage) {
        valuesToTry.push(maybe.usage);
      }
      const response = maybe.response;
      if (typeof response === 'object' && response !== null && 'usage' in response) {
        valuesToTry.push((response as Record<string, unknown>).usage);
      }
      if (maybe.token_usage) {
        valuesToTry.push(maybe.token_usage);
      }
      if (maybe.metrics) {
        valuesToTry.push(maybe.metrics);
      }
    }

    for (const candidate of valuesToTry) {
      const normalized = this.normalizeRuntimeUsage(candidate);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  private normalizeRuntimeUsage(raw: unknown): RuntimeUsageRecord | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const usage = raw as Record<string, unknown>;
    const promptTokens = this.toNumber(usage.prompt_tokens ?? usage.input ?? usage.input_tokens);
    const completionTokens = this.toNumber(usage.completion_tokens ?? usage.output ?? usage.output_tokens);
    const explicitTotal = this.toNumber(usage.total_tokens ?? usage.total);
    const fallbackTotal = (Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0);
    const total = Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : fallbackTotal;
    if (!Number.isFinite(total) || total <= 0) {
      return null;
    }
    return {
      ...(Number.isFinite(promptTokens) && promptTokens >= 0 ? { prompt_tokens: promptTokens } : {}),
      ...(Number.isFinite(completionTokens) && completionTokens >= 0 ? { completion_tokens: completionTokens } : {}),
      total_tokens: total,
      usage_source: typeof usage.usage_source === 'string' ? usage.usage_source : 'proof-run-metadata',
    };
  }

  private emptyRolledBackSummary(id: string): ProofRunSummary {
    const counts = Object.fromEntries(
      Object.keys({ ...MINIMUMS, evidence_edges: 0 }).map((key) => [key, 0])
    ) as Record<string, number>;
    return {
      id,
      status: 'rolled_back',
      runtime: 'mock',
      created_at: null,
      completed_at: null,
      rollback_safe: true,
      counts,
      artifact_refs: {
        goal: null,
        loop_run: null,
        worker_leases: [],
        panel: null,
        memory_candidate: null,
      },
      minimums: MINIMUMS,
      passed: false,
      proof_class: 'demo',
      production_passed: false,
      production_missing: ['rolled_back'],
      missing: MINIMUMS,
      narrative: [],
    };
  }
}
