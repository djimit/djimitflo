import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isoWeekLabel, isoWeekStart, subtractionKpi } from '../services/subtraction-kpi';

let repo: string;
const NOW = Date.parse('2026-10-18T12:00:00Z'); // Sunday of 2026-W42
const DAY = 86_400_000;

const gitEnv = (iso?: string) => ({
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  ...(iso ? { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } : {}),
});
const commitIn = (r: string, msg: string, iso: string) => execFileSync('git', ['-C', r, 'commit', '-q', '-am', msg], { env: gitEnv(iso) });
const writeIn = (r: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), text); };

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'subtraction-kpi-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  // W40 (before the window of 2 weeks): 3 routes
  writeIn(repo, 'packages/server/src/routes/a.ts', "router.get('/a', h);\nrouter.post('/b', h);\nrouter.delete('/c', h);\n");
  writeIn(repo, 'README.md', 'x\n');
  execFileSync('git', ['-C', repo, 'add', '-A']); commitIn(repo, 'base', '2026-09-30T10:00:00Z');
  // W41: add a file (2 lines) and one route
  writeIn(repo, 'src/new.ts', 'one\ntwo\n'); writeIn(repo, 'packages/server/src/routes/a.ts', "router.get('/a', h);\nrouter.post('/b', h);\nrouter.delete('/c', h);\nrouter.put('/d', h);\n");
  execFileSync('git', ['-C', repo, 'add', '-A']); commitIn(repo, 'add', '2026-10-07T10:00:00Z');
  // W42: delete the file and two routes
  fs.rmSync(path.join(repo, 'src/new.ts')); writeIn(repo, 'packages/server/src/routes/a.ts', "router.get('/a', h);\nrouter.post('/b', h);\n");
  execFileSync('git', ['-C', repo, 'add', '-A']); commitIn(repo, 'subtract', '2026-10-14T10:00:00Z');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

// --- isoWeekStart / isoWeekLabel ---

it('isoWeekStart maps every day of the week to its Monday UTC midnight', () => {
  const monday = Date.parse('2026-10-12T00:00:00Z'); // Mon W42
  for (let i = 0; i < 7; i++) expect(isoWeekStart(monday + i * DAY)).toBe(monday);
  const prevMon = Date.parse('2026-10-05T00:00:00Z'); // Mon W41
  for (let i = 0; i < 7; i++) expect(isoWeekStart(prevMon + i * DAY)).toBe(prevMon);
});

it('isoWeekLabel pads single-digit weeks and resolves the year via Thursday', () => {
  expect(isoWeekLabel(Date.parse('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  expect(isoWeekLabel(Date.parse('2026-02-23T00:00:00Z'))).toBe('2026-W09');
  expect(isoWeekLabel(NOW)).toBe('2026-W42');
  expect(isoWeekLabel(Date.parse('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  expect(isoWeekLabel(Date.parse('2025-01-01T00:00:00Z'))).toBe('2025-W01');
});

// --- subtractionKpi main flow ---

it('counts lines, files and route registrations added vs removed per ISO week from git history', () => {
  const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: repo }, NOW, 2);
  expect(k.status).toBe('ok');
  expect(k.weeks?.map((w) => w.week)).toEqual(['2026-W41', '2026-W42']);
  expect(k.weeks?.[0]).toMatchObject({ commits: 1, lines_added: 3, lines_removed: 0, files_added: 1, files_deleted: 0, ratio_removed_added: 0, routes_start: 3, routes_end: 4, routes_delta: 1 });
  expect(k.weeks?.[1]).toMatchObject({ commits: 1, lines_added: 0, lines_removed: 4, files_added: 0, files_deleted: 1, ratio_removed_added: null, routes_start: 4, routes_end: 2, routes_delta: -2 });
});

it('defaults to 8 weeks when the count is omitted', () => {
  const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: repo }, NOW);
  expect(k.weeks).toHaveLength(8);
  expect(k.weeks![7].week).toBe('2026-W42');
  expect(k.weeks![0].week).toBe('2026-W35');
});

it('returns null for routes fields when no commit exists before a bound', () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-kpi-null-'));
  execFileSync('git', ['-C', r2, 'init', '-q']);
  writeIn(r2, 'packages/server/src/routes/a.ts', "router.get('/a', h);\n");
  execFileSync('git', ['-C', r2, 'add', '-A']);
  commitIn(r2, 'only-w42', '2026-10-14T10:00:00Z'); // Wed W42 — after both earlier bounds
  try {
    const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: r2 }, NOW, 2);
    expect(k.weeks?.[0].routes_start).toBeNull();
    expect(k.weeks?.[0].routes_end).toBeNull();
    expect(k.weeks?.[0].routes_delta).toBeNull();
    expect(k.weeks?.[1].routes_start).toBeNull();
    expect(k.weeks?.[1].routes_end).toBe(1);
    expect(k.weeks?.[1].routes_delta).toBeNull();
  } finally { fs.rmSync(r2, { recursive: true, force: true }); }
});

