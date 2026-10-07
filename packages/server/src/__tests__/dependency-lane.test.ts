import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { UserRole } from '@djimitflo/shared';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createAuthMiddleware } from '../middleware/auth';
import { AuthService } from '../services/auth-service';
import { createLoopRoutes } from '../routes/loops';
import { errorHandler } from '../middleware/error-handler';
import { buildDigest } from '../services/operator-push';
import {
  bumpOf, parseDependabotPr, runDependencyLaneTick, dependencyLaneQueue, REBASE_COMMENT,
  type CheckState, type LaneGitHub, type LanePr,
} from '../services/dependency-lane';

const freshDb = () => { const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); return db; };
const T0 = new Date('2026-10-07T08:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

function pr(number: number, title: string, extra: Partial<LanePr> = {}): LanePr {
  return { number, title, body: null, head_ref: `dependabot/npm_and_yarn/x-${number}`, head_sha: `sha${number}`, base_ref: 'main',
    created_at: `2026-09-${String(10 + (number % 18)).padStart(2, '0')}T00:00:00Z`, html_url: `https://github.com/o/r/pull/${number}`, ...extra };
}

/** Mock GitHub: per-sha check state, per-sha behind count, merge results; records every write. */
function mockGh(prs: LanePr[], opts: { checks?: Record<string, CheckState>; behind?: Record<string, number> } = {}) {
  const checks: Record<string, CheckState> = { ...opts.checks }; const behind: Record<string, number> = { ...opts.behind };
  const writes = { comments: [] as Array<[number, string]>, merges: [] as number[] };
  let open = [...prs];
  const gh: LaneGitHub = {
    listDependabotPrs: async () => open,
    getMergeability: async (n) => ({ mergeable: true, mergeable_state: 'clean', head_sha: open.find((p) => p.number === n)!.head_sha }),
    behindBy: async (_b, sha) => behind[sha] ?? 0,
    checkState: async (sha) => checks[sha] ?? 'success',
    comment: async (n, body) => { writes.comments.push([n, body]); },
    squashMerge: async (n) => { writes.merges.push(n); open = open.filter((p) => p.number !== n); return { merged: true, sha: `merge${n}` }; },
  };
  return { gh, writes, checks, behind };
}
const ACT = { DEPENDENCY_LANE_MODE: 'act' } as NodeJS.ProcessEnv;

describe('semver parse', () => {
  it('classifies patch/minor/major, treats 0.x minor as major and refuses downgrades or garbage', () => {
    expect(bumpOf('8.5.26', '8.5.28')).toBe('patch');
    expect(bumpOf('1.47.0', '1.51.0')).toBe('minor');
    expect(bumpOf('7.0.11', '8.1.1')).toBe('major');
    expect(bumpOf('0.24.2', '0.25.0')).toBe('major');
    expect(bumpOf('0.24.2', '0.24.3')).toBe('patch');
    expect(bumpOf('v4.4.0', 'v4.5.0')).toBe('minor');
    expect(bumpOf('2.0.0', '1.9.0')).toBe('unknown');
    expect(bumpOf('latest', '1.0.0')).toBe('unknown');
  });

  it('parses single and grouped Dependabot PRs; a group touching a major is major; an under-parsed group is unknown', () => {
    expect(parseDependabotPr('deps(deps-dev): bump postcss from 8.5.26 to 8.5.28', 'Bumps [postcss](https://github.com/postcss/postcss) from 8.5.26 to 8.5.28.'))
      .toEqual({ bump: 'patch', updates: [{ name: 'postcss', from: '8.5.26', to: '8.5.28', bump: 'patch' }] });
    expect(parseDependabotPr('deps(deps): Bump zod from 4.4.3 to 4.6.5', '').bump).toBe('minor');
    const linting = parseDependabotPr('deps(deps-dev): bump the linting group across 1 directory with 2 updates',
      'Bumps the linting group with 2 updates in the / directory: [eslint](x) and [typescript-eslint](y).\n\nUpdates `eslint` from 10.10.0 to 10.12.0\n<details>\nUpdates `typescript-eslint` from 8.70.0 to 8.71.0\n');
    expect(linting.bump).toBe('minor'); expect(linting.updates.map((u) => u.name)).toEqual(['eslint', 'typescript-eslint']);
    const testing = parseDependabotPr('deps(deps-dev): bump the testing group across 1 directory with 4 updates',
      'Bumps the testing group with 4 updates\nUpdates `@testing-library/dom` from 10.4.1 to 10.4.2\nUpdates `@testing-library/react` from 16.3.2 to 16.3.3\nUpdates `jsdom` from 29.1.1 to 30.1.0\nUpdates `vitest` from 4.1.11 to 5.0.1\n');
    expect(testing.bump).toBe('major');
    expect(parseDependabotPr('bump the x group with 3 updates', 'Updates `a` from 1.0.0 to 1.0.1\n').bump).toBe('unknown');
    expect(parseDependabotPr('chore: something else', 'no versions here').bump).toBe('unknown');
    // quoted upstream release notes ("bump the angular-deps group … with 10 updates") are not this PR's group (prod #502)
    expect(parseDependabotPr('deps(deps): bump lucide-react from 1.47.0 to 1.51.0',
      'Bumps [lucide-react](https://x) from 1.47.0 to 1.51.0.\n<li>chore(deps-dev): bump the angular-deps group across 1 directory with 10 updates by dependabot</li>').bump).toBe('minor');
  });
});

describe('filter', () => {
  it('skips majors, groups touching a major, non-npm and red up-to-date checks; pending waits; the green patch merges', async () => {
    const db = freshDb();
    const { gh, writes } = mockGh([
      pr(302, 'ci: bump actions/setup-node from 4.4.0 to 4.5.0', { head_ref: 'dependabot/github_actions/actions/setup-node-4.5.0' }),
      pr(303, 'deps: bump foo from 1.0.0 to 2.0.0'),
      pr(291, 'deps(deps-dev): bump the testing group across 1 directory with 2 updates', { body: 'Updates `jsdom` from 29.1.1 to 29.2.0\nUpdates `vitest` from 4.1.11 to 5.0.1\n' }),
      pr(304, 'deps: bump red from 1.0.0 to 1.0.1'),
      pr(305, 'deps: bump slow from 1.0.0 to 1.0.1'),
      pr(306, 'deps: bump good from 1.0.0 to 1.0.1'),
    ], { checks: { sha304: 'failure', sha305: 'pending' } });
    const r = await runDependencyLaneTick(db, gh, ACT, T0);
    expect(r.decisions).toMatchObject({ 302: 'skip_not_npm', 303: 'skip_major', 291: 'skip_major', 304: 'skip_checks_failing', 305: 'wait_checks_pending', 306: 'merged' });
    expect(writes.merges).toEqual([306]);
    expect(writes.comments).toEqual([]);
  });
});

describe('rebase-comment rate limit', () => {
  it('asks Dependabot to rebase a behind PR at most once per 24 h, and never in shadow', async () => {
    const db = freshDb();
    const { gh, writes } = mockGh([pr(500, 'deps: bump a from 1.0.0 to 1.1.0')], { behind: { sha500: 3 } });
    expect((await runDependencyLaneTick(db, gh, { DEPENDENCY_LANE_MODE: 'shadow' } as NodeJS.ProcessEnv, T0)).decisions[500]).toBe('would_rebase');
    expect(writes.comments).toEqual([]);
    expect((await runDependencyLaneTick(db, gh, ACT, T0)).decisions[500]).toBe('rebase_requested');
    expect((await runDependencyLaneTick(db, gh, ACT, at(3))).decisions[500]).toBe('rebase_requested_recently');
    expect((await runDependencyLaneTick(db, gh, ACT, at(23))).decisions[500]).toBe('rebase_requested_recently');
    expect((await runDependencyLaneTick(db, gh, ACT, at(25))).decisions[500]).toBe('rebase_requested');
    expect(writes.comments).toEqual([[500, REBASE_COMMENT], [500, REBASE_COMMENT]]);
    expect(writes.merges).toEqual([]);
  });
});

describe('red PRs', () => {
  it('red AND behind main gets the once-per-24 h rebase request (shadow: would_rebase); red and up to date is skipped', async () => {
    const db = freshDb();
    const { gh, writes } = mockGh([pr(1200, 'deps: bump red-behind from 1.0.0 to 1.0.1'), pr(1201, 'deps: bump red-current from 1.0.0 to 1.0.1')],
      { checks: { sha1200: 'failure', sha1201: 'failure' }, behind: { sha1200: 7 } });
    expect((await runDependencyLaneTick(db, gh, { DEPENDENCY_LANE_MODE: 'shadow' } as NodeJS.ProcessEnv, T0)).decisions).toEqual({ 1200: 'would_rebase', 1201: 'skip_checks_failing' });
    expect(writes.comments).toEqual([]);
    expect((await runDependencyLaneTick(db, gh, ACT, T0)).decisions).toEqual({ 1200: 'rebase_requested', 1201: 'skip_checks_failing' });
    expect((await runDependencyLaneTick(db, gh, ACT, at(3))).decisions[1200]).toBe('rebase_requested_recently');
    expect(writes.comments).toEqual([[1200, REBASE_COMMENT]]);
    expect(writes.merges).toEqual([]);
  });
});

describe('one merge per tick, daily cap', () => {
  it('merges ONE ready PR per tick (oldest first); the rest are queued', async () => {
    const db = freshDb();
    const { gh, writes, checks } = mockGh([pr(601, 'deps: bump a from 1.0.0 to 1.0.1', { created_at: '2026-09-20T00:00:00Z' }), pr(600, 'deps: bump b from 1.0.0 to 1.0.1', { created_at: '2026-09-14T00:00:00Z' })]);
    const r = await runDependencyLaneTick(db, gh, ACT, T0);
    expect(r.decisions).toEqual({ 600: 'merged', 601: 'queued' });
    expect(writes.merges).toEqual([600]);
    // the next tick waits for main CI on the first merge before merging again
    checks.merge600 = 'pending';
    expect((await runDependencyLaneTick(db, gh, ACT, at(3))).decisions[601]).toBe('wait_main_verification');
    checks.merge600 = 'success';
    expect((await runDependencyLaneTick(db, gh, ACT, at(6))).decisions[601]).toBe('merged');
    expect(writes.merges).toEqual([600, 601]);
    // every merge is an audit event and a loop event
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'dependency_lane.squash_merge'").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM loop_events e JOIN loop_runs r ON r.id = e.loop_run_id WHERE r.loop_name = 'dependency-lane' AND e.event_type = 'dependency_merged'").get() as { n: number }).n).toBe(2);
  });

  it('shadow records would_merge for one PR and merges nothing', async () => {
    const db = freshDb();
    const { gh, writes } = mockGh([pr(700, 'deps: bump a from 1.0.0 to 1.0.1'), pr(701, 'deps: bump b from 1.0.0 to 1.0.1')]);
    const r = await runDependencyLaneTick(db, gh, { DEPENDENCY_LANE_MODE: 'shadow' } as NodeJS.ProcessEnv, T0);
    expect(Object.values(r.decisions).sort()).toEqual(['queued', 'would_merge']);
    expect(writes.merges).toEqual([]);
  });

  it('stops at DEPENDENCY_LANE_MAX_PER_DAY merges per UTC day', async () => {
    const db = freshDb();
    const env = { DEPENDENCY_LANE_MODE: 'act', DEPENDENCY_LANE_MAX_PER_DAY: '1' } as NodeJS.ProcessEnv;
    const { gh, writes } = mockGh([pr(800, 'deps: bump a from 1.0.0 to 1.0.1'), pr(801, 'deps: bump b from 1.0.0 to 1.0.1')]);
    await runDependencyLaneTick(db, gh, env, T0); // merges one; its main CI is green (mock default)
    expect((await runDependencyLaneTick(db, gh, env, at(3))).decisions[801]).toBe('capped');
    expect(writes.merges).toHaveLength(1);
    expect((await runDependencyLaneTick(db, gh, env, at(17))).decisions[801]).toBe('merged'); // next UTC day
  });

  it('off does nothing', async () => {
    const db = freshDb();
    const { gh, writes } = mockGh([pr(900, 'deps: bump a from 1.0.0 to 1.0.1')]);
    expect((await runDependencyLaneTick(db, gh, {} as NodeJS.ProcessEnv, T0)).effective).toBe('off');
    expect(writes).toEqual({ comments: [], merges: [] });
  });
});

