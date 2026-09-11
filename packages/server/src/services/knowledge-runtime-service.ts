import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { Database } from 'better-sqlite3';
import { AgentAssuranceService, type EvalRunRecord, type ReflectionCandidateRecord } from './agent-assurance-service';
import { LoopService } from './loop-service';
import { LoopVerificationService } from './loop-verification-service';
import { MemoryCandidateService, type MemoryCandidateRecord } from './memory-candidate-service';
import { WorkItemService, type WorkItemRecord } from './work-item-service';

type CapabilityKind = 'skill' | 'specialist_agent' | 'runtime_adapter' | 'deterministic_harness' | 'memory_source' | 'dashboard_action';
type RiskClass = 'low' | 'medium' | 'high' | 'critical';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CANONICAL_OKF_PATH = path.join(REPO_ROOT, 'knowledge');
const LEGACY_PACKAGES_KNOWLEDGE = path.join(REPO_ROOT, 'packages', 'knowledge');
const OKF_FOLDERS = ['skills', 'agents', 'memory', 'services', 'repos', 'models'] as const;
const CONTRACT_KEYS = ['allowed_actions', 'forbidden_actions', 'required_evidence', 'risk_ceiling', 'eval_threshold', 'removal_strategy'] as const;

export interface KnowledgeRuntimeHealth {
  okf_base: string | null;
  canonical_candidate: string;
  symlink_target: string | null;
  exists: boolean;
  valid: boolean;
  validate_okf: {
    status: 'pass' | 'fail' | 'skipped';
    command: string | null;
    stdout: string;
    stderr: string;
  };
  counts: Record<string, number>;
  drift: {
    okf_skill_count: number;
    registered_skill_capability_count: number;
    missing_registry_entries: string[];
    stale_registry_entries: string[];
    packages_knowledge_is_canonical: boolean;
    projection_status: 'unknown' | 'fresh' | 'stale';
  };
  blocked_reasons: string[];
  next_safe_actions: string[];
}

export interface KnowledgeSyncResult {
  dry_run: boolean;
  okf_base: string;
  created: number;
  updated: number;
  blocked: number;
  unchanged: number;
  capabilities: Array<Record<string, unknown>>;
}

export interface LoopLearningClosureResult {
  action: 'closed_loop_learning';
  loop_run_id: string;
  status: 'closed' | 'blocked';
  blocked_reasons: string[];
  eval_run: EvalRunRecord | null;
  previous_score: number | null;
  score_delta: number | null;
  reflection: ReflectionCandidateRecord | null;
  memory_candidate: MemoryCandidateRecord | null;
  follow_up_work_item: WorkItemRecord | null;
  skill_improvement_work_item: WorkItemRecord | null;
}

interface ParsedOkfFile {
  slug: string;
  file: string;
  rel: string;
  folder: string;
  body: string;
  frontmatter: Record<string, unknown>;
  hash: string;
}

export class KnowledgeRuntimeService {
  private assurance: AgentAssuranceService;
  private memory: MemoryCandidateService;
  private workItems: WorkItemService;

  constructor(private db: Database) {
    this.assurance = new AgentAssuranceService(db);
    this.memory = new MemoryCandidateService(db);
    this.workItems = new WorkItemService(db);
  }

  static resolveCanonicalOkfBase(options: { allowMissing?: boolean } = {}): string {
    const envBase = process.env.OKF_BASE?.trim();
    const candidate = envBase ? path.resolve(envBase) : CANONICAL_OKF_PATH;
    const resolvedLegacy = this.realpathSafe(LEGACY_PACKAGES_KNOWLEDGE) || LEGACY_PACKAGES_KNOWLEDGE;
    const resolvedCandidate = this.realpathSafe(candidate) || candidate;
    if (resolvedCandidate === resolvedLegacy) {
      throw new Error('KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL');
    }
    if (!options.allowMissing && !fs.existsSync(candidate)) {
      throw new Error('KNOWLEDGE_RUNTIME_OKF_BASE_MISSING');
    }
    return candidate;
  }

  static repoKnowledgePath(): string {
    return CANONICAL_OKF_PATH;
  }