it('treats binary file changes as zero lines but still counts the file add', () => {
  const r3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-kpi-bin-'));
  execFileSync('git', ['-C', r3, 'init', '-q']);
  writeIn(r3, 'README.md', 'start\n');
  execFileSync('git', ['-C', r3, 'add', '-A']);
  commitIn(r3, 'base-w40', '2026-10-04T10:00:00Z'); // Sun W40 — outside the 2-week window
  // Add a binary file (NUL bytes trigger git's binary detection)
  fs.writeFileSync(path.join(r3, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]));
  execFileSync('git', ['-C', r3, 'add', '-A']);
  commitIn(r3, 'add-binary', '2026-10-07T10:00:00Z'); // Wed W41
  try {
    const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: r3 }, NOW, 2);
    expect(k.weeks?.[0].files_added).toBe(1);
    expect(k.weeks?.[0].lines_added).toBe(0);
    expect(k.weeks?.[0].lines_removed).toBe(0);
  } finally { fs.rmSync(r3, { recursive: true, force: true }); }
});

it('computes ratio_removed_added to three decimal places for mixed add/remove commits', () => {
  const r4 = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-kpi-ratio-'));
  execFileSync('git', ['-C', r4, 'init', '-q']);
  writeIn(r4, 'old.txt', 'x\ny\nz\n');
  execFileSync('git', ['-C', r4, 'add', '-A']);
  commitIn(r4, 'base-w40', '2026-10-04T10:00:00Z');
  // W41: delete old.txt (3 lines removed) and add new.txt (4 lines added) → ratio 3/4 = 0.75
  fs.rmSync(path.join(r4, 'old.txt'));
  writeIn(r4, 'new.txt', 'p\nq\nr\ns\n');
  execFileSync('git', ['-C', r4, 'add', '-A']);
  commitIn(r4, 'swap', '2026-10-07T10:00:00Z');
  try {
    const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: r4 }, NOW, 2);
    expect(k.weeks?.[0].lines_added).toBe(4);
    expect(k.weeks?.[0].lines_removed).toBe(3);
    expect(k.weeks?.[0].ratio_removed_added).toBe(0.75);
    expect(k.weeks?.[0].files_added).toBe(1);
    expect(k.weeks?.[0].files_deleted).toBe(1);
  } finally { fs.rmSync(r4, { recursive: true, force: true }); }
});

