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

export interface RemoteMakerJob { id: string; host: string; species: string; base_commit: string; prompt: string; status: string; patch: string | null; reason: string | null }

export class RemoteMakerQueue {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_maker_jobs (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, species TEXT NOT NULL, base_commit TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', patch TEXT, reason TEXT,
      created_at TEXT NOT NULL, claimed_at TEXT, finished_at TEXT)`);
  }

  enqueue(host: string, species: string, baseCommit: string, prompt: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO remote_maker_jobs (id, host, species, base_commit, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, host, species, baseCommit, prompt, new Date().toISOString());
    return id;
  }

  /** The host's oldest queued job for one of the species it runs; marks it claimed. */
  claim(host: string, species: string[]): Pick<RemoteMakerJob, 'id' | 'species' | 'base_commit' | 'prompt'> | null {
    if (!species.length) return null;
    const job = this.db.prepare(`SELECT id, species, base_commit, prompt FROM remote_maker_jobs WHERE host = ? AND status = 'queued'
      AND species IN (${species.map(() => '?').join(', ')}) ORDER BY created_at LIMIT 1`).get(host, ...species) as Pick<RemoteMakerJob, 'id' | 'species' | 'base_commit' | 'prompt'> | undefined;
    if (!job) return null;
    const claimed = this.db.prepare("UPDATE remote_maker_jobs SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), job.id).changes;
    return claimed ? job : null;
  }

  record(id: string, host: string, result: { status: 'done' | 'failed'; patch?: string; reason?: string }): void {
    const job = this.db.prepare('SELECT host, status FROM remote_maker_jobs WHERE id = ?').get(id) as { host: string; status: string } | undefined;
    if (!job || job.host !== host) throw new Error('MAKER_JOB_NOT_FOUND');
    if (job.status !== 'claimed') throw new Error('MAKER_JOB_NOT_CLAIMED');
    if (result.status !== 'done' && result.status !== 'failed') throw new Error('MAKER_RESULT_INVALID');
    const patch = typeof result.patch === 'string' ? result.patch : '';
    if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error('MAKER_PATCH_TOO_LARGE');
    this.db.prepare('UPDATE remote_maker_jobs SET status = ?, patch = ?, reason = ?, finished_at = ? WHERE id = ?')
      .run(result.status, patch, String(result.reason || '').slice(0, 500), new Date().toISOString(), id);
  }

  get(id: string): RemoteMakerJob | undefined {
    return this.db.prepare('SELECT id, host, species, base_commit, prompt, status, patch, reason FROM remote_maker_jobs WHERE id = ?').get(id) as RemoteMakerJob | undefined;
  }

  cancel(id: string): void {
    this.db.prepare("UPDATE remote_maker_jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued', 'claimed')").run(new Date().toISOString(), id);
  }
}