describe('revocation', () => {
  it('main CI red after a lane merge revokes act (persisted) until an operator re-enables it through the audited manage:config route', async () => {
    const db = freshDb();
    const { gh, writes, checks } = mockGh([pr(1000, 'deps: bump a from 1.0.0 to 1.0.1'), pr(1001, 'deps: bump b from 1.0.0 to 1.0.1')]);
    checks.merge1000 = 'failure';
    expect((await runDependencyLaneTick(db, gh, ACT, T0)).merged).toBe(1000);
    const r = await runDependencyLaneTick(db, gh, ACT, at(3));
    expect(r).toMatchObject({ revoked: true, effective: 'shadow' });
    expect(r.decisions[1001]).toBe('would_merge');
    expect((await runDependencyLaneTick(db, gh, ACT, at(30))).effective).toBe('shadow'); // persisted across ticks
    expect(writes.merges).toEqual([1000]);
    expect(dependencyLaneQueue(db, ACT, at(30).getTime())).toMatchObject({ mode: 'act', effective_mode: 'shadow' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'dependency_lane.act_revoked'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM loop_events WHERE event_type = 'dependency_lane_revoked' AND level = 'error'").get()).toEqual({ n: 1 });

    const authService = new AuthService(db);
    const viewer = authService.generateToken(authService.createUser('lane-viewer@example.test', 'disposable-password', UserRole.VIEWER));
    const admin = authService.generateToken(authService.createUser('lane-admin@example.test', 'disposable-password', UserRole.ADMIN));
    const auth = createAuthMiddleware(authService);
    const app = express().use(express.json()).use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/loops', auth.requireAuth, createLoopRoutes(db, auth)).use(errorHandler);
    expect((await request(app).get('/api/loops/dependency-lane')).status).toBe(401);
    const q = await request(app).get('/api/loops/dependency-lane').set('Authorization', `Bearer ${viewer}`);
    expect(q.status).toBe(200); expect(q.body.rows.map((x: { pr_number: number }) => x.pr_number)).toContain(1001);
    expect((await request(app).post('/api/loops/dependency-lane/re-enable').set('Authorization', `Bearer ${viewer}`).send({ reason: 'x' })).status).toBe(403);
    expect((await request(app).post('/api/loops/dependency-lane/re-enable').set('Authorization', `Bearer ${admin}`).send({})).status).toBe(400);
    const ok = await request(app).post('/api/loops/dependency-lane/re-enable').set('Authorization', `Bearer ${admin}`).send({ reason: 'main fixed in #700' });
    expect(ok.status).toBe(200); expect(ok.body).toEqual({ changed: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'dependency_lane.act_reenabled'").get()).toEqual({ n: 1 });
    expect((await runDependencyLaneTick(db, gh, ACT, at(31))).decisions[1001]).toBe('merged');
  });
});

it('digest counts the lane queue when the lane is on', async () => {
  const db = freshDb();
  const { gh } = mockGh([pr(1100, 'deps: bump a from 1.0.0 to 1.0.1'), pr(1101, 'deps: bump b from 1.0.0 to 2.0.0')]);
  await runDependencyLaneTick(db, gh, ACT, T0);
  const d = buildDigest(db, at(1).getTime(), ACT);
  expect(d.data.dependency_lane).toEqual({ mode: 'act', open: 1, merged_24h: 1, revoked: false });
  expect(d.text).toContain('Dependency lane (act): 1 Dependabot PRs open, 1 merged in 24 h');
  expect(buildDigest(freshDb(), at(1).getTime(), {} as NodeJS.ProcessEnv).data.dependency_lane).toBeNull();
});