  health(): KnowledgeRuntimeHealth {
    let okfBase: string | null = null;
    const blockedReasons: string[] = [];
    try {
      okfBase = KnowledgeRuntimeService.resolveCanonicalOkfBase();
    } catch (error) {
      blockedReasons.push(error instanceof Error ? error.message : String(error));
      okfBase = fs.existsSync(CANONICAL_OKF_PATH) ? CANONICAL_OKF_PATH : null;
    }

    const exists = Boolean(okfBase && fs.existsSync(okfBase));
    const symlinkTarget = fs.existsSync(CANONICAL_OKF_PATH) && fs.lstatSync(CANONICAL_OKF_PATH).isSymbolicLink()
      ? fs.readlinkSync(CANONICAL_OKF_PATH)
      : null;
    const validate = okfBase && exists ? this.validateOkf(okfBase) : { status: 'fail' as const, command: null, stdout: '', stderr: 'OKF base missing' };
    if (validate.status === 'fail') blockedReasons.push('KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');

    const counts = okfBase && exists ? this.countOkfFiles(okfBase) : this.emptyCounts();
    const drift = okfBase && exists ? this.drift(okfBase) : {
      okf_skill_count: 0,
      registered_skill_capability_count: 0,
      missing_registry_entries: [],
      stale_registry_entries: [],
      packages_knowledge_is_canonical: false,
      projection_status: 'unknown' as const,
    };
    if (drift.packages_knowledge_is_canonical) blockedReasons.push('KNOWLEDGE_RUNTIME_PACKAGES_KNOWLEDGE_NOT_CANONICAL');
    if (drift.missing_registry_entries.length > 0) blockedReasons.push('KNOWLEDGE_RUNTIME_CAPABILITY_SYNC_REQUIRED');

    return {
      okf_base: okfBase,
      canonical_candidate: CANONICAL_OKF_PATH,
      symlink_target: symlinkTarget,
      exists,
      valid: exists && validate.status === 'pass' && blockedReasons.length === 0,
      validate_okf: validate,
      counts,
      drift,
      blocked_reasons: [...new Set(blockedReasons)],
      next_safe_actions: this.nextSafeActions(validate.status, drift, blockedReasons),
    };
  }

  syncCapabilities(input: { dry_run?: boolean; apply?: boolean } = {}): KnowledgeSyncResult {
    const dryRun = input.apply === true ? false : input.dry_run !== false;
    const health = this.health();
    if (!health.okf_base || !health.exists) throw new Error('KNOWLEDGE_RUNTIME_OKF_BASE_MISSING');
    if (health.validate_okf.status !== 'pass' && !dryRun) throw new Error('KNOWLEDGE_RUNTIME_OKF_VALIDATION_FAILED');

    const parsed = [
      ...this.readFolder(health.okf_base, 'skills'),
      ...this.readFolder(health.okf_base, 'agents'),
      ...this.readFolder(health.okf_base, 'services'),
    ];

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let blocked = 0;
    const capabilities: Array<Record<string, unknown>> = [];

    for (const file of parsed) {
      const capability = this.capabilityFromOkf(file);
      const existing = this.db.prepare('SELECT version, metadata FROM swarm_capabilities WHERE id = ?').get(capability.id) as { version?: string; metadata?: string } | undefined;
      const changed = !existing || existing.version !== capability.version;
      if (capability.blocked_reasons.length > 0) blocked += 1;
      if (!existing) created += 1;
      else if (changed) updated += 1;
      else unchanged += 1;

      if (!dryRun) this.upsertCapability(capability);
      capabilities.push({ ...capability, existing: Boolean(existing), changed });
    }

    return {
      dry_run: dryRun,
      okf_base: health.okf_base,
      created,
      updated,
      blocked,
      unchanged,
      capabilities,
    };
  }

  closeLoop(input: { loop_run_id?: string; work_item_id?: string; promote_memory?: boolean } = {}): LoopLearningClosureResult {
    return this.db.transaction(() => this.closeLoopInTransaction(input))();
  }

