import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isoWeekLabel, isoWeekStart, subtractionKpi } from '../services/subtraction-kpi';

let repo: string;
const NOW = Date.parse('2026-10-18T12:00:00Z'); // Sunday of 2026-W42
const commit = (msg: string, iso: string) => execFileSync('git', ['-C', repo, 'commit', '-q', '-am', msg], {
  env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'subtraction-kpi-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  // W40 (before the window of 2 weeks): 3 routes
  write('packages/server/src/routes/a.ts', "router.get('/a', h);\nrouter.post('/b', h);\nrouter.delete('/c', h);\n");
  write('README.md', 'x\n');
  execFileSync('git', ['-C', repo, 'add', '-A']); commit('base', '2026-09-30T10:00:00Z');
  // W41: add a file (2 lines) and one route
  write('src/new.ts', 'one\ntwo\n'); write('packages/server/src/routes/a.ts', "router.get('/a', h);\nrouter.post('/b', h);\nrouter.delete('/c', h);\nrouter.put('/d', h);\n");
  execFileSync('git', ['-C', repo, 'add', '-A']); commit('add', '2026-10-07T10:00:00Z');
  // W42: delete the file and two routes
  fs.rmSync(path.join(repo, 'src/new.ts')); write('packages/server/src/routes/a.ts', "router.get('/a', h);\nrouter.post('/b', h);\n");
  execFileSync('git', ['-C', repo, 'add', '-A']); commit('subtract', '2026-10-14T10:00:00Z');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

it('ISO weeks start on Monday UTC and carry the ISO label', () => {
  expect(new Date(isoWeekStart(NOW)).toISOString()).toBe('2026-10-12T00:00:00.000Z');
  expect(isoWeekLabel(NOW)).toBe('2026-W42');
  expect(isoWeekLabel(Date.parse('2027-01-01T00:00:00Z'))).toBe('2026-W53');
});

it('counts lines, files and route registrations added vs removed per ISO week from git history', () => {
  const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: repo }, NOW, 2);
  expect(k.status).toBe('ok');
  expect(k.weeks?.map((w) => w.week)).toEqual(['2026-W41', '2026-W42']);
  expect(k.weeks?.[0]).toMatchObject({ commits: 1, lines_added: 3, lines_removed: 0, files_added: 1, files_deleted: 0, ratio_removed_added: 0, routes_start: 3, routes_end: 4, routes_delta: 1 });
  expect(k.weeks?.[1]).toMatchObject({ commits: 1, lines_added: 0, lines_removed: 4, files_added: 0, files_deleted: 1, ratio_removed_added: null, routes_start: 4, routes_end: 2, routes_delta: -2 });
});

it('reports null with the reason — never 0 — without a repository', () => {
  expect(subtractionKpi({}, NOW)).toMatchObject({ status: 'unavailable', weeks: null, reason: 'LOOP_DAEMON_REPOSITORY_PATH is not set' });
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'subtraction-norepo-'));
  try {
    const k = subtractionKpi({ LOOP_DAEMON_REPOSITORY_PATH: notRepo }, NOW);
    expect(k.status).toBe('unavailable'); expect(k.weeks).toBeNull(); expect(k.reason).toMatch(/not a readable git checkout/);
  } finally { fs.rmSync(notRepo, { recursive: true, force: true }); }
});
