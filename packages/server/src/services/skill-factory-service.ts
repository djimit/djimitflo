import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { EvidenceType, EvidenceSeverity } from '@djimitflo/shared';
import type { LoopService } from './loop-service';
import { ExecutableSkills, skillFirstMode } from './executable-skills';
import { EvidenceService } from './evidence-service';
import { allGatesPassed } from './loop-types';
import { runFactoryChecks, type FactoryCheckRequest, type FactoryCheckResult } from './skill-factory-check-worker';

const runtime = z.enum(['codex', 'opencode', 'claude', 'gemini', 'pi']);
export const skillFactoryPrepareInput = z.object({
  repository_path: z.string().trim().min(1).max(4096), runtime,
  model: z.string().trim().min(1).max(200).optional(),
}).strict();
export const skillFactoryAdvanceInput = z.object({
  checker_runtime: runtime.optional(), timeout_ms: z.number().int().min(1000).max(600000).optional(),
}).strict();
export type SkillFactoryPrepareInput = z.infer<typeof skillFactoryPrepareInput>;
export type SkillFactoryAdvanceInput = z.infer<typeof skillFactoryAdvanceInput>;
type FactoryLoops = Pick<LoopService, 'startObjectiveLoop' | 'continueLoopRun' | 'getLoopRun' | 'listWorkerLeases' | 'executeMaker' | 'executeChecker' | 'verifyLoopRun' | 'runDeterministicChecks' | 'updateWorkerLeaseStatus'>;
type FactoryGoal = { id: string; owner_user_id: string | null; status: string; metadata: string };

/** A bounded continuation of the existing maker/checker loop, never another scheduler or approval authority. */
export class SkillFactoryService {
  constructor(private db: Database, private loops: FactoryLoops, private runChecks: (request: FactoryCheckRequest) => Promise<FactoryCheckResult> = runFactoryChecks) {}

  private goal(id: string, actor: string): FactoryGoal {
    if (skillFirstMode() !== 'on') throw new Error('SKILL_FACTORY_DISABLED');
    const goal = this.db.prepare('SELECT id, owner_user_id, status, metadata FROM goals WHERE id = ?').get(id) as FactoryGoal | undefined;
    if (!goal) throw new Error('SKILL_FACTORY_GOAL_NOT_FOUND');
    if (!actor || goal.owner_user_id !== actor) throw new Error('SKILL_FACTORY_OWNER_REQUIRED');
    const meta = JSON.parse(goal.metadata || '{}') as Record<string, unknown>;
    if (typeof meta.skill_factory_key !== 'string' || typeof meta.skill_factory_capability !== 'string') throw new Error('SKILL_FACTORY_GOAL_REQUIRED');
    if (['failed', 'cancelled'].includes(goal.status)) throw new Error('SKILL_FACTORY_GOAL_TERMINAL');
    if (meta.operator_paused === true) throw new Error('SKILL_FACTORY_PAUSED');
    return goal;
  }

