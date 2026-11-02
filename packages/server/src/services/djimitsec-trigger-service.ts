/** Reuses native task execution and the existing authenticated webhook/operator tick. No timer or model. */
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { realpathSync } from 'fs';
import { isAbsolute } from 'path';
import type { Database } from 'better-sqlite3';
import { AuditEventType, ROLE_PERMISSIONS, UserRole } from '@djimitflo/shared';
import type { ExecutionEngine } from '../execution/execution-engine';
import { privateScanText } from '../execution/executors/djimitsec-executor';
import { AuditService } from './audit-service';
import { createError } from '../middleware/error-handler';
import { createNativeTask, parseNativeTask, notifyNativeTaskCreated } from './native-task-service';
import type { WebSocketService } from './websocket-service';

interface RepositoryRule { repositoryId: string; branch: string; intervalMinutes: number }
interface TriggerPolicy { principalId: string; repositories: RepositoryRule[]; maxPerDay: number }
interface TriggerResult { status: string; taskId: string | null; executionStarted: false; verified: false; reason?: string }
const sha = /^[0-9a-f]{40}$/, repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const readGit = promisify(execFile);
const branch = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(s) && !s.includes('..') && !s.endsWith('/') && !s.includes('//');
const triggerMode = () => ['shadow', 'execute'].includes(process.env.DJIMITSEC_SCAN_TRIGGERS || '') ? process.env.DJIMITSEC_SCAN_TRIGGERS : 'off';
const result = (status: string, taskId: string | null = null, reason?: string): TriggerResult => ({ status, taskId, executionStarted: false, verified: false, ...(reason ? { reason } : {}) });

