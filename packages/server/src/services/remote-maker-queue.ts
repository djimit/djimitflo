import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

/**
 * Plan I3: maker work for a remote compute host (the workstation). A loop maker with runtime `remote` enqueues a job
 * (base commit + assignment), the host's worker claims it, runs its own maker in a sandbox and returns only a patch;
 * the executor applies that patch to the VPS worktree and every gate (checks, checker, security, human merge) runs as
 * usual. The host never pushes. REMOTE_MAKER_ENABLED=true (default off).
 */
export const remoteMakerEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.REMOTE_MAKER_ENABLED === 'true';
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

export interface RemoteMakerJob { id: string; host: string; species: string; base_commit: string; prompt: string; status: string; patch: string | null; reason: string | null; created_at: string; claimed_at: string | null; loop_run_id: string | null; lease_id: string | null }
/** §3d P1 #5: the loop run and maker lease a job belongs to (null for a job enqueued without one, e.g. before this field existed). */
export interface RemoteMakerIdentity { loopRunId?: string | null; leaseId?: string | null }
export type RemoteMakerExpiry = 'queue_timeout' | 'work_timeout';

export class RemoteMakerQueue {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_maker_jobs (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, species TEXT NOT NULL, base_commit TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', patch TEXT, reason TEXT,
      created_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT)`);
    // additive migration: existing rows keep NULL (unattributed), the installed worker ignores the extra claim fields
    const columns = new Set((db.prepare('PRAGMA table_info(remote_maker_jobs)').all() as Array<{ name: string }>).map((c) => c.name));
    for (const column of ['loop_run_id', 'lease_id']) if (!columns.has(column)) db.exec(`ALTER TABLE remote_maker_jobs ADD COLUMN ${column} TEXT`);
  }

  enqueue(host: string, species: string, baseCommit: string, prompt: string, identity: RemoteMakerIdentity = {}): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO remote_maker_jobs (id, host, species, base_commit, prompt, created_at, loop_run_id, lease_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, host, species, baseCommit, prompt, new Date().toISOString(), identity.loopRunId ?? null, identity.leaseId ?? null);
    return id;
  }

  /** The host's oldest queued job for one of the species it runs; marks it claimed. */
  claim(host: string, species: string[]): Pick<RemoteMakerJob, 'id' | 'species' | 'base_commit' | 'prompt' | 'loop_run_id' | 'lease_id'> | null {
    if (!species.length) return null;
    const job = this.db.prepare(`SELECT id, species, base_commit, prompt, loop_run_id, lease_id FROM remote_maker_jobs WHERE host = ? AND status = 'queued'
      AND species IN (${species.map(() => '?').join(', ')}) ORDER BY created_at LIMIT 1`).get(host, ...species) as Pick<RemoteMakerJob, 'id' | 'species' | 'base_commit' | 'prompt' | 'loop_run_id' | 'lease_id'> | undefined;
    if (!job) return null;
    const claimed = this.db.prepare("UPDATE remote_maker_jobs SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), job.id).changes;
    return claimed ? job : null;
  }

  record(id: string, host: string, result: { status: 'done' | 'failed'; patch?: string; reason?: string }): void {
    const job = this.db.prepare('SELECT host, status, loop_run_id, lease_id FROM remote_maker_jobs WHERE id = ?').get(id) as { host: string; status: string; loop_run_id: string | null; lease_id: string | null } | undefined;
    if (!job || job.host !== host) throw new Error('MAKER_JOB_NOT_FOUND');
    if (job.status === 'cancelled') {
      // the executor already gave up and failed its lease, so the result has nobody to apply it; still rejected, but a
      // late arrival is recorded next to the cancel reason (prod 2026-10-08: patch posted 2 min after a timeout, reason NULL)
      this.db.prepare("UPDATE remote_maker_jobs SET reason = COALESCE(reason, 'cancelled') || ';late_result' WHERE id = ? AND COALESCE(reason, '') NOT LIKE '%late_result%'").run(id);
    }
    if (job.status !== 'claimed') throw new Error('MAKER_JOB_NOT_CLAIMED');
    // §3d P1 #5: a result is applied only while its lease is still the run's running, non-superseded maker lease
    if (!this.jobLeaseActive(job)) {
      this.cancel(id, 'lease_not_active;late_result', ['claimed']);
      throw new Error('MAKER_JOB_LEASE_NOT_ACTIVE');
    }
    if (result.status !== 'done' && result.status !== 'failed') throw new Error('MAKER_RESULT_INVALID');
    const patch = typeof result.patch === 'string' ? result.patch : '';
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error('MAKER_PATCH_TOO_LARGE');
    this.db.prepare('UPDATE remote_maker_jobs SET status = ?, patch = ?, reason = ?, finished_at = ? WHERE id = ?')
      .run(result.status, patch, String(result.reason || '').slice(0, 500), new Date().toISOString(), id);
  }

  get(id: string): RemoteMakerJob | undefined {
    return this.db.prepare('SELECT id, host, species, base_commit, prompt, status, patch, reason, created_at, claimed_at, loop_run_id, lease_id FROM remote_maker_jobs WHERE id = ?').get(id) as RemoteMakerJob | undefined;
  }

  /** A job without a lease (legacy) has no binding to check; one with a lease is current only while that lease is active. */
  jobLeaseActive(job: Pick<RemoteMakerJob, 'loop_run_id' | 'lease_id'>): boolean {
    return !job.lease_id || this.leaseActive(job.loop_run_id, job.lease_id);
  }

  /**
   * Prod 2026-10-22..29 (22/22 remote makers failed): a maker that needed an approval (every remote maker) is resumed by the
   * engine while its lease stays 'prepared' until the daemon reads the result back, so 'running' alone refused every result.
   * A prepared lease counts as active only while its own engine task (execution_task_id) is running.
   */
  private leaseActive(loopRunId: string | null, leaseId: string): boolean {
    try {
      const lease = this.db.prepare(`SELECT loop_run_id, status, json_extract(metadata, '$.superseded_by_maker_lease_id') AS superseded,
        json_extract(metadata, '$.execution_task_id') AS task_id FROM worker_leases WHERE id = ?`)
        .get(leaseId) as { loop_run_id: string; status: string; superseded: string | null; task_id: string | null } | undefined;
      if (!lease || lease.loop_run_id !== loopRunId || lease.superseded) return false;
      if (lease.status === 'running') return true;
      if (lease.status !== 'prepared' || !lease.task_id) return false;
      return (this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(lease.task_id) as { status: string } | undefined)?.status === 'running';
    } catch { return false; } // no worker_leases/tasks table: the lease cannot be shown active
  }

  /** Every cancel records why; `statuses` guards against a claim/result landing between the read and the cancel. */
  cancel(id: string, reason: string, statuses: string[] = ['queued', 'claimed']): boolean {
    return this.db.prepare(`UPDATE remote_maker_jobs SET status = 'cancelled', reason = ?, finished_at = ? WHERE id = ? AND status IN (${statuses.map(() => '?').join(', ')})`)
      .run(reason, new Date().toISOString(), id, ...statuses).changes > 0;
  }

  /**
   * Prod 2026-10-08: the work timeout counted from creation, so a job the host claimed late (busy with a gym attempt) was
   * cancelled mid-work. An unclaimed job expires after `queueMs` from creation, a claimed one after `workMs` from its claim.
   */
  expire(id: string, queueMs: number, workMs: number, now = Date.now()): RemoteMakerExpiry | null {
    const job = this.get(id);
    if (!job) return null;
    const reason: RemoteMakerExpiry | null = job.status === 'queued' && now - Date.parse(job.created_at) > queueMs ? 'queue_timeout'
      : job.status === 'claimed' && job.claimed_at && now - Date.parse(job.claimed_at) > workMs ? 'work_timeout' : null;
    return reason && this.cancel(id, reason, [job.status]) ? reason : null;
  }
}
