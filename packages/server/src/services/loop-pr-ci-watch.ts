import type { Database } from 'better-sqlite3';
import { LoopEventService } from './loop-event-service';
import { parsePrUrl } from './repo-registry';
import { requiredChecksOf, requiredRun, type CheckRun, type ProtectionChecks, type RequiredCheck } from './required-checks';
import { guardTick, markRun } from './scheduler-registry';

/**
 * PRC-2: CI watch for open loop draft PRs, by polling, record-only. LOOP_PR_CI_WATCH: off (default) | shadow.
 * Every LOOP_PR_CI_WATCH_MINUTES (default 15), at most 10 runs with a pr_url that merge survival has not seen settle
 * (least recently read first) get the REQUIRED checks of the PR's base branch protection read on the PR head
 * (required-checks.ts: context + producer app, newest run per name), written to loop_runs.metadata.ci =
 * {head_sha, state, failing, read_at} and announced once per (run, head_sha, state) as a `ci_red` / `ci_green` loop event.
 * state: red = a required check completed without success (or its commit status failed) — `failing` names them;
 * green = every required check succeeded; pending = one is running or not reported yet; unknown = any GitHub read failed or
 * the required set is unreadable (never red). A closed PR is recorded once (pr_state 'closed') and leaves the watch.
 * No repair, no push, no comment, no ready-for-review: only GETs.
 */
export type CiState = 'green' | 'red' | 'pending' | 'unknown';
export interface CiRecord { head_sha: string | null; state: CiState; failing: string[]; read_at: string; pr_state?: 'closed' }
export const CI_WATCH_PER_TICK = 10;

export function ciWatchMode(env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' { return env.LOOP_PR_CI_WATCH === 'shadow' ? 'shadow' : 'off'; }
export function ciWatchIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const m = Number(env.LOOP_PR_CI_WATCH_MINUTES); return (Number.isFinite(m) && m > 0 ? m : 15) * 60_000;
}

export async function runCiWatchTick(db: Database, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<{ read: number } & Record<CiState, number>> {
  const out = { read: 0, green: 0, red: 0, pending: 0, unknown: 0 };
  const token = env.GITHUB_TOKEN;
  if (ciWatchMode(env) === 'off' || !token) return out;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const get = async <T>(slug: string, p: string): Promise<T | null> => {
    try { const r = await fetchImpl(`https://api.github.com/repos/${slug}/${p}`, { headers, signal: AbortSignal.timeout(15_000) }); return r.ok ? await r.json() as T : null; } catch { return null; }
  };
  // branch protection's required checks per repo + base, read once per tick; null = unreadable
  const requiredCache = new Map<string, RequiredCheck[] | null>();
  const required = async (slug: string, base: string): Promise<RequiredCheck[] | null> => {
    const key = `${slug}\u0000${base}`;
    if (!requiredCache.has(key)) {
      let req = requiredChecksOf(await get<ProtectionChecks>(slug, `branches/${encodeURIComponent(base)}/protection/required_status_checks`));
      if (!req.length) req = requiredChecksOf((await get<{ protection?: { required_status_checks?: ProtectionChecks } }>(slug, `branches/${encodeURIComponent(base)}`))?.protection?.required_status_checks);
      requiredCache.set(key, req.length ? req : null);
    }
    return requiredCache.get(key) ?? null;
  };

  const read = async (prUrl: string): Promise<Omit<CiRecord, 'read_at'>> => {
    const unknown = (head_sha: string | null = null) => ({ head_sha, state: 'unknown' as const, failing: [] });
    const ref = parsePrUrl(prUrl);
    if (!ref) return unknown();
    const pr = await get<{ state?: string; head?: { sha?: string }; base?: { ref?: string } }>(ref.slug, `pulls/${ref.number}`);
    const sha = pr?.head?.sha;
    if (!pr || !sha) return unknown();
    if (pr.state !== 'open') return { ...unknown(sha), pr_state: 'closed' };
    const req = await required(ref.slug, pr.base?.ref || env.LOOP_DRAFT_PR_BASE || 'main');
    const runs = (await get<{ check_runs?: CheckRun[] }>(ref.slug, `commits/${sha}/check-runs?per_page=100`))?.check_runs;
    const combined = await get<{ statuses?: Array<{ context?: string; state?: string }> }>(ref.slug, `commits/${sha}/status`);
    if (!req || !runs || !combined) return unknown(sha);
    const failing: string[] = []; let pending = false;
    for (const r of req) {
      const run = requiredRun(runs, r);
      // a commit status has no app: it can satisfy only a context required from any source (as the merge gate)
      const statuses = r.app_id === null ? (combined.statuses ?? []).filter((s) => s.context === r.context) : [];
      if ((run?.status === 'completed' && run.conclusion !== 'success') || statuses.some((s) => s.state === 'failure' || s.state === 'error')) failing.push(r.context);
      else if (!((run?.status === 'completed' && run.conclusion === 'success') || statuses.some((s) => s.state === 'success'))) pending = true;
    }
    return { head_sha: sha, state: failing.length ? 'red' : pending ? 'pending' : 'green', failing: failing.sort() };
  };

  const rows = db.prepare(`SELECT id, json_extract(m, '$.pr_url') AS pr_url FROM (
      SELECT id, created_at, CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END AS m FROM loop_runs WHERE created_at >= ?)
    WHERE json_extract(m, '$.pr_url') IS NOT NULL AND COALESCE(json_extract(m, '$.pr_outcome.state'), 'open') = 'open'
      AND json_extract(m, '$.ci.pr_state') IS NULL
    ORDER BY COALESCE(json_extract(m, '$.ci.read_at'), '') ASC, created_at DESC LIMIT ?`)
    .all(new Date(now.getTime() - 60 * 86_400_000).toISOString(), CI_WATCH_PER_TICK) as Array<{ id: string; pr_url: string }>;
  const events = new LoopEventService(db);
  const seen = db.prepare(`SELECT 1 FROM loop_events WHERE loop_run_id = ? AND event_type = ? AND json_extract(metadata, '$.head_sha') = ? LIMIT 1`);
  for (const row of rows) {
    const record: CiRecord = { ...(await read(String(row.pr_url))), read_at: new Date().toISOString() };
    db.prepare(`UPDATE loop_runs SET metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.ci', json(?)) WHERE id = ?`).run(JSON.stringify(record), row.id);
    out.read++; out[record.state]++;
    if ((record.state === 'red' || record.state === 'green') && record.head_sha && !seen.get(row.id, `ci_${record.state}`, record.head_sha)) {
      events.recordEvent(row.id, `ci_${record.state}`, record.state === 'red' ? 'warning' : 'info',
        `CI ${record.state} on ${record.head_sha.slice(0, 8)}${record.failing.length ? `: ${record.failing.join(', ')}` : ''}`,
        { head_sha: record.head_sha, state: record.state, failing: record.failing, pr_url: row.pr_url });
    }
  }
  return out;
}

/** Scheduler `loop_pr_ci_watch` while LOOP_PR_CI_WATCH=shadow; null when off. */
export function startLoopPrCiWatch(db: Database, intervalMs = ciWatchIntervalMs()): (() => void) | null {
  if (ciWatchMode() === 'off') return null;
  const tick = guardTick('loop_pr_ci_watch', async () => { await runCiWatchTick(db); markRun('loop_pr_ci_watch'); });
  const timer = setInterval(tick, intervalMs); timer.unref?.();
  return () => clearInterval(timer);
}
