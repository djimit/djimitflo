import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { expect, it } from 'vitest';

// scripts/merge-train.sh: idempotent merge intents + explicit empty-after-rebase classification (runbook merge-train.md).
const script = path.resolve(__dirname, '../../../../scripts/merge-train.sh');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sh = (cwd: string, cmd: string) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const git = (cwd: string, args: string) => {
  const r = sh(cwd, `git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`);
  if (r.status !== 0) throw new Error(`git ${args}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
const commit = (dir: string, msg: string) => { git(dir, 'add -A'); git(dir, `commit -q -m "${msg}"`); return git(dir, 'rev-parse HEAD'); };
const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `line ${i}${tag}`).join('\n') + '\n';
const runScript = (cwd: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync('bash', [script, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

// The #778 shape: feat = c1 (#776) · c2 (#777) · c3 (#778). main squash-merged #776 identically and #777 with an extra
// CI fix on the same lines, so replaying the original c2 conflicts; #778's own change (c3) is not on main.
function incidentRepo() {
  const dir = tmp('mt-repo-');
  git(dir, 'init -q -b main');
  write(dir, 'a.txt', lines(10)); write(dir, 'b.txt', lines(10)); write(dir, 'c.txt', lines(10));
  const base = commit(dir, 'base');
  git(dir, 'checkout -q -b feat');
  write(dir, 'a.txt', lines(10, ' a776')); const c1 = commit(dir, '776');
  write(dir, 'b.txt', lines(10, ' b777')); const c2 = commit(dir, '777');
  write(dir, 'c.txt', lines(10, ' c778')); const c3 = commit(dir, '778');
  git(dir, 'checkout -q main');
  git(dir, `cherry-pick ${c1}`); // squash of #776: identical change
  write(dir, 'b.txt', lines(10, ' b777 ci-fix')); commit(dir, 'squash #777 (with CI fix)');
  git(dir, 'checkout -q feat');
  return { dir, base, c1, c2, c3 };
}

it('#778 regression: a raw rebase stops with HEAD at main (a push would empty the PR); the helper reconstructs', () => {
  const { dir, c3 } = incidentRepo();
  // what the queued job did: the rebase fails on the original #777 commit and leaves HEAD at main
  const raw = sh(dir, 'git -c user.email=t@t -c user.name=t rebase --onto main feat~3 feat');
  expect(raw.status).not.toBe(0);
  expect(git(dir, 'diff --stat main HEAD')).toBe(''); // the tree a `git push -f HEAD` would have published: empty
  git(dir, 'rebase --abort');

  const ledger = path.join(tmp('mt-led-'), 'ledger.jsonl');
  const r = runScript(dir, ['rebase', 'feat', '1', '778'], { MT_BASE: 'main', MT_LEDGER: ledger, MT_PUSH: 'echo PUSHED' });
  expect(r.status).toBe(0);
  expect(r.out).toContain('RECONSTRUCT');
  expect(r.out).toContain('PUSHED');
  expect(git(dir, 'diff --name-only main feat')).toBe('c.txt'); // exactly #778's own change, on top of main
  expect(git(dir, `diff ${c3}^ ${c3}`)).toBe(git(dir, 'diff main feat'));
  expect(fs.readFileSync(ledger, 'utf8')).toMatch(/"event":"superseded","pr":"778"/);
});

it('with the wrong commit count the ambiguous #777 original fails closed — nothing is pushed', () => {
  const { dir } = incidentRepo();
  const before = git(dir, 'rev-parse feat');
  const r = runScript(dir, ['rebase', 'feat', '3', '778'], { MT_BASE: 'main', MT_LEDGER: path.join(tmp('mt-led-'), 'l'), MT_PUSH: 'echo PUSHED' });
  expect(r.status).toBe(3);
  expect(r.out).toContain('FAIL_CLOSED');
  expect(r.out).not.toContain('PUSHED');
  expect(git(dir, 'rev-parse feat')).toBe(before);
});

it('a change already on main is SATISFIED: no rebuild, no push', () => {
  const { dir, c1 } = incidentRepo();
  git(dir, `checkout -q -B only776 ${c1}`);
  const r = runScript(dir, ['rebase', 'only776', '1'], { MT_BASE: 'main', MT_LEDGER: path.join(tmp('mt-led-'), 'l'), MT_PUSH: 'echo PUSHED' });
  expect(r.status).toBe(0);
  expect(r.out).toContain('SATISFIED');
  expect(r.out).not.toContain('PUSHED');
});

it('an own commit that conflicts with main escalates and restores the branch', () => {
  const { dir, c2 } = incidentRepo();
  git(dir, `checkout -q -B only777 ${c2}`);
  write(dir, 'b.txt', lines(10, ' b777 later')); const own = commit(dir, 'own change on the same lines');
  // make it absent-but-conflicting: main changed those lines differently, forward apply fails → ambiguous → fail closed
  const r = runScript(dir, ['rebase', 'only777', '1'], { MT_BASE: 'main', MT_LEDGER: path.join(tmp('mt-led-'), 'l'), MT_PUSH: 'echo PUSHED' });
  expect([3, 4]).toContain(r.status);
  expect(r.out).toMatch(/FAIL_CLOSED|ESCALATE/);
  expect(r.out).not.toContain('PUSHED');
  expect(git(dir, 'rev-parse only777')).toBe(own);
});

// run: GitHub probes simulated, main is a real temporary repo (presence on main is checked with git, never assumed)
function mainRepo(merged: boolean, withTestFile = true) {
  const dir = tmp('mt-main-');
  git(dir, 'init -q -b main');
  write(dir, 'x.txt', 'old\n'); commit(dir, 'base');
  git(dir, 'checkout -q -b pr');
  write(dir, 'x.txt', 'new\n'); write(dir, 'x.test.ts', 'it("x", () => {});\n'); commit(dir, 'pr change');
  const diff = path.join(dir, '..', `${path.basename(dir)}.diff`); fs.writeFileSync(diff, sh(dir, 'git diff main pr').stdout);
  git(dir, 'checkout -q main');
  if (merged) { write(dir, 'x.txt', 'new\n'); if (withTestFile) write(dir, 'x.test.ts', 'it("x", () => {});\n'); commit(dir, 'squash'); }
  return { dir, diff };
}
const counter = (file: string, first: string, rest: string) => `n=$(cat ${file} 2>/dev/null || echo 0); echo $((n+1)) > ${file}; if [ "$n" = 0 ]; then echo ${first}; else echo ${rest}; fi`;
const train = (over: Record<string, string>, opts: { merged?: boolean; withTestFile?: boolean; ledger?: string; pr?: string } = {}) => {
  const { dir, diff } = mainRepo(opts.merged ?? false, opts.withTestFile ?? true);
  const ledger = opts.ledger ?? path.join(tmp('mt-led-'), 'l');
  const own = tmp('mt-t-'); const merges = path.join(own, 'merges'); const log = path.join(own, 'log'); const state = path.join(own, 'merged');
  // a simulated squash merge really lands the change on main and flips the PR to MERGED (the outcome is read back live)
  const land = `echo x >> ${merges}; touch ${state}; git apply ${diff} && git add -A && git -c user.email=t@t -c user.name=t commit -q -m squash`;
  const env = { MT_LEDGER: ledger, MT_BASE: 'main', MT_FETCH: 'true', MT_PR_VIEW: `if [ -f ${state} ]; then echo MERGED aaaa1111 false; else echo OPEN aaaa1111 false; fi`,
    MT_PR_DIFF: `cat ${diff}`, MT_UPDATE: 'echo updated', MT_CHECKS: 'echo pass', MT_SLEEP: 'true', MT_MERGE: land, ...over };
  const r = runScript(dir, ['run', log, opts.pr ?? '778'], env);
  return { ...r, merges: fs.existsSync(merges) ? fs.readFileSync(merges, 'utf8').split('\n').filter(Boolean).length : 0, ledger, dir };
};

it('merges an open PR once and records CLAIMED → RUNNING → MERGED', () => {
  const r = train({});
  expect(r.status).toBe(0);
  expect(r.out).toContain('#778 MERGED');
  expect(r.merges).toBe(1);
  // lifecycle states; the step entries between them (update_intent, ci_wait, ci_green, merge_intent) are operation state
  const lifecycle = new Set(['claimed', 'running', 'merged', 'satisfied', 'fail_closed', 'escalated', 'superseded', 'hold', 'cancelled']);
  const events = fs.readFileSync(r.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event).filter((e: string) => lifecycle.has(e));
  expect(events).toEqual(['claimed', 'running', 'merged']);
});

it('replay after a merge: SATISFIED only because the change is on main — no second merge', () => {
  const first = train({});
  const replay = train({ MT_PR_VIEW: 'echo MERGED aaaa1111 false' }, { merged: true, ledger: first.ledger });
  expect(replay.out).toContain('SATISFIED');
  expect(replay.merges).toBe(0);
});

it('crash after the merge but before the ledger completion: the replay recovers MERGED from live state, no second merge', () => {
  const ledger = path.join(tmp('mt-led-'), 'l');
  const crashed = train({ MT_MERGE: 'kill -9 $$' }, { ledger });
  expect(crashed.status).not.toBe(0);
  expect(fs.readFileSync(ledger, 'utf8')).not.toContain('"event":"merged"');
  const replay = train({ MT_PR_VIEW: 'echo MERGED aaaa1111 false' }, { merged: true, ledger }); // stale claim of the dead pid is reclaimed
  expect(replay.status).toBe(0);
  expect(replay.out).toContain('MERGED (recovered');
  expect(replay.merges).toBe(0);
});

it('patch-id alone is not proof: a merged PR whose change is not fully on main fails closed', () => {
  const r = train({ MT_PR_VIEW: 'echo MERGED aaaa1111 false' }, { merged: true, withTestFile: false });
  expect(r.status).toBe(3);
  expect(r.out).toContain('FAIL_CLOSED');
  expect(r.merges).toBe(0);
});

it('two workers claiming the same intent: only one acts', async () => {
  const { dir, diff } = mainRepo(false);
  const ledger = path.join(tmp('mt-led-'), 'l'); const own = tmp('mt-2w-'); const merges = path.join(own, 'merges'); const state = path.join(own, 'state');
  // realistic GitHub: after the merge the PR reads MERGED; the first worker holds its claim for ~3 s
  const env = { ...process.env, MT_LEDGER: ledger, MT_BASE: 'main', MT_FETCH: 'true', MT_PR_DIFF: `cat ${diff}`,
    MT_PR_VIEW: `if [ -f ${state} ]; then echo MERGED aaaa1111 false; else echo OPEN aaaa1111 false; fi`,
    MT_UPDATE: 'echo updated', MT_CHECKS: 'echo pass', MT_SLEEP: 'sleep 1', MT_MERGE: `echo x >> ${merges}; git apply ${diff} && git add -A && git -c user.email=t@t -c user.name=t commit -q -m squash; touch ${state}` };
  const { spawn } = await import('child_process');
  const go = () => new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn('bash', [script, 'run', path.join(dir, '..', `log-${Math.random()}`), '778'], { cwd: dir, env });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
  });
  const [a, b] = await Promise.all([go(), go()]);
  expect([a.code, b.code].sort()).toEqual([0, 6]);
  expect(`${a.out}${b.out}`).toContain('CLAIMED by another worker');
  expect(fs.readFileSync(merges, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
}, 30_000);

it('a stale job queued for an older head exits SUPERSEDED without acting', () => {
  const { dir, diff } = mainRepo(false);
  const r = runScript(dir, ['run', path.join(dir, '..', 'log-s'), '778@bbbb2222'], { MT_LEDGER: path.join(tmp('mt-led-'), 'l'), MT_BASE: 'main', MT_FETCH: 'true',
    MT_PR_VIEW: 'echo OPEN aaaa1111 false', MT_PR_DIFF: `cat ${diff}`, MT_MERGE: 'echo MERGE_CALLED' });
  expect(r.status).toBe(5);
  expect(r.out).toContain('SUPERSEDED');
  expect(r.out).not.toContain('MERGE_CALLED');
});

it('PR closed (or reopened with a new head) during execution: abort as SUPERSEDED before the merge call', () => {
  const f = path.join(tmp('mt-c-'), 'n');
  const closed = train({ MT_PR_VIEW: counter(f, 'OPEN aaaa1111 false', 'CLOSED aaaa1111 false') });
  expect(closed.status).toBe(5);
  expect(closed.merges).toBe(0);
  const g = path.join(tmp('mt-c-'), 'n');
  const reopened = train({ MT_PR_VIEW: counter(g, 'OPEN aaaa1111 false', 'OPEN cccc3333 false') });
  expect(reopened.status).toBe(5);
  expect(reopened.merges).toBe(0);
});

it('main moving between the pre-check and the merge: re-verified and redone, merged once', () => {
  const f = path.join(tmp('mt-c-'), 'n');
  const r = train({ MT_MAIN_SHA: counter(f, 'main-1', 'main-2') });
  expect(r.out).toContain('main moved since CI started — redo');
  expect(r.merges).toBe(1);
});

it('an empty PR diff fails closed', () => {
  const r = train({ MT_PR_DIFF: 'true' });
  expect(r.status).toBe(3);
  expect(r.out).toContain('FAIL_CLOSED');
  expect(r.merges).toBe(0);
});

it('a reconstruction that does not reproduce the original change fails closed — nothing pushed', () => {
  const { dir } = incidentRepo();
  const before = git(dir, 'rev-parse feat');
  const r = runScript(dir, ['rebase', 'feat', '1', '778'], { MT_BASE: 'main', MT_LEDGER: path.join(tmp('mt-led-'), 'l'), MT_PUSH: 'echo PUSHED',
    MT_POST_REBUILD: "echo extra > d.txt && git add d.txt && git -c user.email=t@t -c user.name=t commit -q -m drift" });
  expect(r.status).toBe(3);
  expect(r.out).toContain('differs from the original change');
  expect(r.out).not.toContain('PUSHED');
  expect(git(dir, 'rev-parse feat')).toBe(before);
});

it('11-10 #778 regression: the merge lands but branch cleanup fails — MERGED from live state, no update-branch after, next PR runs', () => {
  const dir = tmp('mt-multi-'); const own = tmp('mt-mo-');
  git(dir, 'init -q -b main');
  write(dir, 'x.txt', 'old\n'); write(dir, 'y.txt', 'old\n'); commit(dir, 'base');
  for (const [n, f] of [['778', 'x.txt'], ['779', 'y.txt']]) {
    git(dir, `checkout -q -b pr${n} main`); write(dir, f, `new ${n}\n`); commit(dir, n);
    fs.writeFileSync(path.join(own, `pr${n}.diff`), sh(dir, `git diff main pr${n}`).stdout); git(dir, 'checkout -q main');
  }
  // probe positional args: $4 = the PR number (gh pr <verb> N …)
  const r = runScript(dir, ['run', path.join(own, 'log'), '778', '779'], {
    MT_LEDGER: path.join(own, 'ledger'), MT_BASE: 'main', MT_FETCH: 'true', MT_CHECKS: 'echo pass', MT_SLEEP: 'true',
    MT_PR_DIFF: `cat ${own}/pr$4.diff`,
    MT_PR_VIEW: `if [ -f ${own}/merged$4 ]; then echo MERGED h$4 false; else echo OPEN h$4 false; fi`,
    MT_UPDATE: `echo $4 >> ${own}/updates; echo updated`,
    MT_MERGE: `echo $4 >> ${own}/merges; git apply ${own}/pr$4.diff && git add -A && git -c user.email=t@t -c user.name=t commit -q -m sq$4; touch ${own}/merged$4; echo "failed to delete local branch: used by worktree" >&2; exit 1`,
  });
  expect(r.status).toBe(0);
  expect(r.out).toContain('TRAIN DONE');
  expect(r.out).toContain('logged, not fatal');
  expect(fs.readFileSync(path.join(own, 'merges'), 'utf8').trim().split('\n')).toEqual(['778', '779']);
  expect(fs.readFileSync(path.join(own, 'updates'), 'utf8').trim().split('\n')).toEqual(['778', '779']); // never on a merged PR
});
