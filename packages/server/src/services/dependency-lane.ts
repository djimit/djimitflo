import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { AuditEventType, RiskLevel } from '@djimitflo/shared';
import { AuditService } from './audit-service';
import { LoopEventService } from './loop-event-service';
import { markRun } from './scheduler-registry';

/**
 * Dependency lane (operator-approved class, 2026-10-07). Dependabot PRs piled up unseen (18 open, oldest 2026-09-14).
 * Every tick (default 3 h) this lists the open Dependabot PRs through the GitHub token Djimitflo already uses and decides
 * per PR, oldest first:
 * - only npm (`dependabot/npm_and_yarn/…`), only patch/minor — a major, a 0.x minor (breaking under ^), a grouped update
 *   touching a major or any update it cannot parse stays human;
 * - pending or absent checks wait; failing checks are skipped only when the branch is up to date with its base;
 * - behind its base (green or red — red is often just an outdated base): one `@dependabot rebase` comment per PR per 24 h (never update-branch — that breaks Dependabot's own
 *   rebase and once caused 37 spam comments);
 * - green + mergeable + up to date: shadow records `would_merge`; act squash-merges ONE PR per tick (CI and auto-deploy see
 *   one change at a time), at most DEPENDENCY_LANE_MAX_PER_DAY (default 4) per UTC day, and only once the previous merge's
 *   main CI is green.
 * Every merge is an audit event and a loop event (a `dependency-lane` loop run per merge). Main CI red on a lane merge
 * revokes act mode (persisted; the lane then behaves as shadow) until an operator re-enables it through the audited
 * manage:config endpoint POST /api/loops/dependency-lane/re-enable. Shadow makes no GitHub writes at all.
 * DEPENDENCY_LANE_MODE=off|shadow|act (default off).
 */
export type LaneMode = 'off' | 'shadow' | 'act';
export type Bump = 'patch' | 'minor' | 'major' | 'unknown';
export type CheckState = 'success' | 'failure' | 'pending' | 'none';

export const laneMode = (env: NodeJS.ProcessEnv = process.env): LaneMode =>
  env.DEPENDENCY_LANE_MODE === 'shadow' || env.DEPENDENCY_LANE_MODE === 'act' ? env.DEPENDENCY_LANE_MODE : 'off';
export const laneMaxPerDay = (env: NodeJS.ProcessEnv = process.env): number => {
  const v = Number(env.DEPENDENCY_LANE_MAX_PER_DAY); return Number.isInteger(v) && v > 0 ? v : 4;
};
export const REBASE_COMMENT = '@dependabot rebase';
const REBASE_EVERY_MS = 24 * 3_600_000;

const parseVersion = (v: string): number[] | null => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
};

/** Semver bump between two versions. 0.x: a minor change is breaking (caret ranges), so it counts as major. Downgrades are unknown. */
export function bumpOf(from: string, to: string): Bump {
  const a = parseVersion(from); const b = parseVersion(to);
  if (!a || !b) return 'unknown';
  const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (cmp > 0) return 'unknown';
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return a[0] === 0 ? 'major' : 'minor';
  return 'patch';
}

const RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2, unknown: 3 };
export interface ParsedUpdate { name: string; from: string; to: string; bump: Bump }