export class DjimitSecTriggerService {
  private ticking = false;
  constructor(private db: Database, private engine: ExecutionEngine, private ws?: WebSocketService) {}
  private policy(): TriggerPolicy {
    const p = JSON.parse(privateScanText(process.env.DJIMITSEC_SCAN_TRIGGER_CONFIG || '')) as TriggerPolicy;
    if (!p || Object.keys(p).sort().join(',') !== 'maxPerDay,principalId,repositories' || typeof p.principalId !== 'string' || !p.principalId || !Number.isInteger(p.maxPerDay) || p.maxPerDay < 1 || p.maxPerDay > 100 || !Array.isArray(p.repositories) || !p.repositories.length || p.repositories.length > 20 || new Set(p.repositories.map(r => r.repositoryId)).size !== p.repositories.length || p.repositories.some(r => Object.keys(r).sort().join(',') !== 'branch,intervalMinutes,repositoryId' || !repo.test(r.repositoryId) || !branch(r.branch) || !Number.isInteger(r.intervalMinutes) || r.intervalMinutes < 60 || r.intervalMinutes > 10080)) throw new Error('DJIMITSEC_TRIGGER_POLICY_INVALID');
    const actor = this.db.prepare('SELECT role,is_active FROM users WHERE id=?').get(p.principalId) as { role: UserRole; is_active: number } | undefined;
    if (!actor?.is_active || actor.role !== UserRole.MAKER || !['create:task', 'execute:task'].every(permission => ROLE_PERMISSIONS[actor.role]?.includes(permission))) throw new Error('DJIMITSEC_TRIGGER_PRINCIPAL_DENIED');
    return p;
  }
  private queue(p: TriggerPolicy, rule: RepositoryRule, commit: string, source: Record<string, unknown>, now: Date): TriggerResult {
    if (!sha.test(commit)) throw new Error('DJIMITSEC_TRIGGER_REVISION_INVALID');
    if (triggerMode() === 'shadow') return result('shadow');
    if (process.env.DJIMITSEC_SCAN_MODE !== 'execute') throw new Error('DJIMITSEC_EXECUTOR_NOT_ARMED');
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_djimitsec_trigger_key ON tasks(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.djimitsecScanTrigger.dedupeKey')) WHERE json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.djimitsecScanTrigger.dedupeKey') IS NOT NULL`);
    const window = Math.floor(now.getTime() / (rule.intervalMinutes * 60000));
    const dedupeKey = createHash('sha256').update([rule.repositoryId, commit, 'static-v1', String(window)].join('\0')).digest('hex');
    return this.db.transaction(() => {
      const previous = this.db.prepare(`SELECT id FROM tasks WHERE json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,'$.djimitsecScanTrigger.dedupeKey')=?`).get(dedupeKey) as { id: string } | undefined;
      if (previous) return result('duplicate', previous.id);
      const used = (this.db.prepare(`SELECT COUNT(*) n FROM tasks WHERE json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,'$.djimitsecScanTrigger.dedupeKey') IS NOT NULL AND created_at>=?`).get(new Date(now.getTime() - 86400000).toISOString()) as { n: number }).n;
      if (used >= p.maxPerDay) return result('held', null, 'daily_budget');
      const busy = this.db.prepare(`SELECT id FROM tasks WHERE status IN ('pending','queued','running','awaiting_approval','paused') AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,'$.djimitsecScan.repositoryId') IS NOT NULL`).get();
      if (busy) return result('held', null, 'scanner_inflight');
      const id = randomUUID(), at = now.toISOString();
      createNativeTask(this.db, { id, title: `Repository scan ${rule.repositoryId}@${commit.slice(0, 12)}`, description: 'Fixed approved source observation only; no remediation, model, approval or deployment.', priority: 'low', execution_mode: 'local', metadata: { executor: 'djimitsec', djimitsecScan: { repositoryId: rule.repositoryId, commit }, djimitsecScanTrigger: { dedupeKey, profile: 'static-v1', window, branch: rule.branch, ...source } }, auditMetadata: { repositoryId: rule.repositoryId, commit, dedupeKey, source, workload: true, verified: false } }, p.principalId, at);
      return result('queued', id);
    }).immediate();
  }
  private dispatch(p: TriggerPolicy, queued: TriggerResult): void {
    if (queued.status !== 'queued' || !queued.taskId) return;
    notifyNativeTaskCreated(parseNativeTask(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(queued.taskId) as Record<string, unknown>), this.ws);
    // The normal engine owns capacity, risk, approval, execution events, cancellation and recovery.
    void this.engine.executeTask(queued.taskId, 'djimitsec', p.principalId).catch(() => {
      new AuditService(this.db).record({ event_type: AuditEventType.EXECUTION_PAUSED, user_id: p.principalId, action: 'djimitsec_scan_dispatch_held', resource_type: 'task', resource_id: queued.taskId!, task_id: queued.taskId!, metadata: { automaticReplay: false, verified: false } });
    });
  }
  /** Called only AFTER the existing route verifies the exact GitHub HMAC bytes. */
  webhook(event: string, deliveryId: string, bytes: Buffer, now = new Date()): TriggerResult | null {
    if (triggerMode() === 'off' || !['push', 'pull_request'].includes(event)) return null;
    const p = this.policy(), body = JSON.parse(bytes.toString('utf8'));
    const rule = p.repositories.find(r => r.repositoryId === body?.repository?.full_name);
    if (!rule) return null;
    let commit: unknown;
    if (event === 'push') {
      if (body.deleted === true || body.ref !== `refs/heads/${rule.branch}`) return result('ignored', null, 'branch_or_deleted');
      commit = body.after;
    } else {
      const pr = body.pull_request;
      if (!['opened', 'synchronize', 'reopened'].includes(body.action) || pr?.base?.ref !== rule.branch || pr?.base?.repo?.full_name !== rule.repositoryId || pr?.head?.repo?.full_name !== rule.repositoryId || !branch(pr?.head?.ref)) return result('ignored', null, 'fork_or_branch');
      commit = pr.head.sha;
    }
    if (typeof commit !== 'string' || !sha.test(commit) || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) throw createError(400, 'Invalid bounded scan event', 'DJIMITSEC_WEBHOOK_INPUT_INVALID');
    const payloadHash = createHash('sha256').update(bytes).digest('hex'), sourceRef = `${rule.repositoryId}@${commit}`, scanDeliveryId = `djimitsec:${deliveryId}`;
    const queued = this.db.transaction(() => {
      const previous = this.db.prepare('SELECT event,source_ref,payload_sha256,result_json FROM github_webhook_deliveries WHERE id=?').get(scanDeliveryId) as { event: string; source_ref: string; payload_sha256: string; result_json: string | null } | undefined;
      if (previous) { if (previous.event !== `djimitsec:${event}` || previous.source_ref !== sourceRef || previous.payload_sha256 !== payloadHash || !previous.result_json) throw createError(409, 'Scan delivery identity conflicts with retained content', 'DJIMITSEC_WEBHOOK_DELIVERY_CONFLICT'); return { ...JSON.parse(previous.result_json), status: 'duplicate' } as TriggerResult; }
      const created = this.queue(p, rule, commit, { kind: event, deliveryId, authentication: 'github_hmac_sha256' }, now);
      this.db.prepare('INSERT INTO github_webhook_deliveries(id,event,source_ref,payload_sha256,result_json) VALUES(?,?,?,?,?)').run(scanDeliveryId, `djimitsec:${event}`, sourceRef, payloadHash, JSON.stringify(created));
      return created;
    }).immediate();
    this.dispatch(p, queued);
    return queued;
  }
  /** Invoked by the EXISTING 60-second operator tick. Reads only configured local branch revisions. */
  async tick(now = new Date()): Promise<TriggerResult[]> {
    if (triggerMode() === 'off') return [];
    if (this.ticking) return [result('held', null, 'tick_inflight')];
    this.ticking = true;
    try {
      const p = this.policy();
      const paths = JSON.parse(process.env.GITHUB_REPOSITORY_PATHS || '{}') as Record<string, unknown>;
      const results: TriggerResult[] = [];
      for (const rule of p.repositories) {
      try {
        const configured = paths[rule.repositoryId];
        if (typeof configured !== 'string' || !isAbsolute(configured)) { results.push(result('held', null, 'repository_unmapped')); continue; }
        const root = realpathSync(configured);
        const commit = (await readGit('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', '-C', root, 'rev-parse', '--verify', `refs/heads/${rule.branch}^{commit}`], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', HOME: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
        const queued = this.queue(p, rule, commit, { kind: 'scheduled', revisionSource: 'configured_local_branch', githubHeadFreshness: 'UNKNOWN' }, now);
        this.dispatch(p, queued); results.push(queued);
      } catch { results.push(result('held', null, 'revision_or_policy_unavailable')); }
      }
      return results;
    } finally { this.ticking = false; }
  }
}
