import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { runCiWatchTick } from '../services/loop-pr-ci-watch';

// PRC-2: record-only CI watch over open loop PRs — required checks on the PR head, never a repair, push or comment.
let db: Database.Database;
const ENV = { LOOP_PR_CI_WATCH: 'shadow', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't0ken' };
type Run = { name: string; status: string; conclusion: string | null; app?: { id: number }; id?: number };
interface Fake { prState?: string; sha?: string; checks?: Run[] | 'error'; statuses?: Array<{ context: string; state: string }>; pull?: 'error'; protection?: 'error' }
const github = (fake: Fake) => vi.fn(async (url: string, init?: { method?: string }) => {
  if (init?.method && init.method !== 'GET') throw new Error(`write call ${init.method} ${url}`);
  const json = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const sha = fake.sha ?? 'abc123';
  if (/\/pulls\/\d+$/.test(url)) return fake.pull === 'error' ? json({}, 502) : json({ number: 9, state: fake.prState ?? 'open', head: { sha }, base: { ref: 'main' } });
  if (url.endsWith('/branches/main/protection/required_status_checks')) return fake.protection === 'error' ? json({}, 403) : json({ checks: [{ context: 'test', app_id: 15368 }, { context: 'lint', app_id: 15368 }] });
  if (url.endsWith('/branches/main')) return fake.protection === 'error' ? json({}, 500) : json({ protection: {} });
  if (url.endsWith(`/commits/${sha}/check-runs?per_page=100`)) return fake.checks === 'error' ? json({}, 500) : json({ check_runs: (fake.checks ?? []).map((c, i) => ({ id: i + 1, app: { id: 15368 }, ...c })) });
  if (url.endsWith(`/commits/${sha}/status`)) return json({ state: 'success', statuses: fake.statuses ?? [] });
  return json({}, 404);
});
const ok = (name: string): Run => ({ name, status: 'completed', conclusion: 'success' });
const seed = (id: string, url = 'https://github.com/o/r/pull/9', created = new Date().toISOString()) =>
  db.prepare(`INSERT INTO loop_runs (id, loop_name, mode, status, gates_json, metadata, created_at, updated_at) VALUES (?, 'l', 'closed', 'completed', '[]', ?, ?, ?)`).run(id, JSON.stringify({ pr_url: url }), created, created);
const ci = (id = 'run-1') => JSON.parse((db.prepare('SELECT metadata FROM loop_runs WHERE id = ?').get(id) as { metadata: string }).metadata).ci;
const events = (type: string) => db.prepare('SELECT message, metadata FROM loop_events WHERE event_type = ?').all(type) as Array<{ message: string; metadata: string }>;

beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); seed('run-1'); });
afterEach(() => { db.close(); });

it('PRC-2: flag off (default) reads nothing and writes nothing', async () => {
  const f = github({ checks: [ok('test'), ok('lint')] });
  expect(await runCiWatchTick(db, f as unknown as typeof fetch, { ...ENV, LOOP_PR_CI_WATCH: '' })).toEqual({ read: 0, green: 0, red: 0, pending: 0, unknown: 0 });
  expect(f).not.toHaveBeenCalled();
  expect(ci()).toBeUndefined();
  expect(events('ci_green')).toEqual([]);
});

it('PRC-2: every required check successful on the head is green with one ci_green event, deduped on (run, head, state)', async () => {
  const f = github({ checks: [ok('test'), ok('lint'), { name: 'CodeQL', status: 'completed', conclusion: 'failure' }] }); // non-required red does not count
  expect(await runCiWatchTick(db, f as unknown as typeof fetch, ENV)).toEqual({ read: 1, green: 1, red: 0, pending: 0, unknown: 0 });
  expect(ci()).toMatchObject({ head_sha: 'abc123', state: 'green', failing: [] });
  expect(typeof ci().read_at).toBe('string');
  await runCiWatchTick(db, f as unknown as typeof fetch, ENV);
  expect(events('ci_green')).toHaveLength(1);
  expect(JSON.parse(events('ci_green')[0].metadata)).toEqual({ head_sha: 'abc123', state: 'green', failing: [], pr_url: 'https://github.com/o/r/pull/9' });
});

it('PRC-2: a required check that completed without success is red with its name in failing; a new head re-fires', async () => {
  const f = github({ checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'skipped' }] });
  expect(await runCiWatchTick(db, f as unknown as typeof fetch, ENV)).toEqual({ read: 1, green: 0, red: 1, pending: 0, unknown: 0 });
  expect(ci()).toMatchObject({ head_sha: 'abc123', state: 'red', failing: ['lint', 'test'] });
  await runCiWatchTick(db, f as unknown as typeof fetch, ENV);
  expect(events('ci_red').map((e) => e.message)).toEqual(['CI red on abc123: lint, test']);
  await runCiWatchTick(db, github({ sha: 'def456', checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }, ok('lint')] }) as unknown as typeof fetch, ENV);
  expect(events('ci_red').map((e) => e.message)).toEqual(['CI red on abc123: lint, test', 'CI red on def456: test']);
});

it('PRC-2: a required check running or not reported yet is pending, with no event', async () => {
  const f = github({ checks: [ok('test'), { name: 'lint', status: 'in_progress', conclusion: null }] });
  expect(await runCiWatchTick(db, f as unknown as typeof fetch, ENV)).toEqual({ read: 1, green: 0, red: 0, pending: 1, unknown: 0 });
  expect(ci()).toMatchObject({ state: 'pending', failing: [] });
  await runCiWatchTick(db, github({ checks: [ok('test')] }) as unknown as typeof fetch, ENV);
  expect(ci()).toMatchObject({ state: 'pending', failing: [] });
  expect([...events('ci_red'), ...events('ci_green')]).toEqual([]);
});

it('PRC-2: GitHub errors are unknown, never red', async () => {
  expect(await runCiWatchTick(db, github({ checks: 'error' }) as unknown as typeof fetch, ENV)).toEqual({ read: 1, green: 0, red: 0, pending: 0, unknown: 1 });
  expect(ci()).toMatchObject({ head_sha: 'abc123', state: 'unknown', failing: [] });
  await runCiWatchTick(db, github({ pull: 'error' }) as unknown as typeof fetch, ENV);
  expect(ci()).toMatchObject({ head_sha: null, state: 'unknown', failing: [] });
  await runCiWatchTick(db, github({ protection: 'error', checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }) as unknown as typeof fetch, ENV);
  expect(ci()).toMatchObject({ state: 'unknown', failing: [] }); // required set unreadable: no verdict
  expect(events('ci_red')).toEqual([]);
});

it('PRC-2: bounded to 10 runs per tick, least recently read first; a closed PR leaves the watch', async () => {
  for (let i = 2; i <= 12; i++) seed(`run-${i}`);
  const f = github({ checks: [ok('test'), ok('lint')] });
  expect((await runCiWatchTick(db, f as unknown as typeof fetch, ENV)).read).toBe(10);
  expect((await runCiWatchTick(db, f as unknown as typeof fetch, ENV)).read).toBe(10);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM loop_runs WHERE json_extract(metadata, '$.ci.state') = 'green'`).get() as { n: number }).n).toBe(12);
  db.prepare('DELETE FROM loop_runs').run(); seed('run-1');
  await runCiWatchTick(db, github({ prState: 'closed' }) as unknown as typeof fetch, ENV);
  expect(ci()).toMatchObject({ pr_state: 'closed', state: 'unknown' });
  expect((await runCiWatchTick(db, f as unknown as typeof fetch, ENV)).read).toBe(0);
});
