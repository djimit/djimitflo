import { createHash } from 'crypto';
import type { Database } from 'better-sqlite3';
import { LoopService, type WorkerLeaseRecord } from './loop-service';
import { NestedSpawnService, type RequestSpawnResult } from './nested-spawn-service';

export type DelegationMode = 'off' | 'shadow' | 'execute';
const DELEGATION_RUNTIMES = new Set(['codex', 'opencode', 'claude', 'gemini', 'mock']);

export interface DelegationReceipt {
  spawn_id: string | null;
  loop_run_id: string;
  parent_lease_id: string;
  child_lease_id: string | null;
  proposed: boolean;
  executed: boolean;
  execution_outcome: 'not_started' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  verification_outcome: 'unknown' | 'pending' | 'accepted' | 'rejected' | 'inconclusive';
  verification_lease_id?: string;
  delivery_outcome: 'not_delivered' | 'pending' | 'delivered';
  evidence_refs: string[];
  checks: Array<{ name: string; status: string; evidence: string }>;
  source_revision: string | null;
  resource_usage: { reserved_tokens: number | null; measured_tokens: number | null; estimated_tokens: number | null; measured_wall_ms: number | null; cost_amount: number | null };
  reason?: string;
}

export interface DelegateCodeTaskInput {
  loop_run_id: string;
  parent_lease_id: string;
  runtime: 'codex' | 'opencode' | 'claude' | 'gemini' | 'editor' | 'mock';
  prompt: string;
  capability_ids?: string[];
  idempotency_key: string;
  actor_user_id: string;
}

export class DelegationService {
  private readonly db: Database;
  private readonly loops: LoopService;
  private readonly spawns: NestedSpawnService;

  constructor(db: Database, loops = new LoopService(db), spawns = new NestedSpawnService(db, loops)) {
    this.db = db;
    this.loops = loops;
    this.spawns = spawns;
  }

  mode(): DelegationMode {
    const raw = process.env.DELEGATION_FACADE_MODE;
    return raw === 'shadow' || raw === 'execute' ? raw : 'off';
  }

  submitCodeTask(input: DelegateCodeTaskInput): DelegationReceipt {
    const mode = this.mode();
    if (mode === 'off') throw new Error('DELEGATION_FACADE_OFF');
    if (!input.actor_user_id) throw new Error('DELEGATION_ACTOR_REQUIRED');
    if (!input.idempotency_key?.trim() || input.idempotency_key.length > 200) throw new Error('DELEGATION_IDEMPOTENCY_KEY_INVALID');
    if (!input.prompt?.trim()) throw new Error('SPAWN_PROMPT_REQUIRED');
    if (!DELEGATION_RUNTIMES.has(input.runtime) || (input.runtime === 'mock' && process.env.NODE_ENV !== 'test')) throw new Error('DELEGATION_RUNTIME_UNSUPPORTED');

    const parent = this.loops.getWorkerLease(input.parent_lease_id);
    if (parent.loop_run_id !== input.loop_run_id || !parent.spawn_tree_id) throw new Error('DELEGATION_PARENT_SCOPE_INVALID');
    const run = this.loops.getLoopRun(input.loop_run_id);
    if (['blocked', 'completed', 'failed', 'cancelled', 'escalated', 'interrupted', 'ready_for_human_merge'].includes(run.status)
      || !['prepared', 'running'].includes(parent.status)) throw new Error('DELEGATION_RUN_NOT_EXECUTABLE');
    this.loops.assertOperatorNotPaused(run);

    if (mode === 'shadow') {
      this.loops.recordLoopEvent(input.loop_run_id, 'delegation_shadow', 'info', 'Delegation proposed; shadow mode did not prepare or execute a worker.', {
        proposed: true, executed: false, parent_lease_id: parent.id, runtime: input.runtime, actor_user_id: input.actor_user_id,
      });
      return {
        spawn_id: null, loop_run_id: input.loop_run_id, parent_lease_id: parent.id, child_lease_id: null,
        proposed: true, executed: false, execution_outcome: 'not_started', verification_outcome: 'unknown',
        delivery_outcome: 'not_delivered', evidence_refs: [], checks: [], source_revision: null,
        resource_usage: { reserved_tokens: null, measured_tokens: null, estimated_tokens: null, measured_wall_ms: null, cost_amount: null }, reason: 'shadow_mode',
      };
    }

    const spawn = this.spawns.requestSpawn({
      spawn_tree_id: parent.spawn_tree_id,
      parent_lease_id: parent.id,
      requested_by_lease_id: parent.id,
      role: 'maker',
      runtime: input.runtime,
      prompt: input.prompt,
      capability_ids: input.capability_ids,
      idempotency_key: input.idempotency_key,
    }, { internal: true });

    if (spawn.status === 'gated_out' || spawn.status === 'held' || !spawn.child_lease_id) {
      return this.receipt(input, spawn, null);
    }

    const lease = this.loops.getWorkerLease(spawn.child_lease_id);
    if (lease.loop_run_id !== input.loop_run_id) throw new Error('DELEGATION_CHILD_SCOPE_INVALID');
    if (!spawn.idempotent_replay) {
      this.loops.patchWorkerLeaseMetadata(lease.id, { delegation_facade: { actor_user_id: input.actor_user_id, submission_id: spawn.spawn_id, reserved_tokens: spawn.token_budget_grant ?? null } });
      this.loops.recordLoopEvent(input.loop_run_id, 'delegation_admitted', 'info', 'Bounded code task admitted as a nested maker lease.', {
        spawn_id: spawn.spawn_id, parent_lease_id: parent.id, child_lease_id: lease.id, runtime: lease.runtime, actor_user_id: input.actor_user_id,
      });
    }
    if (lease.status === 'prepared' || lease.status === 'completed') this.schedule(input, spawn, parent.id, lease.id);
    return this.receipt(input, spawn, lease, this.findChecker(input.loop_run_id, lease.id));
  }