  private closeLoopInTransaction(input: { loop_run_id?: string; work_item_id?: string; promote_memory?: boolean } = {}): LoopLearningClosureResult {
    const loopRunId = input.loop_run_id?.trim();
    if (!loopRunId) throw new Error('KNOWLEDGE_RUNTIME_LOOP_RUN_REQUIRED');
    const loops = new LoopService(this.db);
    const bundle = loops.getReviewBundle(loopRunId);
    const closure = this.db.prepare('SELECT * FROM loop_learning_closures WHERE loop_run_id = ?').get(loopRunId) as {
      eval_run_id: string; reflection_id: string; memory_candidate_id: string; previous_score: number | null; score_delta: number | null;
    } | undefined;
    const leases = bundle.leases;
    const supersededMakerIds = new Set(leases.filter(lease => loops.isSupersededMakerLease(lease)).map(lease => lease.id));
    const activeLeases = leases.filter(lease => !supersededMakerIds.has(lease.id)
      && !((lease.role === 'checker' || lease.role === 'security_checker')
        && typeof lease.metadata.maker_lease_id === 'string' && supersededMakerIds.has(lease.metadata.maker_lease_id)));
    const makers = activeLeases.filter(lease => lease.role === 'maker');
    const review = new LoopVerificationService(loops);
    const blockedReasons: string[] = [];
    if (!['completed', 'ready_for_human_merge'].includes(bundle.run.status)) blockedReasons.push('run_not_reviewed_terminal');
    if (bundle.run.metadata.operator_paused === true || (bundle.run.goal_id && loops.getGoal(bundle.run.goal_id).metadata.operator_paused === true)) blockedReasons.push('operator_paused');
    if (makers.length === 0 || makers.some(lease => lease.status !== 'completed')) blockedReasons.push('maker_not_completed');
    if (activeLeases.some(lease => lease.status !== 'completed')) blockedReasons.push('active_worker_not_completed');
    if (makers.some(maker => !activeLeases.some(lease => lease.role === 'checker'
      && lease.metadata.maker_lease_id === maker.id && review.hasAcceptedReviewEvidence(lease)))) blockedReasons.push('checker_not_accepted');
    if (activeLeases.some(lease => (lease.role === 'checker' || lease.role === 'security_checker') && !review.hasAcceptedReviewEvidence(lease))) blockedReasons.push('review_evidence_invalid');
    if (loops.isHighRiskRun(bundle.run) && makers.some(maker => !activeLeases.some(lease => lease.role === 'security_checker'
      && lease.metadata.maker_lease_id === maker.id && review.hasAcceptedReviewEvidence(lease)))) blockedReasons.push('security_checker_not_accepted');
    if (bundle.run.gates.length === 0 || !bundle.run.gates.some(gate => gate.status === 'pass')) blockedReasons.push('gates_missing');
    if (bundle.run.gates.some(gate => gate.status !== 'pass' && gate.status !== 'skipped')) blockedReasons.push('gate_not_passed');
    const evidenceCounts = {
      trace_spans: this.count('SELECT COUNT(*) as count FROM agent_trace_spans WHERE loop_run_id = ?', [loopRunId]),
      checkpoints: this.count('SELECT COUNT(*) as count FROM loop_checkpoints WHERE loop_run_id = ?', [loopRunId]),
      runner_manifests: this.count('SELECT COUNT(*) as count FROM swarm_runner_manifests WHERE loop_run_id = ?', [loopRunId]),
    };
    for (const [kind, count] of Object.entries(evidenceCounts)) {
      if (count === 0) blockedReasons.push(`${kind}_missing`);
    }
    // Revalidate before replaying a historical closure. Preserve its records,
    // but do not certify them as current after cancellation or evidence loss.
    if (blockedReasons.length > 0) return this.emptyClosure(loopRunId, blockedReasons);
    if (closure) {
      this.bindImprovementEvaluation(loopRunId, closure.eval_run_id, closure.reflection_id);
      return {
        action: 'closed_loop_learning',
        loop_run_id: loopRunId,
        status: 'closed',
        blocked_reasons: [],
        eval_run: this.assurance.getEval(closure.eval_run_id),
        previous_score: closure.previous_score,
        score_delta: closure.score_delta,
        reflection: this.assurance.getReflection(closure.reflection_id),
        memory_candidate: this.memory.get(closure.memory_candidate_id),
        follow_up_work_item: null,
        skill_improvement_work_item: null,
      };
    }
    const previous = this.latestEval('loop-learning', 'loop', loopRunId);
    const evalRun = this.assurance.runEval({
      suite_name: 'loop-learning',
      target_type: 'loop',
      target_ref: loopRunId,
      metadata: { closure_pipeline: true, loop_run_id: loopRunId, work_item_id: input.work_item_id || null, evidence_counts: evidenceCounts },
    });
    const previousScore = previous?.score ?? null;
    const scoreDelta = previousScore === null ? null : Number((evalRun.score - previousScore).toFixed(4));
    const improved = scoreDelta !== null && scoreDelta > 0;
    const regressed = scoreDelta !== null && scoreDelta < 0;
    const lesson = `Loop ${loopRunId} closed with score ${evalRun.score.toFixed(2)}${scoreDelta === null ? ' as baseline' : ` (${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(2)} vs previous)`}; preserve checker evidence, gates and runtime artifacts for the next run.`;

    const reflection = this.assurance.createReflection({
      source_type: 'loop',
      source_ref: loopRunId,
      lesson,
      evidence_refs: [`loop:${loopRunId}`, `eval:${evalRun.id}`],
      metadata: { loop_run_id: loopRunId, eval_run_id: evalRun.id, previous_score: previousScore, score_delta: scoreDelta },
    });
    const memoryCandidate = this.memory.create({
      title: `Loop learning ${loopRunId.slice(0, 8)}`,
      content: lesson,
      memory_type: 'operational_memory',
      source_ref: `loop:${loopRunId}`,
      metadata: {
        loop_run_id: loopRunId,
        eval_run_id: evalRun.id,
        reflection_id: reflection.id,
        promote_memory_requested: Boolean(input.promote_memory),
      },
    });

    const followUp = regressed ? this.workItems.createIfMissingBySourceRef({
      title: `Repair loop learning regression ${loopRunId.slice(0, 8)}`,
      description: `Loop learning score regressed by ${scoreDelta}. Inspect eval ${evalRun.id} and preserve missing evidence before the next run.`,
      source: 'loop_learning_closure',
      source_ref: `regression:${evalRun.id}`,
      risk_class: 'low',
      value_score: 80,
      confidence: 0.82,
      status: 'candidate',
      recommended_loop: 'repo-maintenance-loop',
      metadata: { loop_run_id: loopRunId, eval_run_id: evalRun.id, previous_score: previousScore, score: evalRun.score },
    }).work_item : null;

    const skillImprovement = improved ? this.workItems.createIfMissingBySourceRef({
      title: `Promote repeatable skill from loop ${loopRunId.slice(0, 8)}`,
      description: `Loop learning improved by ${scoreDelta}. Extract the repeatable procedure into an OKF skill candidate after review.`,
      source: 'loop_learning_closure',
      source_ref: `skill-improvement:${evalRun.id}`,
      risk_class: 'low',
      value_score: 70,
      confidence: 0.75,
      status: 'candidate',
      recommended_loop: 'skill-quality-loop',
      metadata: { loop_run_id: loopRunId, eval_run_id: evalRun.id, reflection_id: reflection.id },
    }).work_item : null;

    this.db.prepare(`
      INSERT INTO loop_learning_closures (
        loop_run_id, eval_run_id, reflection_id, memory_candidate_id, previous_score, score_delta
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(loopRunId, evalRun.id, reflection.id, memoryCandidate.id, previousScore, scoreDelta);
    this.bindImprovementEvaluation(loopRunId, evalRun.id, reflection.id);

    return {
      action: 'closed_loop_learning',
      loop_run_id: loopRunId,
      status: 'closed',
      blocked_reasons: [],
      eval_run: evalRun,
      previous_score: previousScore,
      score_delta: scoreDelta,
      reflection,
      memory_candidate: memoryCandidate,
      follow_up_work_item: followUp,
      skill_improvement_work_item: skillImprovement,
    };
  }

  private bindImprovementEvaluation(loopRunId: string, evalId: string, reflectionId: string): void {
    const improvement = this.db.prepare(`
      SELECT si.id, si.evidence_refs_json FROM self_improvements si
      JOIN goals g ON g.improvement_id = si.id
      JOIN loop_runs lr ON lr.goal_id = g.id
      WHERE lr.id = ? AND lr.status = 'completed' AND g.status = 'completed'
        AND si.status = 'verified'
        AND NOT EXISTS (SELECT 1 FROM loop_runs other WHERE other.goal_id = g.id AND other.status != 'completed')
    `).get(loopRunId) as { id: string; evidence_refs_json: string } | undefined;
    if (!improvement) return;
    const previous: unknown = JSON.parse(improvement.evidence_refs_json || '[]');
    if (!Array.isArray(previous) || previous.some(ref => typeof ref !== 'string')) {
      throw new Error('SELF_IMPROVEMENT_EVIDENCE_INVALID');
    }
    const refs = previous as string[];
    this.db.prepare("UPDATE self_improvements SET status = 'evaluating', evidence_refs_json = ?, updated_at = ? WHERE id = ? AND status = 'verified'")
      .run(JSON.stringify([...new Set([...refs, `loop:${loopRunId}`, `eval:${evalId}`, `reflection:${reflectionId}`])]), new Date().toISOString(), improvement.id);
    // Structural evaluation starts measurement; it never implies applied,
    // no_change or regressed product outcomes, nor promotion or merge authority.
  }

  readOkfSpecialistProfiles(): Array<Record<string, unknown>> {
    const base = KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true });
    return this.readFolder(base, 'agents')
      .map((file) => this.specialistProfileFromOkf(file))
      .filter((profile): profile is Record<string, unknown> => profile !== null);
  }

  private validateOkf(okfBase: string): KnowledgeRuntimeHealth['validate_okf'] {
    const dataBase = fs.realpathSync(okfBase);
    // Trusted operator configuration only: data bundles need not contain tooling.
    // Never accept a request-supplied command or silently fall back on misconfiguration.
    const configuredScript = process.env.OKF_VALIDATOR_PATH?.trim();
    if (configuredScript && !path.isAbsolute(configuredScript)) {
      return { status: 'fail', command: null, stdout: '', stderr: 'OKF_VALIDATOR_PATH must be an absolute path to the trusted validator' };
    }
    const script = configuredScript || path.join(path.dirname(dataBase), 'tools', 'validate_okf.py');
    if (!fs.existsSync(script)) {
      return { status: 'fail', command: null, stdout: '', stderr: 'OKF validator not found; configure OKF_VALIDATOR_PATH or restore tools/validate_okf.py beside the data bundle' };
    }
    const repo = path.dirname(path.dirname(script));
    const command = `OKF_BASE=${JSON.stringify(dataBase)} python3 -B ${JSON.stringify(script)}`;
    try {
      const stdout = execFileSync('python3', ['-B', script], {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OKF_BASE: dataBase, PYTHONDONTWRITEBYTECODE: '1' },
        timeout: 10_000, killSignal: 'SIGKILL',
      });
      return { status: 'pass', command, stdout: stdout.trim(), stderr: '' };
    } catch (error) {
      return {
        status: 'fail',
        command,
        stdout: (error as { stdout?: Buffer | string }).stdout?.toString().trim() || '',
        stderr: (error as { stderr?: Buffer | string }).stderr?.toString().trim() || (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private countOkfFiles(okfBase: string): Record<string, number> {
    const counts = this.emptyCounts();
    for (const folder of OKF_FOLDERS) counts[folder] = this.readFolder(okfBase, folder).length;
    counts.total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return counts;
  }

  private emptyCounts(): Record<string, number> {
    return Object.fromEntries([...OKF_FOLDERS, 'total'].map((folder) => [folder, 0]));
  }

  private drift(okfBase: string): KnowledgeRuntimeHealth['drift'] {
    const skillFiles = this.readFolder(okfBase, 'skills');
    const skillSlugs = skillFiles.map((file) => file.slug);
    const capabilities = this.db.prepare("SELECT id, version, metadata FROM swarm_capabilities WHERE kind = 'skill'").all() as Array<{ id: string; version: string; metadata: string }>;
    const capabilityRefs = new Set<string>();
    const stale: string[] = [];
    for (const capability of capabilities) {
      const metadata = this.safeJson<Record<string, unknown>>(capability.metadata, {});
      const okfPath = String(metadata.okf_path || '');
      const slug = okfPath ? path.basename(okfPath, '.md') : capability.id.replace(/^skill:/, '');
      capabilityRefs.add(slug);
      const matching = skillFiles.find((file) => file.slug === slug);
      if (matching && capability.version !== matching.hash.slice(0, 12)) stale.push(slug);
    }
    return {
      okf_skill_count: skillSlugs.length,
      registered_skill_capability_count: capabilities.length,
      missing_registry_entries: skillSlugs.filter((slug) => !capabilityRefs.has(slug)),
      stale_registry_entries: stale,
      packages_knowledge_is_canonical: KnowledgeRuntimeService.realpathSafe(okfBase) === KnowledgeRuntimeService.realpathSafe(LEGACY_PACKAGES_KNOWLEDGE),
      projection_status: 'unknown',
    };
  }

  private readFolder(okfBase: string, folder: string): ParsedOkfFile[] {
    const dir = path.join(okfBase, folder);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith('.md') && file !== 'index.md')
      .sort()
      .map((file) => {
        const full = path.join(dir, file);
        const raw = fs.readFileSync(full, 'utf8');
        const { frontmatter, body } = this.parseMarkdown(raw);
        return {
          slug: path.basename(file, '.md'),
          file: full,
          rel: path.relative(okfBase, full),
          folder,
          body,
          frontmatter,
          hash: crypto.createHash('sha256').update(raw).digest('hex'),
        };
      });
  }

  private parseMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
    if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
    const end = raw.indexOf('---', 3);
    if (end < 0) return { frontmatter: {}, body: raw };
    const fm = raw.slice(3, end).trim();
    const frontmatter: Record<string, unknown> = {};
    for (const line of fm.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      frontmatter[match[1]] = this.parseFrontmatterValue(match[2]);
    }
    return { frontmatter, body: raw.slice(end + 3).trim() };
  }

  private parseFrontmatterValue(value: string): unknown {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1).split(',').map((item) => item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed.replace(/^["']|["']$/g, '');
  }

  private capabilityFromOkf(file: ParsedOkfFile) {
    const fm = file.frontmatter;
    const kind: CapabilityKind = file.folder === 'skills' ? 'skill' : file.folder === 'agents' ? 'specialist_agent' : 'memory_source';
    const id = `${kind === 'skill' ? 'skill' : kind === 'specialist_agent' ? 'specialist' : 'service'}:${file.slug}`;
    const allowed = this.arrayField(fm.allowed_actions);
    const forbidden = this.arrayField(fm.forbidden_actions);
    const evidence = this.arrayField(fm.required_evidence);
    const risk = this.riskField(fm.risk_ceiling);
    const evalThreshold = typeof fm.eval_threshold === 'number' ? fm.eval_threshold : Number(fm.eval_threshold || 0.75);
    const removalStrategy = String(fm.removal_strategy || '').trim();
    const missing = CONTRACT_KEYS.filter((key) => {
      if (key === 'allowed_actions') return allowed.length === 0;
      if (key === 'forbidden_actions') return forbidden.length === 0;
      if (key === 'required_evidence') return evidence.length === 0;
      if (key === 'risk_ceiling') return !risk;
      if (key === 'eval_threshold') return !Number.isFinite(evalThreshold);
      return !removalStrategy;
    });
    const blockedReasons = missing.map((key) => `missing_${key}`);
    const complete = blockedReasons.length === 0;

    return {
      id,
      kind,
      owner: String(fm.owner || 'okf'),
      version: file.hash.slice(0, 12),
      status: complete ? 'validated' : 'candidate',
      risk_ceiling: risk || 'low',
      input_schema_ref: String(fm.input_schema_ref || `${kind}:input:v1`),
      output_schema_ref: String(fm.output_schema_ref || `${kind}:output:v1`),
      allowed_actions: allowed.length ? allowed : ['advisory_only'],
      forbidden_actions: forbidden.length ? forbidden : ['route_live_workers'],
      required_evidence: evidence.length ? evidence : ['contract_completion_required'],
      eval_score: complete ? 0.8 : 0.2,
      eval_threshold: Number.isFinite(evalThreshold) ? Math.max(0, Math.min(evalThreshold, 1)) : 0.75,
      cost_model: {},
      removal_strategy: removalStrategy || 'Disable capability until OKF contract is completed.',
      latest_validation_report: file.rel,
      metadata: {
        okf_path: file.rel,
        okf_hash: file.hash,
        okf_folder: file.folder,
        title: fm.title || file.slug,
        source: 'okf',
        agent_skill_id: fm.agent_skill_id || null,
        agent_skill_version: fm.agent_skill_version || null,
        agent_skill_content_hash: fm.agent_skill_content_hash || null,
        agent_skill_manifest_hash: fm.agent_skill_manifest_hash || null,
        blocked_reasons: blockedReasons,
        body_excerpt: file.body.slice(0, 240),
      },
      blocked_reasons: blockedReasons,
    };
  }

  private upsertCapability(capability: ReturnType<KnowledgeRuntimeService['capabilityFromOkf']>): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO swarm_capabilities (
        id, kind, owner, version, status, risk_ceiling, input_schema_ref, output_schema_ref,
        allowed_actions_json, forbidden_actions_json, required_evidence_json, eval_score,
        eval_threshold, cost_model_json, removal_strategy, latest_validation_report,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        owner = excluded.owner,
        version = excluded.version,
        status = excluded.status,
        risk_ceiling = excluded.risk_ceiling,
        input_schema_ref = excluded.input_schema_ref,
        output_schema_ref = excluded.output_schema_ref,
        allowed_actions_json = excluded.allowed_actions_json,
        forbidden_actions_json = excluded.forbidden_actions_json,
        required_evidence_json = excluded.required_evidence_json,
        eval_score = excluded.eval_score,
        eval_threshold = excluded.eval_threshold,
        cost_model_json = excluded.cost_model_json,
        removal_strategy = excluded.removal_strategy,
        latest_validation_report = excluded.latest_validation_report,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `).run(
      capability.id,
      capability.kind,
      capability.owner,
      capability.version,
      capability.status,
      capability.risk_ceiling,
      capability.input_schema_ref,
      capability.output_schema_ref,
      JSON.stringify(capability.allowed_actions),
      JSON.stringify(capability.forbidden_actions),
      JSON.stringify(capability.required_evidence),
      capability.eval_score,
      capability.eval_threshold,
      JSON.stringify(capability.cost_model),
      capability.removal_strategy,
      capability.latest_validation_report,
      JSON.stringify(capability.metadata),
      now,
      now,
    );
  }