  /** Synchronous preparation is serialized by SQLite; repeated requests reuse the goal's existing run and leases. */
  prepare(goalId: string, actor: string, input: SkillFactoryPrepareInput) {
    const request = skillFactoryPrepareInput.parse(input);
    return this.db.transaction(() => {
      this.goal(goalId, actor);
      const prior = this.db.prepare('SELECT id FROM loop_runs WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(goalId) as { id: string } | undefined;
      const run = prior ? this.loops.getLoopRun(prior.id) : this.loops.startObjectiveLoop({ goal_id: goalId, repository_path: request.repository_path });
      if (['failed', 'cancelled', 'completed', 'escalated'].includes(run.status)) throw new Error('SKILL_FACTORY_RUN_TERMINAL');
      const leases = this.loops.listWorkerLeases(run.id);
      if (!leases.length) this.loops.continueLoopRun(run.id, { runtime: request.runtime, ...(request.model ? { model: request.model } : {}), max_assignments: 1, max_maker_workers: 1 });
      return this.state(run.id);
    }).immediate();
  }

  private state(runId: string) {
    const run = this.loops.getLoopRun(runId);
    return { run_id: run.id, run_status: run.status, leases: this.loops.listWorkerLeases(run.id).map((lease) => ({ id: lease.id, role: lease.role, status: lease.status, runtime: lease.runtime })),
      next_action: run.status === 'ready_for_human_merge' ? 'Existing review and draft-PR publication; no approval, promotion or push performed by the factory.' : 'Continue this factory run or use its existing loop/approval routes.' };
  }

  /** At most one worker per call. A durable claim survives a crash rather than guessing an external process stopped. */
  async advance(goalId: string, actor: string, input: SkillFactoryAdvanceInput = {}) {
    const request = skillFactoryAdvanceInput.parse(input);
    const token = randomUUID();
    const runId = this.db.transaction(() => {
      const goal = this.goal(goalId, actor);
      const prior = this.db.prepare('SELECT id FROM loop_runs WHERE goal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(goalId) as { id: string } | undefined;
      if (!prior) throw new Error('SKILL_FACTORY_NOT_PREPARED');
      if ((JSON.parse(goal.metadata || '{}') as Record<string, unknown>).skill_factory_dispatch) throw new Error('SKILL_FACTORY_DISPATCH_HELD');
      this.db.prepare("UPDATE goals SET metadata = json_set(COALESCE(metadata, '{}'), '$.skill_factory_dispatch', ?) WHERE id = ?").run(token, goalId);
      return prior.id;
    }).immediate();
    try {
      const run = this.loops.getLoopRun(runId);
      if (['failed', 'cancelled', 'completed', 'escalated'].includes(run.status)) throw new Error('SKILL_FACTORY_RUN_TERMINAL');
      const leases = this.loops.listWorkerLeases(runId);
      if (!leases.length) throw new Error('SKILL_FACTORY_NOT_PREPARED');
      for (const lease of leases) {
        const taskId = lease.metadata.execution_task_id;
        const task = typeof taskId === 'string' ? this.db.prepare('SELECT status, metadata FROM tasks WHERE id = ?').get(taskId) as { status: string; metadata: string } | undefined : undefined;
        if (task && JSON.parse(task.metadata || '{}').execution_recovery_hold === true) throw new Error('SKILL_FACTORY_EXECUTION_RECOVERY_REQUIRED');
        if (task?.status === 'awaiting_approval') return { ...this.state(runId), status: 'awaiting_approval' as const };
        if (lease.status === 'running' || task?.status === 'running' || task?.status === 'queued') return { ...this.state(runId), status: 'in_progress' as const };
      }
      const maker = leases.find((lease) => lease.role === 'maker' && !lease.metadata.superseded_by_maker_lease_id);
      if (!maker) throw new Error('SKILL_FACTORY_MAKER_REQUIRED');
      if (maker.runtime === 'mock') throw new Error('SKILL_FACTORY_REAL_RUNTIME_REQUIRED');
      if (maker.status === 'prepared') {
        await this.loops.executeMaker(runId, { lease_id: maker.id, timeout_ms: request.timeout_ms, skip_permissions: false });
        return { ...this.state(runId), status: 'worker_completed' as const };
      }
      if (maker.status !== 'completed') return { ...this.state(runId), status: 'blocked' as const };
      const goalMeta = JSON.parse(this.goal(goalId, actor).metadata) as Record<string, unknown>;
      const capability = goalMeta.skill_factory_package_id;
      if (typeof capability !== 'string' || !capability) throw new Error('SKILL_FACTORY_PACKAGE_ID_REQUIRED');
      if (!maker.worktree_path) throw new Error('SKILL_FACTORY_WORKTREE_REQUIRED');
      const worktreeRoot = fs.realpathSync(maker.worktree_path);
      const skillsRoot = fs.realpathSync(path.join(worktreeRoot, 'skills'));
      if (!skillsRoot.startsWith(worktreeRoot + path.sep)) throw new Error('SKILL_FACTORY_PACKAGE_OUTSIDE_WORKTREE');
      const packages = new ExecutableSkills(this.db, skillsRoot);
      const pkg = packages.load(capability, { candidateForVerification: true });
      if (!maker.metadata.skill_factory_package_hash) {
        // Script names are fixed; never accept caller-provided shell commands or claim generic tests cover this package.
        const testPath = `skills/${capability}/${pkg.contract.test}`;
        if (!/^[a-zA-Z0-9_./-]+$/.test(testPath)) throw new Error('SKILL_FACTORY_TEST_PATH_UNSAFE');
        const scripts = JSON.parse(fs.readFileSync(path.join(maker.worktree_path, 'package.json'), 'utf8')).scripts;
        if (scripts?.['test:skill-package'] !== `node --test ${testPath}`) throw new Error('SKILL_FACTORY_PACKAGE_TEST_REQUIRED');
        const checked = await this.runChecks({ database: this.db.name, runId, leaseId: maker.id, timeoutMs: request.timeout_ms });
        if (['test', 'lint', 'type-check', 'test:skill-package'].some(name => !checked.checks.some(check => check.name === name && check.status === 'pass')) || checked.checks.some(check => check.status !== 'pass')) return { ...this.state(runId), status: 'blocked' as const };
        if (packages.load(capability, { candidateForVerification: true }).contentHash !== pkg.contentHash) throw new Error('SKILL_FACTORY_PACKAGE_CHANGED_DURING_CHECKS');
        this.loops.updateWorkerLeaseStatus(maker.id, 'completed', { skill_factory_package_hash: pkg.contentHash, skill_factory_package_id: capability });
        return { ...this.state(runId), status: 'checks_completed' as const };
      }
      if (maker.metadata.skill_factory_package_hash !== pkg.contentHash || maker.metadata.skill_factory_package_id !== capability) throw new Error('SKILL_FACTORY_PACKAGE_CHANGED_AFTER_CHECKS');
      const checks = maker.metadata.deterministic_checks as Array<{ name: string; status: string }> | undefined;
      if (!checks || ['test', 'lint', 'type-check', 'test:skill-package'].some(name => !checks.some(check => check.name === name && check.status === 'pass')) || checks.some(check => check.status !== 'pass')) throw new Error('SKILL_FACTORY_PACKAGE_CHECKS_REQUIRED');
      const reviewers = leases.filter((lease) => ['checker', 'security_checker'].includes(lease.role) && lease.metadata.maker_lease_id === maker.id);
      if (!reviewers.length) throw new Error('SKILL_FACTORY_REVIEWER_REQUIRED');
      if (reviewers.some(lease => lease.runtime === 'mock')) throw new Error('SKILL_FACTORY_REAL_RUNTIME_REQUIRED');
      const reviewer = reviewers.find((lease) => lease.status === 'prepared');
      if (reviewer) {
        if (reviewer.runtime === 'manual' && !request.checker_runtime) throw new Error('SKILL_FACTORY_CHECKER_RUNTIME_REQUIRED');
        await this.loops.executeChecker(runId, { lease_id: reviewer.id, ...(request.checker_runtime ? { runtime: request.checker_runtime } : {}), timeout_ms: request.timeout_ms, skip_permissions: false });
        return { ...this.state(runId), status: 'worker_completed' as const };
      }
      if (reviewers.some((lease) => lease.status !== 'completed')) return { ...this.state(runId), status: 'blocked' as const };
      const verified = this.loops.verifyLoopRun(runId);
      if (verified.run.status !== 'ready_for_human_merge' || !allGatesPassed(verified.gates)) return { ...this.state(runId), status: 'blocked' as const };
      if (packages.load(capability, { candidateForVerification: true }).contentHash !== pkg.contentHash) throw new Error('SKILL_FACTORY_PACKAGE_CHANGED_AFTER_CHECKS');
      const taskId = maker.metadata.execution_task_id;
      const task = typeof taskId === 'string' ? this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined : undefined;
      if (task?.status !== 'completed' || typeof taskId !== 'string') throw new Error('SKILL_FACTORY_COMPLETED_TASK_REQUIRED');
      const priorReceipt = this.db.prepare("SELECT id FROM execution_evidence WHERE task_id = ? AND evidence_type = 'test_result' AND source = 'system' AND json_extract(details, '$.skill_factory_run_id') = ? AND json_extract(details, '$.skill_package_hash') = ?").get(taskId, runId, pkg.contentHash) as { id: string } | undefined;
      const receiptId = priorReceipt?.id ?? new EvidenceService(this.db).captureEvidence({ task_id: taskId, evidence_type: EvidenceType.TEST_RESULT, severity: EvidenceSeverity.INFO, source: 'system', title: 'Executable skill package verified', summary: 'Exact package passed deterministic tests and the existing independent loop verification gates; admission and promotion remain separate.', details: { status: 'passed', skill_package_hash: pkg.contentHash, skill_package_id: capability, skill_factory_run_id: runId, maker_lease_id: maker.id } });
      return { ...this.state(runId), status: 'awaiting_package_admission' as const, verification_evidence_id: receiptId, task_id: taskId };
    } finally {
      this.db.prepare("UPDATE goals SET metadata = json_remove(metadata, '$.skill_factory_dispatch') WHERE id = ? AND json_extract(metadata, '$.skill_factory_dispatch') = ?").run(goalId, token);
    }
  }
}
