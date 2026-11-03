import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { WorkItemService } from './work-item-service';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

/**
 * Scheduled, deterministic knowledge maintenance. It replaces the Paperclip routines "DjimitKBWiki knowledge drift
 * review", "Refresh LLM Wiki index" and "Run LLM Wiki lint", which spawned an agent per run (the agents failed after
 * ~21 s and left 195 issues open). Here the checks are plain code with a run ledger; a finding becomes a Djimitflo work
 * item, and only a fix to the knowledge itself needs a maker and a human approval.
 *
 * Jobs (period key = UTC day, or ISO week for weekly jobs; one ledger row per job and period, so restarts never repeat):
 *  - okf_sync_drift   daily   OKF capability files vs the registry (dry-run sync)
 *  - wiki_delta       daily   wiki.page.changed events from the event bus since the last run -> projection_update
 *  - okf_lint         weekly  OKF markdown files that are empty or have no front matter
 */

export type MaintenanceJobId = 'okf_sync_drift' | 'wiki_delta' | 'okf_lint';

export interface JobOutcome { status: 'ok' | 'findings' | 'skipped' | 'failed'; findings: number; detail: Record<string, unknown>; title?: string; description?: string; labels?: string[] }

interface JobSpec { id: MaintenanceJobId; cadence: 'daily' | 'weekly'; run: (ctx: Context) => Promise<JobOutcome> | JobOutcome }
interface Context { db: Database; knowledge: Pick<KnowledgeRuntimeService, 'syncCapabilities' | 'health'>; now: Date; lastRunAt: string | null }

export function maintenanceEnabled(): boolean { return process.env.KNOWLEDGE_MAINTENANCE_ENABLED === 'true'; }

export function periodKey(cadence: 'daily' | 'weekly', now: Date): string {
  if (cadence === 'daily') return now.toISOString().slice(0, 10);
  // ISO week (UTC)
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const JOBS: JobSpec[] = [
  {
    id: 'okf_sync_drift', cadence: 'daily',
    run: ({ knowledge }) => {
      const result = knowledge.syncCapabilities({ dry_run: true });
      const drifted = result.created + result.updated;
      return {
        status: drifted > 0 ? 'findings' : 'ok', findings: drifted,
        detail: { created: result.created, updated: result.updated, unchanged: result.unchanged, blocked: result.blocked },
        title: `OKF drift: ${drifted} capability file(s) out of sync with the registry`,
        description: `A dry-run sync found ${result.created} new and ${result.updated} changed capability files (${result.blocked} blocked). Review with the knowledge runtime and apply the sync if the changes are intended.`,
        labels: ['knowledge-maintenance', 'okf-drift'],
      };
    },
  },
  {
    id: 'wiki_delta', cadence: 'daily',
    run: ({ db, lastRunAt, now }) => {
      const since = lastRunAt ?? new Date(now.getTime() - 86_400_000).toISOString();
      const rows = db.prepare("SELECT payload FROM external_events WHERE event_type = 'wiki.page.changed' AND occurred_at > ? ORDER BY occurred_at").all(since) as Array<{ payload: string }>;
      const pages = new Set<string>();
      for (const row of rows) {
        try { for (const page of (JSON.parse(row.payload).pages ?? []) as unknown[]) if (typeof page === 'string') pages.add(page); } catch { /* skip a malformed event */ }
      }
      return {
        status: pages.size > 0 ? 'findings' : 'ok', findings: pages.size,
        detail: { events: rows.length, pages: [...pages].slice(0, 50), since },
        title: `Re-project DjimitKBWiki delta: ${pages.size} changed page(s)`,
        description: `${pages.size} wiki page(s) changed since ${since} (${rows.length} event(s)). Re-embed them in Qdrant and update the GraphStore relations.\n\n${[...pages].slice(0, 20).join('\n')}`,
        labels: ['knowledge-maintenance', 'projection-needed', 'djimitkbwiki'],
      };
    },
  },
  {
    id: 'okf_lint', cadence: 'weekly',
    run: ({ knowledge }) => {
      const base = knowledge.health().okf_base;
      if (!base || !fs.existsSync(base)) return { status: 'skipped', findings: 0, detail: { reason: 'okf_base_missing' } };
      const bad: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { if (!entry.name.startsWith('.')) walk(full); continue; }
          if (!entry.name.endsWith('.md')) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (!text.trim() || !text.startsWith('---')) bad.push(path.relative(base, full));
        }
      };
      walk(base);
      return {
        status: bad.length > 0 ? 'findings' : 'ok', findings: bad.length, detail: { files: bad.slice(0, 50) },
        title: `OKF lint: ${bad.length} markdown file(s) empty or without front matter`,
        description: `These OKF files fail the basic lint (empty, or no front matter):\n\n${bad.slice(0, 20).join('\n')}`,
        labels: ['knowledge-maintenance', 'okf-lint'],
      };
    },
  },
];

