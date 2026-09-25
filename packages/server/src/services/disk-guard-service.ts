import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import { WorkItemService } from './work-item-service';
import { enqueueEvent } from './event-outbox-service';

/**
 * Warns before the disk fills. On 2026-09-21 the VPS disk hit 100 %: SQLite failed with SQLITE_IOERR_SHMSIZE and the
 * deploy rollback crash-looped too. Checks free space of the data volume and raises ONE work item + bus event per
 * day and level (warn >= 80 %, critical >= 90 %). Read-only: never deletes anything. Default off: DISK_GUARD_ENABLED=true.
 */
export const diskGuardEnabled = (): boolean => process.env.DISK_GUARD_ENABLED === 'true';

export type DiskLevel = 'ok' | 'warn' | 'critical';
export interface DiskStatus { path: string; usedPct: number; freeGb: number; level: DiskLevel }

export class DiskGuardService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database, private readonly statfs: (p: string) => { blocks: number; bavail: number; bsize: number } = (p) => fs.statfsSync(p)) {}

  start(intervalMs = 10 * 60_000): void {
    if (this.timer || !diskGuardEnabled()) return;
    const run = () => { try { this.check(); } catch (err) { console.warn('Disk guard failed:', err instanceof Error ? err.message : String(err)); } };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    setTimeout(run, 30_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  status(): DiskStatus {
    const path = process.env.DISK_GUARD_PATH || '/data';
    const s = this.statfs(path);
    const usedPct = s.blocks ? Math.round((1 - s.bavail / s.blocks) * 1000) / 10 : 0;
    const warn = Number(process.env.DISK_GUARD_WARN_PCT) || 80; const critical = Number(process.env.DISK_GUARD_CRITICAL_PCT) || 90;
    return { path, usedPct, freeGb: Math.round((s.bavail * s.bsize) / 1e8) / 10, level: usedPct >= critical ? 'critical' : usedPct >= warn ? 'warn' : 'ok' };
  }

  check(now = new Date()): DiskStatus {
    const st = this.status();
    if (st.level === 'ok') return st;
    const day = now.toISOString().slice(0, 10);
    const { created } = new WorkItemService(this.db).upsertBySourceRef({
      title: `Disk ${st.usedPct}% full on ${st.path} (${st.freeGb} GB free)`,
      description: `The data volume is ${st.level === 'critical' ? 'critically' : ''} low on space. Free space before the next deploy: prune old images and runtime-source clones (scripts/deploy-vps.sh does this after a healthy deploy), check /srv/backups and loop worktrees.`,
      source: 'disk_guard', source_ref: `${day}:${st.level}`, risk_class: st.level === 'critical' ? 'high' : 'medium', status: 'candidate',
      metadata: { disk: st },
    });
    if (created) enqueueEvent(this.db, { type: 'djimitflo.alert.disk', aggregateId: `disk:${day}:${st.level}`, payload: { ...st } });
    return st;
  }
}