it('excludes merge commits from the per-week commit count', () => {
  const r5 = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-kpi-merge-'));
  execFileSync('git', ['-C', r5, 'init', '-q', '-b', 'main']);
  writeIn(r5, 'main.txt', 'base\n');
  execFileSync('git', ['-C', r5, 'add', '-A']);
  commitIn(r5, 'base', '2026-10-05T10:00:00Z'); // Mon W41
  execFileSync('git', ['-C', r5, 'checkout', '-q', '-b', 'feature']);
  writeIn(r5, 'feat.txt', 'f\n');
  execFileSync('git', ['-C', r5, 'add', '-A']);
  commitIn(r5, 'feature-work', '2026-10-07T10:00:00Z'); // Wed W41
  execFileSync('git', ['-C', r5, 'checkout', '-q', 'main']);
  execFileSync('git', ['-C', r5, 'merge', '-q', '--no-ff', 'feature'], { env: gitEnv('2026-10-08T10:00:00Z') });
  try {
    const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: r5 }, NOW, 2);
    expect(k.weeks?.[0].commits).toBe(2); // base + feature-work; merge excluded
  } finally { fs.rmSync(r5, { recursive: true, force: true }); }
});

it('returns the same cached object for identical parameters', () => {
  const a = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: repo }, NOW, 2);
  const b = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: repo }, NOW, 2);
  expect(b).toBe(a);
});

it('reports unavailable when the env var is an empty string', () => {
  const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: '' }, NOW);
  expect(k.status).toBe('unavailable');
  expect(k.reason).toBe('LOOP_DAEMON_REPOSITORY_PATH is not set');
});

it('counts all six route verbs including capitalised Router and ignores non-route lines', () => {
  const r6 = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-kpi-verbs-'));
  execFileSync('git', ['-C', r6, 'init', '-q']);
  writeIn(r6, 'packages/server/src/routes/r.ts', [
    "router.get('/a', h);",
    "router.post('/b', h);",
    "router.put('/c', h);",
    "router.patch('/d', h);",
    "router.delete('/e', h);",
    "Router.all('/f', h);",
    "app.use(mw);",
  ].join('\n') + '\n');
  execFileSync('git', ['-C', r6, 'add', '-A']);
  commitIn(r6, 'routes', '2026-10-05T10:00:00Z'); // Mon W41
  try {
    const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: r6 }, NOW, 1);
    expect(k.weeks?.[0].routes_end).toBe(6);
  } finally { fs.rmSync(r6, { recursive: true, force: true }); }
});

it('reports zero for weeks with no commits and null ratio when nothing was added', () => {
  const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: repo }, NOW, 8);
  const empty = k.weeks!.find((w) => w.week === '2026-W39')!;
  expect(empty.commits).toBe(0);
  expect(empty.lines_added).toBe(0);
  expect(empty.lines_removed).toBe(0);
  expect(empty.files_added).toBe(0);
  expect(empty.files_deleted).toBe(0);
  expect(empty.ratio_removed_added).toBeNull();
});

it('assigns a commit exactly on the week start to that week (inclusive lower bound)', () => {
  const r7 = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-kpi-bound-'));
  execFileSync('git', ['-C', r7, 'init', '-q']);
  writeIn(r7, 'a.txt', 'x\n');
  execFileSync('git', ['-C', r7, 'add', '-A']);
  commitIn(r7, 'boundary', '2026-10-12T00:00:00Z'); // Mon W42 midnight
  try {
    const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: r7 }, NOW, 2);
    expect(k.weeks?.[0].commits).toBe(0); // W41 empty
    expect(k.weeks?.[1].commits).toBe(1); // W42 has it
  } finally { fs.rmSync(r7, { recursive: true, force: true }); }
});

it('reports unavailable with the reason — never 0 — without a repository', () => {
  expect(subtractionKpi({}, NOW)).toMatchObject({ status: 'unavailable', weeks: null, reason: 'LOOP_DAEMON_REPOSITORY_PATH is not set' });
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'subtraction-norepo-'));
  try {
    const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: notRepo }, NOW);
    expect(k.status).toBe('unavailable'); expect(k.weeks).toBeNull(); expect(k.reason).toMatch(/not a readable git checkout/);
  } finally { fs.rmSync(notRepo, { recursive: true, force: true }); }
});

it('includes the note and head sha on successful results', () => {
  const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: repo }, NOW, 2);
  expect(k.note).toMatch(/Report-only/);
  expect(k.head).toMatch(/^[0-9a-f]{40}$/);
});