export class KnowledgeMaintenanceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly db: Database, private readonly knowledge: Context['knowledge'] = new KnowledgeRuntimeService(db)) {}

  start(intervalMs = Number(process.env.KNOWLEDGE_MAINTENANCE_INTERVAL_MS) || 15 * 60_000): void {
    if (this.timer || !maintenanceEnabled()) return;
    const tick = () => void this.runDue().then((r) => {
      if (r.length) console.log(`📚 knowledge maintenance: ${r.map((x) => `${x.job}=${x.status}(${x.findings})`).join(' ')}`);
    }).catch((err) => console.warn('Knowledge maintenance tick failed:', err instanceof Error ? err.message : String(err)));
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    setTimeout(tick, 90_000).unref?.(); // catch-up shortly after boot: the ledger prevents a repeat run
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** Runs every job that has no ledger row for its current period. Never throws for one failing job. */
  async runDue(now = new Date()): Promise<Array<{ job: MaintenanceJobId; period: string; status: string; findings: number }>> {
    if (this.running) return [];
    this.running = true;
    const ran: Array<{ job: MaintenanceJobId; period: string; status: string; findings: number }> = [];
    try {
      for (const job of JOBS) {
        const period = periodKey(job.cadence, now);
        if (this.db.prepare('SELECT 1 FROM knowledge_maintenance_runs WHERE job = ? AND period = ?').get(job.id, period)) continue;
        const last = this.db.prepare("SELECT ran_at FROM knowledge_maintenance_runs WHERE job = ? AND status IN ('ok', 'findings') ORDER BY ran_at DESC LIMIT 1").get(job.id) as { ran_at: string } | undefined;
        let outcome: JobOutcome;
        try { outcome = await job.run({ db: this.db, knowledge: this.knowledge, now, lastRunAt: last?.ran_at ?? null }); }
        catch (err) { outcome = { status: 'failed', findings: 0, detail: { error: err instanceof Error ? err.message.slice(0, 300) : String(err) } }; }
        this.db.prepare('INSERT INTO knowledge_maintenance_runs (job, period, status, findings, detail_json, ran_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(job.id, period, outcome.status, outcome.findings, JSON.stringify(outcome.detail), now.toISOString());
        if (outcome.status === 'findings' && outcome.title) {
          new WorkItemService(this.db).upsertBySourceRef({
            title: outcome.title, description: outcome.description ?? outcome.title, source: 'knowledge_maintenance', source_ref: `${job.id}:${period}`,
            risk_class: 'low', status: 'candidate', recommended_loop: 'okf-synchronization-loop',
            metadata: { job: job.id, period, findings: outcome.findings, labels: outcome.labels ?? [], detail: outcome.detail },
          });
        }
        ran.push({ job: job.id, period, status: outcome.status, findings: outcome.findings });
      }
    } finally { this.running = false; }
    return ran;
  }
}