  private specialistProfileFromOkf(file: ParsedOkfFile): Record<string, unknown> | null {
    const fm = file.frontmatter;
    const id = String(fm.profile_id || fm.id || file.slug).trim();
    const domains = this.arrayField(fm.domains || fm.tags);
    const requiredEvidence = this.arrayField(fm.required_evidence);
    const forbiddenClaims = this.arrayField(fm.forbidden_claims);
    const outputSchema = this.arrayField(fm.output_schema || fm.output_schema_ref);
    if (!id || requiredEvidence.length === 0 || forbiddenClaims.length === 0 || outputSchema.length === 0) return null;
    return {
      id,
      version: file.hash.slice(0, 12),
      title: String(fm.title || id),
      domains,
      default_questions: this.arrayField(fm.default_questions),
      required_evidence: requiredEvidence,
      forbidden_claims: forbiddenClaims,
      output_schema: outputSchema,
      source: 'okf',
    };
  }

  private emptyClosure(loopRunId: string, blockedReasons: string[]): LoopLearningClosureResult {
    return {
      action: 'closed_loop_learning',
      loop_run_id: loopRunId,
      status: 'blocked',
      blocked_reasons: blockedReasons,
      eval_run: null,
      previous_score: null,
      score_delta: null,
      reflection: null,
      memory_candidate: null,
      follow_up_work_item: null,
      skill_improvement_work_item: null,
    };
  }

