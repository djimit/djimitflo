import { execFileSync } from 'child_process';

/**
 * Subtraction (SOUL.md): per ISO week, how much the checkout lost next to what it gained — lines and files added/removed and
 * the change in registered HTTP routes (router.get/post/... lines under packages/server/src/routes at the last commit before
 * the week starts vs before it ends). Measured, never gated. Read-only git (log, rev-list, grep) on
 * LOOP_DAEMON_REPOSITORY_PATH; no checkout, no fetch. Without a repository or git the whole KPI is null with the reason —
 * never 0 (E2).
 */
export interface SubtractionWeek {
  week: string; start: string; end: string; commits: number;
  lines_added: number; lines_removed: number; files_added: number; files_deleted: number;
  /** removed / added lines; null when nothing was added */
  ratio_removed_added: number | null;
  routes_start: number | null; routes_end: number | null; routes_delta: number | null;
}
export interface SubtractionKpi { status: 'ok' | 'unavailable'; reason: string | null; repo: string | null; head: string | null; weeks: SubtractionWeek[] | null; note: string }

const ROUTE_RE = '[A-Za-z_]*[Rr]outer\\.(get|post|put|patch|delete|all)\\(';
const ROUTES_DIR = 'packages/server/src/routes';
const NOTE = 'Report-only. ISO weeks (Monday 00:00 UTC), newest last. Lines/files from git log --numstat (merges excluded, binary files count as 0 lines); routes = router.<verb>( lines under packages/server/src/routes at the last commit before the week bound. ratio = removed / added lines.';

/** Monday 00:00 UTC of the ISO week containing `t`. */
export function isoWeekStart(t: number): number {
  const d = new Date(t); const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
/** ISO 8601 week label, e.g. 2026-W42. */
export function isoWeekLabel(t: number): string {
  const d = new Date(isoWeekStart(t) + 3 * 86_400_000); // Thursday decides the year
  const jan4 = Date.UTC(d.getUTCFullYear(), 0, 4);
  return `${d.getUTCFullYear()}-W${String(1 + Math.round((d.getTime() - isoWeekStart(jan4)) / (7 * 86_400_000))).padStart(2, '0')}`;
}

const cache = new Map<string, SubtractionKpi>();

export function subtractionKpi(env: NodeJS.ProcessEnv = process.env, now = Date.now(), weeks = 8): SubtractionKpi {
  const repo = env.LOOP_DAEMON_REPOSITORY_PATH || null;
  const unavailable = (reason: string, head: string | null = null): SubtractionKpi => ({ status: 'unavailable', reason, repo, head, weeks: null, note: NOTE });
  if (!repo) return unavailable('LOOP_DAEMON_REPOSITORY_PATH is not set');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let head: string;
  try { head = git('rev-parse', 'HEAD').trim(); } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    return unavailable(err.code === 'ENOENT' ? 'git is not installed in this environment' : `not a readable git checkout: ${String(err.stderr || err.message).trim().slice(0, 160)}`);
  }
  const first = isoWeekStart(now) - (weeks - 1) * 7 * 86_400_000;
  const key = `${repo}|${head}|${first}|${weeks}`;
  const hit = cache.get(key); if (hit) return hit;
  try {
    const bounds = Array.from({ length: weeks + 1 }, (_, i) => first + i * 7 * 86_400_000);
    // routes at the last commit before each bound (null before the first commit)
    const routesAt = bounds.map((b) => {
      const sha = git('rev-list', '-1', `--before=${new Date(b).toISOString()}`, 'HEAD').trim();
      if (!sha) return null;
      let out = '';
      try { out = git('grep', '-c', '-E', ROUTE_RE, sha, '--', ROUTES_DIR); } catch (e) { if ((e as { status?: number }).status === 1) return 0; throw e; } // exit 1 = no match
      return out.split('\n').filter(Boolean).reduce((s, l) => s + Number(l.slice(l.lastIndexOf(':') + 1)), 0);
    });
    const log = git('log', '--no-merges', '--numstat', '--summary', '--format=@%ct', `--since=${new Date(first).toISOString()}`, 'HEAD');
    const rows: SubtractionWeek[] = bounds.slice(0, weeks).map((b, i) => ({
      week: isoWeekLabel(b), start: new Date(b).toISOString(), end: new Date(bounds[i + 1]).toISOString(), commits: 0,
      lines_added: 0, lines_removed: 0, files_added: 0, files_deleted: 0, ratio_removed_added: null,
      routes_start: routesAt[i], routes_end: routesAt[i + 1], routes_delta: routesAt[i] !== null && routesAt[i + 1] !== null ? (routesAt[i + 1] as number) - (routesAt[i] as number) : null,
    }));
    let cur: SubtractionWeek | undefined;
    for (const line of log.split('\n')) {
      if (line.startsWith('@')) { const t = Number(line.slice(1)) * 1000; cur = rows.find((r) => t >= Date.parse(r.start) && t < Date.parse(r.end)); if (cur) cur.commits++; continue; }
      if (!cur || !line.trim()) continue;
      const num = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (num) { cur.lines_added += num[1] === '-' ? 0 : Number(num[1]); cur.lines_removed += num[2] === '-' ? 0 : Number(num[2]); continue; }
      if (/^ create mode /.test(line)) cur.files_added++;
      else if (/^ delete mode /.test(line)) cur.files_deleted++;
    }
    for (const r of rows) r.ratio_removed_added = r.lines_added ? +(r.lines_removed / r.lines_added).toFixed(3) : null;
    const result: SubtractionKpi = { status: 'ok', reason: null, repo, head, weeks: rows, note: NOTE };
    cache.clear(); cache.set(key, result);
    return result;
  } catch (e) {
    return unavailable(`git read failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`, head);
  }
}
