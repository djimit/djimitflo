import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { classifyMerge, mergeAttribution } from '../services/merge-attribution';
import { buildDigest } from '../services/operator-push';

// re-20261105 E10 / C10: merge scripts write `merged-via: <script> (<actor>) <ts>` into the squash commit; the digest counts
// merges on main per class (auto-merge / agent script / human UI).
const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function repo(now: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-attr-'));
  git(dir, ['init', '-q', '-b', 'main']);
  const commit = (msg: string, hoursAgo: number) => {
    fs.writeFileSync(path.join(dir, 'f.txt'), `${msg}\n`);
    const date = new Date(now - hoursAgo * 3_600_000).toISOString();
    git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git(dir, ['rev-parse', 'HEAD']);
  };
  commit('old loop PR (#1)\n\nmerged-via: merge-train.sh (agent, operator instruction) 2026-11-01T00:00:00Z', 72); // outside 24 h
  commit('feat: a (#10)\n\nbody\n\nmerged-via: merge-train.sh (agent, operator instruction) 2026-11-05T01:00:00Z', 5);
  commit('chore(deps): bump x (#11)\n\nmerged-via: dependabot-merge.sh (workflow, operator policy) 2026-11-05T02:00:00Z', 4);
  const auto = commit('loop: test y (#12)\n\nLoop run r12, maker lease m12.', 3);
  const lane = commit('chore(deps): bump z (#14)', 2.5); // merged by the server's dependency lane
  commit('fix: human (#13)\n\nreviewed in the UI', 2);
  commit('direct push without a PR', 1); // not a PR merge: not counted
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return { dir, auto, lane };
}

it('classifies one merge commit: an agent trailer, a workflow trailer, an auto-merge record, else a human UI merge', () => {
  expect(classifyMerge('merged-via: merge-train.sh (agent, operator instruction) 2026-11-05T01:00:00Z', false)).toBe('agent_script');
  expect(classifyMerge('x\n\nmerged-via: dependabot-merge.sh (workflow, operator policy) 2026-11-05T01:00:00Z', false)).toBe('auto_merge');
  expect(classifyMerge('Loop run r1.', true)).toBe('auto_merge');
  expect(classifyMerge('reviewed', false)).toBe('human_ui');
});

it('counts the PR merges on origin/main of the last 24 h per class; the digest carries the counts', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const { dir, auto, lane } = repo(now);
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  db.prepare(`INSERT INTO loop_runs (id, goal_id, loop_name, mode, status, metadata, created_at, updated_at) VALUES ('r12', NULL, 'test-gap', 'closed', 'completed', ?, ?, ?)`)
    .run(JSON.stringify({ auto_merge: { decision: 'merged', merge_commit_sha: auto } }), new Date(now).toISOString(), new Date(now).toISOString());
  db.exec('CREATE TABLE dependency_lane_prs (pr_number INTEGER PRIMARY KEY, merge_sha TEXT)');
  db.prepare('INSERT INTO dependency_lane_prs VALUES (14, ?)').run(lane);
  const env = { LOOP_DAEMON_REPOSITORY_PATH: dir } as NodeJS.ProcessEnv;
  expect(mergeAttribution(db, env, now)).toEqual({ window_hours: 24, auto_merge: 3, agent_script: 1, human_ui: 1, by_script: { 'merge-train.sh': 1, 'dependabot-merge.sh': 1 },
    note: expect.stringContaining('human_ui') });
  const d = buildDigest(db, now, env);
  expect(d.data.merges_24h).toMatchObject({ auto_merge: 3, agent_script: 1, human_ui: 1 });
  expect(d.text).toContain('Merges on main (24 h): 3 auto-merge, 1 agent script, 1 human UI');
});

it('no checkout configured or unreadable: null (the digest reads unknown), never a calm 0', () => {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  expect(mergeAttribution(db, {} as NodeJS.ProcessEnv, Date.now())).toBeNull();
  expect(mergeAttribution(db, { LOOP_DAEMON_REPOSITORY_PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-')) } as NodeJS.ProcessEnv, Date.now())).toBeNull();
  expect(buildDigest(db, Date.now(), {} as NodeJS.ProcessEnv).text).toContain('Merges on main (24 h): unknown');
});