  private latestEval(suiteName: string, targetType: string, targetRef: string): { id: string; score: number } | null {
    const row = this.db.prepare(`
      SELECT eval.id, eval.score
      FROM agent_eval_runs eval
      LEFT JOIN loop_runs current_run ON current_run.id = ?
      LEFT JOIN loop_runs previous_run ON previous_run.id = eval.target_ref
      WHERE eval.suite_name = ? AND eval.target_type = ?
        AND eval.target_ref != ?
        AND current_run.loop_name IS NOT NULL
        AND previous_run.loop_name = current_run.loop_name
        AND COALESCE(previous_run.repository_path, '') = COALESCE(current_run.repository_path, '')
      ORDER BY eval.created_at DESC
      LIMIT 1
    `).get(targetRef, suiteName, targetType, targetRef) as { id: string; score: number } | undefined;
    return row || null;
  }

  private nextSafeActions(status: KnowledgeRuntimeHealth['validate_okf']['status'], drift: KnowledgeRuntimeHealth['drift'], blockedReasons: string[]): string[] {
    if (blockedReasons.includes('KNOWLEDGE_RUNTIME_OKF_BASE_MISSING')) return ['Set OKF_BASE or restore repo knowledge symlink'];
    if (status === 'fail') return ['Fix OKF validation before applying capability sync'];
    if (drift.missing_registry_entries.length > 0 || drift.stale_registry_entries.length > 0) return ['Run capability sync dry-run', 'Apply capability sync after review'];
    return ['Close completed loops through learning closure', 'Promote approved memory candidates', 'Reindex projections dry-run'];
  }