/** Every "<dep> from A to B" Dependabot names in title and body; the PR's bump is the largest (unknown beats major). */
export function parseDependabotPr(title: string, body: string | null | undefined): { updates: ParsedUpdate[]; bump: Bump } {
  const text = `${title}\n${body ?? ''}`;
  const found = new Map<string, ParsedUpdate>();
  const add = (name: string, from: string, to: string) => {
    const clean = (s: string) => s.replace(/[.,;:]+$/, '');
    if (!found.has(name)) found.set(name, { name, from: clean(from), to: clean(to), bump: bumpOf(clean(from), clean(to)) });
  };
  for (const m of text.matchAll(/^Updates `([^`]+)` from (\S+) to (\S+)/gm)) add(m[1], m[2], m[3]);
  for (const m of text.matchAll(/^Bumps \[([^\]]+)\]\([^)]*\) from (\S+) to (\S+)/gm)) add(m[1], m[2], m[3]);
  const t = /\bbump (\S+) from (\S+) to (\S+)/i.exec(title);
  if (t) add(t[1], t[2], t[3]);
  const updates = [...found.values()];
  // a group that announces more updates than were parsed hides one we cannot judge (title or the body's own "Bumps the …"
  // line only: quoted upstream release notes mention other groups' "with 10 updates")
  const announced = Number((/with (\d+) updates?/i.exec(title) ?? /^Bumps the .* with (\d+) updates?/im.exec(body ?? ''))?.[1] ?? 0);
  const bump: Bump = !updates.length || updates.length < announced ? 'unknown'
    : updates.reduce<Bump>((max, u) => (RANK[u.bump] > RANK[max] ? u.bump : max), 'patch');
  return { updates, bump };
}

export interface LanePr { number: number; title: string; body: string | null; head_ref: string; head_sha: string; base_ref: string; created_at: string; html_url: string }
export interface LaneGitHub {
  listDependabotPrs(): Promise<LanePr[]>;
  getMergeability(number: number): Promise<{ mergeable: boolean | null; mergeable_state: string; head_sha: string }>;
  behindBy(base: string, sha: string): Promise<number>;
  checkState(sha: string): Promise<CheckState>;
  comment(number: number, body: string): Promise<void>;
  squashMerge(number: number, sha: string): Promise<{ merged: boolean; sha?: string; message?: string }>;
}

const RED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/** The real client: the GITHUB_TOKEN / GITHUB_REPOSITORY the draft-PR service and merge survival already use. */
export function githubLaneClient(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): LaneGitHub | null {
  const repo = env.GITHUB_REPOSITORY; const token = env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const json = await res.json().catch(() => ({})) as T & { message?: string };
    if (!res.ok) throw Object.assign(new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status} ${json.message ?? ''}`.trim()), { status: res.status, body: json });
    return json;
  };
  type ApiPr = { number: number; title: string; body: string | null; user?: { login?: string }; head: { ref: string; sha: string }; base: { ref: string }; created_at: string; html_url: string };
  return {
    async listDependabotPrs() {
      const all: ApiPr[] = [];
      for (let page = 1; page <= 5; page++) {
        const batch = await call<ApiPr[]>(`pulls?state=open&per_page=100&page=${page}`);
        all.push(...batch); if (batch.length < 100) break;
      }
      return all.filter((p) => p.user?.login === 'dependabot[bot]').map((p) => ({ number: p.number, title: p.title, body: p.body, head_ref: p.head.ref,
        head_sha: p.head.sha, base_ref: p.base.ref, created_at: p.created_at, html_url: p.html_url }));
    },
    async getMergeability(number) {
      const p = await call<{ mergeable: boolean | null; mergeable_state: string; head: { sha: string } }>(`pulls/${number}`);
      return { mergeable: p.mergeable, mergeable_state: p.mergeable_state, head_sha: p.head.sha };
    },
    async behindBy(base, sha) { return (await call<{ behind_by: number }>(`compare/${encodeURIComponent(base)}...${sha}`)).behind_by; },
    async checkState(sha) {
      const runs = (await call<{ check_runs: Array<{ status: string; conclusion: string | null }> }>(`commits/${sha}/check-runs?per_page=100`)).check_runs;
      const status = await call<{ state: string; statuses: unknown[] }>(`commits/${sha}/status`);
      if (runs.some((r) => r.status === 'completed' && RED.has(String(r.conclusion))) || (status.statuses.length && ['failure', 'error'].includes(status.state))) return 'failure';
      if (runs.some((r) => r.status !== 'completed') || (status.statuses.length && status.state === 'pending')) return 'pending';
      return runs.length || status.statuses.length ? 'success' : 'none';
    },
    async comment(number, body) { await call(`issues/${number}/comments`, { method: 'POST', body: { body } }); },
    async squashMerge(number, sha) {
      try { return await call<{ merged: boolean; sha?: string; message?: string }>(`pulls/${number}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha } }); }
      catch (e) { return { merged: false, message: e instanceof Error ? e.message : String(e) }; }
    },
  };
}

export function ensureLaneTables(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS dependency_lane_prs (
      pr_number INTEGER PRIMARY KEY, title TEXT NOT NULL, html_url TEXT, bump TEXT NOT NULL, pr_created_at TEXT, check_state TEXT,
      decision TEXT NOT NULL, reason TEXT, last_rebase_request_at TEXT, merged_at TEXT, merge_sha TEXT, main_state TEXT, loop_run_id TEXT,
      open INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dependency_lane_state (id INTEGER PRIMARY KEY CHECK (id = 1), revoked_at TEXT, revoked_reason TEXT, reenabled_at TEXT, reenabled_by TEXT);
    INSERT OR IGNORE INTO dependency_lane_state (id) VALUES (1);`);
}

interface LaneState { revoked_at: string | null; revoked_reason: string | null; reenabled_at: string | null; reenabled_by: string | null }
const laneState = (db: Database): LaneState => db.prepare('SELECT revoked_at, revoked_reason, reenabled_at, reenabled_by FROM dependency_lane_state WHERE id = 1').get() as LaneState;

export interface TickResult { mode: LaneMode; effective: 'shadow' | 'act' | 'off'; seen: number; merged: number | null; rebased: number[]; revoked: boolean; decisions: Record<number, string> }

export async function runDependencyLaneTick(db: Database, gh: LaneGitHub, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<TickResult> {
  const mode = laneMode(env);
  const result: TickResult = { mode, effective: 'off', seen: 0, merged: null, rebased: [], revoked: false, decisions: {} };
  if (mode === 'off') return result;
  ensureLaneTables(db);
  const audit = new AuditService(db); const events = new LoopEventService(db);
  const iso = now.toISOString();

  // 1. the previous merge must be green on main before the next one; red revokes act mode
  let awaitingMain = false;
  const unverified = db.prepare('SELECT pr_number, merge_sha, loop_run_id, title FROM dependency_lane_prs WHERE merged_at IS NOT NULL AND main_state IS NULL AND merge_sha IS NOT NULL')
    .all() as Array<{ pr_number: number; merge_sha: string; loop_run_id: string | null; title: string }>;
  for (const m of unverified) {
    const state = await gh.checkState(m.merge_sha);
    if (state === 'failure') {
      db.prepare('UPDATE dependency_lane_prs SET main_state = ?, updated_at = ? WHERE pr_number = ?').run('red', iso, m.pr_number);
      if (!laneState(db).revoked_at) {
        const reason = `main CI red on ${m.merge_sha.slice(0, 12)} after merging #${m.pr_number}`;
        db.prepare('UPDATE dependency_lane_state SET revoked_at = ?, revoked_reason = ? WHERE id = 1').run(iso, reason);
        audit.record({ event_type: AuditEventType.CONFIG_CHANGED, user_id: 'system:dependency-lane', action: 'dependency_lane.act_revoked', resource_type: 'dependency_lane',
          resource_id: `pr:${m.pr_number}`, risk_level: RiskLevel.HIGH, before: { act: true }, after: { act: false }, metadata: { reason, merge_sha: m.merge_sha } });
        if (m.loop_run_id) events.recordEvent(m.loop_run_id, 'dependency_lane_revoked', 'error', reason, { pr_number: m.pr_number, merge_sha: m.merge_sha });
        result.revoked = true;
      }
    } else if (state === 'success') {
      db.prepare('UPDATE dependency_lane_prs SET main_state = ?, updated_at = ? WHERE pr_number = ?').run('green', iso, m.pr_number);
      if (m.loop_run_id) events.recordEvent(m.loop_run_id, 'dependency_main_green', 'info', `main CI green after #${m.pr_number}`, { merge_sha: m.merge_sha });
    } else awaitingMain = true;
  }

  const effective: 'shadow' | 'act' = mode === 'act' && !laneState(db).revoked_at ? 'act' : 'shadow';
  result.effective = effective;
  const dayStart = `${iso.slice(0, 10)}T00:00:00.000Z`;
  let mergedToday = (db.prepare('SELECT COUNT(*) AS n FROM dependency_lane_prs WHERE merged_at >= ?').get(dayStart) as { n: number }).n;
  const cap = laneMaxPerDay(env);
  let slotTaken = false; // one merge (or would-merge) per tick

  const prs = (await gh.listDependabotPrs()).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
  result.seen = prs.length;
  db.prepare('UPDATE dependency_lane_prs SET open = 0 WHERE merged_at IS NULL').run();
  const upsert = db.prepare(`INSERT INTO dependency_lane_prs (pr_number, title, html_url, bump, pr_created_at, check_state, decision, reason, open, updated_at)
    VALUES (@pr_number, @title, @html_url, @bump, @pr_created_at, @check_state, @decision, @reason, 1, @updated_at)
    ON CONFLICT(pr_number) DO UPDATE SET title = excluded.title, html_url = excluded.html_url, bump = excluded.bump, check_state = excluded.check_state,
      decision = excluded.decision, reason = excluded.reason, open = 1, updated_at = excluded.updated_at`);

  for (const pr of prs) {
    const { bump, updates } = parseDependabotPr(pr.title, pr.body);
    let checkState: CheckState | null = null;
    let merged = null as { sha: string | null; runId: string } | null; // assigned inside decide()
    const decide = async (): Promise<[string, string]> => {
      if (!pr.head_ref.startsWith('dependabot/npm_and_yarn/')) return ['skip_not_npm', 'only npm dependencies'];
      if (bump === 'major') return ['skip_major', updates.filter((u) => u.bump === 'major').map((u) => `${u.name} ${u.from}→${u.to}`).join(', ') || 'major bump'];
      if (bump === 'unknown') return ['skip_unknown_bump', 'bump could not be parsed from title/body'];
      checkState = await gh.checkState(pr.head_sha);
      if (checkState === 'pending') return ['wait_checks_pending', 'checks running'];
      if (checkState === 'none') return ['wait_no_checks', 'no checks reported yet'];
      // red is often only an outdated base (advisory fixes landed on main since): a red PR behind main is rebased too
      if (await gh.behindBy(pr.base_ref, pr.head_sha) > 0) {
        const why = `behind ${pr.base_ref}${checkState === 'failure' ? ', checks failing' : ''}`;
        const last = (db.prepare('SELECT last_rebase_request_at AS at FROM dependency_lane_prs WHERE pr_number = ?').get(pr.number) as { at: string | null } | undefined)?.at;
        if (last && now.getTime() - Date.parse(last) < REBASE_EVERY_MS) return ['rebase_requested_recently', `${why}; asked at ${last}`];
        if (effective === 'shadow') return ['would_rebase', why];
        await gh.comment(pr.number, REBASE_COMMENT);
        result.rebased.push(pr.number);
        return ['rebase_requested', why];
      }
      if (checkState === 'failure') return ['skip_checks_failing', 'checks failing on an up-to-date branch'];
      const mg = await gh.getMergeability(pr.number);
      if (mg.head_sha !== pr.head_sha) return ['wait_head_moved', 'head changed during the tick'];
      if (mg.mergeable !== true || !['clean', 'has_hooks'].includes(mg.mergeable_state)) return ['not_mergeable', `mergeable=${mg.mergeable} state=${mg.mergeable_state}`];
      if (slotTaken) return ['queued', 'one merge per tick'];
      if (effective === 'shadow') { slotTaken = true; return ['would_merge', mode === 'act' ? 'act revoked: shadow until re-enabled' : 'shadow mode']; }
      if (awaitingMain) return ['wait_main_verification', 'previous lane merge not green on main yet'];
      if (mergedToday >= cap) return ['capped', `${mergedToday}/${cap} merged today`];
      slotTaken = true;
      const merge = await gh.squashMerge(pr.number, pr.head_sha);
      if (!merge.merged) return ['merge_failed', String(merge.message ?? 'not merged').slice(0, 200)];
      mergedToday++; result.merged = pr.number;
      const runId = randomUUID();
      db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, metadata, created_at, updated_at, completed_at) VALUES (?, 'dependency-lane', 'closed', 'completed', ?, ?, ?, ?)`)
        .run(runId, JSON.stringify({ dependency_pr_url: pr.html_url, dependency_pr_number: pr.number, bump, updates, merge_sha: merge.sha ?? null }), iso, iso, iso);
      events.recordEvent(runId, 'dependency_merged', 'info', `squash-merged #${pr.number}: ${pr.title}`.slice(0, 300), { pr_number: pr.number, bump, merge_sha: merge.sha ?? null, updates });
      audit.record({ event_type: 'dependency_lane.merged' as AuditEventType, user_id: 'system:dependency-lane', action: 'dependency_lane.squash_merge', resource_type: 'pull_request',
        resource_id: `pr:${pr.number}`, risk_level: RiskLevel.MEDIUM, metadata: { title: pr.title, bump, updates, merge_sha: merge.sha ?? null, loop_run_id: runId } });
      merged = { sha: merge.sha ?? null, runId };
      return ['merged', `squash ${String(merge.sha ?? '').slice(0, 12)}`];
    };
    let decision: string; let reason: string;
    try { [decision, reason] = await decide(); } catch (e) { decision = 'error'; reason = (e instanceof Error ? e.message : String(e)).slice(0, 200); }
    result.decisions[pr.number] = decision;
    upsert.run({ pr_number: pr.number, title: pr.title, html_url: pr.html_url, bump, pr_created_at: pr.created_at, check_state: checkState, decision, reason, updated_at: iso });
    if (decision === 'rebase_requested') db.prepare('UPDATE dependency_lane_prs SET last_rebase_request_at = ? WHERE pr_number = ?').run(iso, pr.number);
    if (merged) db.prepare('UPDATE dependency_lane_prs SET merged_at = ?, merge_sha = ?, loop_run_id = ?, open = 0 WHERE pr_number = ?').run(iso, merged.sha, merged.runId, pr.number);
  }
  return result;
}

/** Operator re-enables act mode after a revocation (manage:config route). Audited; a no-op when nothing was revoked. */
export function reenableDependencyLane(db: Database, actor: string, reason: string, now = new Date()): { changed: boolean } {
  ensureLaneTables(db);
  const before = laneState(db);
  if (!before.revoked_at) return { changed: false };
  db.prepare('UPDATE dependency_lane_state SET revoked_at = NULL, revoked_reason = NULL, reenabled_at = ?, reenabled_by = ? WHERE id = 1').run(now.toISOString(), actor);
  new AuditService(db).record({ event_type: AuditEventType.CONFIG_CHANGED, user_id: actor, action: 'dependency_lane.act_reenabled', resource_type: 'dependency_lane',
    resource_id: 'dependency_lane', risk_level: RiskLevel.HIGH, before: { ...before }, after: { revoked_at: null }, metadata: { reason } });
  return { changed: true };
}

export interface LaneQueueRow { pr_number: number; title: string; html_url: string | null; bump: string; age_days: number | null; check_state: string | null; decision: string; reason: string | null; updated_at: string }
/** The read-only queue for /decisions and the digest: open PRs plus the last 7 days of lane merges. */
export function dependencyLaneQueue(db: Database, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  ensureLaneTables(db);
  const state = laneState(db);
  const rows = (db.prepare(`SELECT pr_number, title, html_url, bump, pr_created_at, check_state, decision, reason, updated_at FROM dependency_lane_prs
    WHERE open = 1 OR merged_at >= ? ORDER BY open DESC, pr_created_at ASC`).all(new Date(now - 7 * 86_400_000).toISOString()) as Array<LaneQueueRow & { pr_created_at: string | null }>)
    .map(({ pr_created_at, ...r }) => ({ ...r, age_days: pr_created_at ? Math.floor((now - Date.parse(pr_created_at)) / 86_400_000) : null }));
  const mode = laneMode(env);
  return {
    mode, effective_mode: mode === 'act' && state.revoked_at ? 'shadow' : mode, revoked_at: state.revoked_at, revoked_reason: state.revoked_reason,
    max_per_day: laneMaxPerDay(env),
    merged_24h: (db.prepare('SELECT COUNT(*) AS n FROM dependency_lane_prs WHERE merged_at >= ?').get(new Date(now - 86_400_000).toISOString()) as { n: number }).n,
    open: rows.filter((r) => r.decision !== 'merged').length, rows,
  };
}

/** Every 3 h by default (DEPENDENCY_LANE_INTERVAL_MS), first tick 10 min after boot. Null when off or without a token. */
export function startDependencyLane(db: Database, env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (laneMode(env) === 'off') return null;
  const gh = githubLaneClient(env);
  if (!gh) { console.warn('Dependency lane: GITHUB_REPOSITORY/GITHUB_TOKEN missing — not arming'); return null; }
  let running = false;
  const tick = () => {
    if (running) return; running = true;
    runDependencyLaneTick(db, gh, env).then((r) => {
      markRun('dependency_lane');
      if (r.merged !== null || r.rebased.length || r.revoked) console.log(`📦 dependency lane (${r.effective}): merged=${r.merged ?? '-'} rebased=${r.rebased.join(',') || '-'}${r.revoked ? ' ACT REVOKED' : ''}`);
    }).catch((e) => { markRun('dependency_lane', e); console.warn('dependency lane failed:', e instanceof Error ? e.message : String(e)); })
      .finally(() => { running = false; });
  };
  const first = setTimeout(tick, 600_000); first.unref?.();
  const timer = setInterval(tick, laneIntervalMs(env)); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
export const laneIntervalMs = (env: NodeJS.ProcessEnv = process.env): number => Number(env.DEPENDENCY_LANE_INTERVAL_MS) > 0 ? Number(env.DEPENDENCY_LANE_INTERVAL_MS) : 3 * 3_600_000;