  getReceipt(loopRunId: string, spawnId: string): DelegationReceipt {
    const row = this.db.prepare('SELECT s.* FROM sub_agent_spawns s JOIN worker_leases root ON root.id = s.spawn_tree_id WHERE s.id = ? AND root.loop_run_id = ?').get(spawnId, loopRunId) as any;
    if (!row) throw new Error('DELEGATION_NOT_FOUND');
    const lease = row.child_lease_id ? this.loops.getWorkerLease(row.child_lease_id) : null;
    const checker = lease ? this.findChecker(loopRunId, lease.id) : null;
    return this.receipt({ loop_run_id: loopRunId, parent_lease_id: row.parent_lease_id }, {
      spawn_id: row.id, spawn_tree_id: row.spawn_tree_id, parent_lease_id: row.parent_lease_id,
      child_lease_id: row.child_lease_id, depth: row.depth, status: row.status === 'gated_out' ? 'gated_out' : row.status === 'requested' ? 'held' : 'prepared',
      token_budget_grant: row.token_budget_grant ?? undefined,
      reject_reason: row.reject_reason ?? undefined,
    }, lease, checker);
  }

  private schedule(input: DelegateCodeTaskInput, spawn: RequestSpawnResult, parentLeaseId: string, makerLeaseId: string): void {
    setImmediate(() => {
      void (async () => {
        if (!this.canContinue(input.loop_run_id, parentLeaseId, makerLeaseId, ['prepared', 'running'])) return;
        let maker = this.loops.getWorkerLease(makerLeaseId);
        if (maker.status === 'prepared') {
          await this.loops.executeWorker(input.loop_run_id, { lease_id: makerLeaseId });
          maker = this.loops.getWorkerLease(makerLeaseId);
        }
        if (maker.status !== 'completed' || !this.canContinue(input.loop_run_id, parentLeaseId, makerLeaseId, ['completed'])) return;

        const existing = this.findChecker(input.loop_run_id, makerLeaseId);
        const checkerSpawn = existing ? null : this.spawns.requestSpawn({
          spawn_tree_id: this.loops.getWorkerLease(parentLeaseId).spawn_tree_id!,
          parent_lease_id: parentLeaseId,
          requested_by_lease_id: parentLeaseId,
          role: 'checker',
          runtime: input.runtime,
          prompt: `Read-only independent review for maker lease ${makerLeaseId}. Check its diff and reported tests; do not modify files.`,
          idempotency_key: createHash('sha256').update(input.idempotency_key + '|checker').digest('hex'),
        }, { internal: true });
        if (checkerSpawn?.status === 'gated_out' || checkerSpawn?.status === 'held' || !checkerSpawn?.child_lease_id) {
          this.loops.patchWorkerLeaseMetadata(makerLeaseId, { delegation_verification_blocked: checkerSpawn?.reject_reason ?? 'verification_submission_held' });
          return;
        }
        const checkerId = existing?.id ?? checkerSpawn!.child_lease_id!;
        const checker = this.loops.getWorkerLease(checkerId);
        if (!existing) this.loops.patchWorkerLeaseMetadata(checker.id, { maker_lease_id: makerLeaseId, delegation_submission_id: spawn.spawn_id });
        if (checker.status === 'prepared' && this.canContinue(input.loop_run_id, parentLeaseId, checker.id, ['prepared'])) {
          await this.loops.executeChecker(input.loop_run_id, { lease_id: checker.id, runtime: input.runtime });
        }
      })().catch((error) => {
        try {
          this.loops.recordLoopEvent(input.loop_run_id, 'delegation_dispatch_failed', 'warning', 'Delegated execution or checker dispatch failed; canonical lease states remain authoritative.', {
            spawn_id: spawn.spawn_id, child_lease_id: makerLeaseId, error_code: error instanceof Error ? error.message : 'unknown', actor_user_id: input.actor_user_id,
          });
        } catch { /* diagnostics must not mask execution state */ }
      });
    });
  }