  private count(query: string, params: unknown[] = []): number {
    return ((this.db.prepare(query).get(...params) as any)?.count || 0) as number;
  }

  private arrayField(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
    return [];
  }

  private riskField(value: unknown): RiskClass | null {
    const risk = String(value || '').trim();
    return ['low', 'medium', 'high', 'critical'].includes(risk) ? risk as RiskClass : null;
  }

  private safeJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private static realpathSafe(candidate: string): string | null {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return null;
    }
  }

  // G15.1: OKF path allowlist — reject paths outside configured roots
  static isWithinOkfRoot(testPath: string): boolean {
    const resolved = this.realpathSafe(testPath);
    if (!resolved) return false;
    const canonicalResolved = this.realpathSafe(CANONICAL_OKF_PATH);
    if (!canonicalResolved) return false;
    return resolved === canonicalResolved || resolved.startsWith(canonicalResolved + path.sep);
  }

  static validateOkfPath(testPath: string): void {
    if (!this.isWithinOkfRoot(testPath)) {
      throw new Error('KNOWLEDGE_RUNTIME_OKF_PATH_ESCAPE');
    }
  }

  // G15.1: Evidence-ref resolver — verify record kind, existence, sensitivity
  resolveEvidenceRef(ref: string): { kind: string; exists: boolean; valid: boolean } {
    const [kind, id] = ref.split(':');
    if (!kind || !id) return { kind: 'unknown', exists: false, valid: false };
    const validKinds = ['goal', 'loop', 'lease', 'panel', 'claim', 'capability', 'trace', 'checkpoint', 'manifest', 'memory', 'gate', 'task', 'mission', 'decision'];
    if (!validKinds.includes(kind)) return { kind, exists: false, valid: false };
    // Check existence in the appropriate table
    let exists = false;
    try {
      switch (kind) {
        case 'claim': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_claims WHERE id = ?').get(id)); break;
        case 'capability': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_capabilities WHERE id = ?').get(id)); break;
        case 'manifest': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_runner_manifests WHERE id = ?').get(id)); break;
        case 'memory': exists = Boolean(this.db.prepare('SELECT 1 FROM memory_candidates WHERE id = ?').get(id)); break;
        case 'panel': exists = Boolean(this.db.prepare('SELECT 1 FROM specialist_panels WHERE id = ?').get(id)); break;
        case 'goal': exists = Boolean(this.db.prepare('SELECT 1 FROM goals WHERE id = ?').get(id)); break;
        case 'loop': exists = Boolean(this.db.prepare('SELECT 1 FROM loop_runs WHERE id = ?').get(id)); break;
        case 'lease': exists = Boolean(this.db.prepare('SELECT 1 FROM worker_leases WHERE id = ?').get(id)); break;
        case 'mission': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_missions WHERE id = ?').get(id)); break;
        case 'task': exists = Boolean(this.db.prepare('SELECT 1 FROM swarm_tasks WHERE id = ?').get(id)); break;
        case 'trace': exists = Boolean(this.db.prepare('SELECT 1 FROM trace_spans WHERE id = ?').get(id)); break;
        case 'checkpoint': exists = Boolean(this.db.prepare('SELECT 1 FROM checkpoints WHERE id = ?').get(id)); break;
        default: exists = false;
      }
    } catch {
      exists = false;
    }
    return { kind, exists, valid: true };
  }
}