  private canContinue(loopRunId: string, parentLeaseId: string, childLeaseId: string, allowedChildStatuses: WorkerLeaseRecord['status'][]): boolean {
    const run = this.loops.getLoopRun(loopRunId);
    const parent = this.loops.getWorkerLease(parentLeaseId);
    const child = this.loops.getWorkerLease(childLeaseId);
    if (['blocked', 'completed', 'failed', 'cancelled', 'escalated', 'interrupted', 'ready_for_human_merge'].includes(run.status)
      || !['prepared', 'running'].includes(parent.status) || !allowedChildStatuses.includes(child.status)) return false;
    try { this.loops.assertOperatorNotPaused(run); return true; } catch { return false; }
  }

  private findChecker(loopRunId: string, makerLeaseId: string): WorkerLeaseRecord | null {
    return this.loops.listWorkerLeases(loopRunId).find((lease) =>
      (lease.role === 'checker' || lease.role === 'security_checker') && lease.metadata.delegation_submission_id && lease.metadata.maker_lease_id === makerLeaseId,
    ) ?? null;
  }

  private receipt(input: Pick<DelegateCodeTaskInput, 'loop_run_id' | 'parent_lease_id'>, spawn: RequestSpawnResult, lease: WorkerLeaseRecord | null, checker: WorkerLeaseRecord | null = null): DelegationReceipt {
    const status = lease?.status;
    const verified = checker?.runtime === 'mock' ? null : checker?.metadata?.verdict;
    const runtimeUsage = lease?.metadata?.runtime_usage as { total_tokens?: unknown } | undefined;
    const start = typeof lease?.metadata?.started_at === 'string' ? Date.parse(lease.metadata.started_at) : NaN;
    const end = typeof lease?.metadata?.completed_at === 'string' ? Date.parse(lease.metadata.completed_at) : NaN;
    const relevantEvents = lease ? this.loops.getReviewBundle(input.loop_run_id).events.filter((event) =>
      event.metadata.lease_id === lease.id || (!!checker && event.metadata.checker_lease_id === checker.id),
    ) : [];
    const checks = relevantEvents.flatMap((event) => Array.isArray(event.metadata.gates) ? event.metadata.gates : [])
      .filter((gate): gate is { name: string; status: string; evidence: string } => !!gate && typeof gate === 'object'
        && typeof (gate as any).name === 'string' && typeof (gate as any).status === 'string' && typeof (gate as any).evidence === 'string')
      .map((gate) => ({ name: gate.name, status: gate.status, evidence: gate.evidence }));
    const evidenceRefs = [lease?.metadata.stdout_path, lease?.metadata.stderr_path, checker?.metadata.stdout_path, checker?.metadata.stderr_path]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    return {
      spawn_id: spawn.spawn_id, loop_run_id: input.loop_run_id, parent_lease_id: input.parent_lease_id,
      child_lease_id: spawn.child_lease_id,
      proposed: spawn.spawn_id === null, executed: status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled',
      execution_outcome: status === 'prepared' ? 'queued' : status === 'running' ? 'running' : status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'unknown',
      verification_outcome: checker?.status === 'prepared' || checker?.status === 'running'
        ? 'pending'
        : verified === 'accepted' ? 'accepted'
          : verified === 'rejected' || verified === 'needs_revision' ? 'rejected'
            : checker && (checker.runtime !== 'mock' && (checker.status === 'completed' || checker.status === 'failed' || checker.status === 'cancelled')) ? 'inconclusive'
              : status === 'completed' && !checker && !lease?.metadata.delegation_verification_blocked ? 'pending'
                : typeof lease?.metadata.delegation_verification_blocked === 'string' ? 'inconclusive' : 'unknown',
      ...(checker ? { verification_lease_id: checker.id } : {}),
      delivery_outcome: status === 'completed' ? 'delivered' : status === 'failed' || status === 'cancelled' ? 'not_delivered' : 'pending',
      evidence_refs: evidenceRefs, checks, source_revision: typeof lease?.metadata.source_revision === 'string' ? lease.metadata.source_revision : null,
      resource_usage: {
        reserved_tokens: spawn.token_budget_grant ?? null,
        measured_tokens: typeof runtimeUsage?.total_tokens === 'number' && Number.isFinite(runtimeUsage.total_tokens) ? runtimeUsage.total_tokens : null,
        estimated_tokens: null,
        measured_wall_ms: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
        cost_amount: null,
      },
      ...(spawn.reject_reason ? { reason: spawn.reject_reason } : {}),
      ...(!checker && typeof lease?.metadata.delegation_verification_blocked === 'string' ? { reason: 'verification_blocked:' + lease.metadata.delegation_verification_blocked } : {}),
    };
  }
}
