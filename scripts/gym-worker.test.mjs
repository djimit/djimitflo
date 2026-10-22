// D9 (docs/design/sandbox-runner.md): the gym worker's runner flags and git safety. Run: node scripts/gym-worker.test.mjs
// Needs git and node; docker is replaced by a fake on PATH that records every call.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GIT_INTENT, GIT_NAMES, GIT_UNTRACKED, GYM_DIFF, MAKER_DIFF, RUNNER_USER, git, runnerArgs, runnerForwarder, runnerGitScript, runnerGitVars, udsProxy, volumeInitArgs, workerGitdir,
} from './gym-worker.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gym-worker.mjs');
const PINNED = 'djimitflo-gym-runner@sha256:b15ba19e35a994d39de0a10e6c6559af7ac355a6b24ff26425b0fa88f2f2b9ca';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const flag = (args, name) => args[args.indexOf(name) + 1];
const rawGit = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commitAll = (cwd, msg) => { rawGit(cwd, ['add', '-A']); rawGit(cwd, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg]); };

test('runner args: no host network, none by default, non-root, caps dropped, read-only, capped, pinned', () => {
  const args = runnerArgs('vol-w', 'true', { name: 'gym-t-1' });
  const joined = args.join(' ');
  assert.ok(!joined.includes('--network host') && !args.includes('host'), 'never the host network');
  assert.equal(flag(args, '--network'), 'none');
  assert.equal(flag(args, '--user'), RUNNER_USER);
  assert.notEqual(RUNNER_USER.split(':')[0], '0');
  assert.equal(flag(args, '--cap-drop'), 'ALL');
  assert.ok(!args.includes('--cap-add') && !args.includes('--privileged'));
  assert.equal(flag(args, '--security-opt'), 'no-new-privileges');
  assert.ok(args.includes('--read-only'));
  const tmpfs = args.flatMap((a, i) => (a === '--tmpfs' ? [args[i + 1].split(':')[0]] : []));
  assert.deepEqual(tmpfs, ['/tmp', flag(args, '-e').replace(/^HOME=/, '')], 'tmpfs for /tmp and HOME');
  for (const f of ['--pids-limit', '--memory', '--cpus']) assert.ok(flag(args, f), `${f} set`);
  assert.equal(flag(args, '--memory-swap'), flag(args, '--memory'), 'no swap beyond the memory cap');
  assert.equal(flag(args, '-v'), 'vol-w:/w', 'the tree is a volume, not a host directory');
  assert.ok(args.includes(PINNED) && args.at(-4) === PINNED);
  assert.equal(flag(runnerArgs('v', 'npm ci', { network: 'bridge' }), '--network'), 'bridge');
});

test('runner args refuse a tag, the host network and privilege-raising or writable host-bind extras', () => {
  assert.throws(() => runnerArgs('v', 'true', { image: 'djimitflo-gym-runner:atomic-0.6.5' }), /not pinned by digest/);
  assert.throws(() => runnerArgs('v', 'true', { network: 'host' }), /not allowed/);
  for (const extra of [['--network', 'host'], ['--network=host'], ['--net=host'], ['--privileged'], ['--cap-add', 'SYS_ADMIN'], ['--user', '0:0'], ['-u', '0'], ['--security-opt', 'seccomp=unconfined'], ['--userns=host'], ['--pid=host']]) {
    assert.throws(() => runnerArgs('v', 'true', { extra }), /not allowed/, extra.join(' '));
  }
  assert.throws(() => runnerArgs('v', 'true', { extra: ['-v', '/home/djimit/wt:/w2'] }), /must be read-only/);
  assert.ok(runnerArgs('v', 'true', { extra: ['-v', '/home/djimit/.djimitflo-gym/repo/.git:/home/djimit/.djimitflo-gym/repo/.git:ro', '-v', 'named:/state'] }));
});

test('volume init is the only root step: CHOWN only, no network, a fixed command', () => {
  const args = volumeInitArgs({ w: 'a-w', state: 'a-state' }, { name: 'init' });
  assert.equal(flag(args, '--user'), '0:0');
  assert.equal(flag(args, '--cap-drop'), 'ALL');
  assert.deepEqual(args.flatMap((a, i) => (a === '--cap-add' ? [args[i + 1]] : [])), ['CHOWN']);
  assert.equal(flag(args, '--network'), 'none');
  assert.ok(args.includes('--read-only') && args.includes('no-new-privileges'));
  assert.deepEqual(args.slice(args.indexOf(PINNED) + 1), ['chown', RUNNER_USER, '/w', '/state', '/npm']);
  assert.throws(() => volumeInitArgs({ w: 'a', state: 'b' }, { image: 'x:latest' }), /not pinned/);
});

/** A worker repo with one linked worktree, as runMakerJob / main create it. */
function workerFixture() {
  const root = tmp('gymw-');
  const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'packages/server/src'), { recursive: true });
  rawGit(repo, ['init', '-q']); fs.writeFileSync(path.join(repo, 'packages/server/src/a.ts'), 'export const a = 1;\n'); commitAll(repo, 'base');
  const wt = path.join(root, 'wt-x'); fs.mkdirSync(wt);
  git(repo, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
  return { root, repo, wt };
}
/** The attack of design F3: replace the agent-writable .git with a repo whose config runs a command (core.fsmonitor). */
function plantMaliciousGit(wt, marker) {
  const evil = path.join(wt, '.git'); fs.rmSync(evil, { force: true });
  rawGit(path.dirname(evil), ['init', '-q']); // .git is now a directory with its own config
  rawGit(wt, ['config', 'core.fsmonitor', `touch ${marker}; false`]);
  fs.mkdirSync(path.join(evil, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(evil, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
}

test('workerGitdir accepts the worker gitfile and refuses a planted .git directory, a symlink or a foreign gitdir', () => {
  const { root, repo, wt } = workerFixture();
  try {
    const gitdir = workerGitdir(repo, wt);
    assert.equal(path.dirname(gitdir), path.join(repo, '.git', 'worktrees'));
    // a gitfile into another repo's worktrees, or one whose back-pointer names a different tree
    const other = workerFixture();
    const saved = fs.readFileSync(path.join(wt, '.git'), 'utf8');
    fs.writeFileSync(path.join(wt, '.git'), fs.readFileSync(path.join(other.wt, '.git'), 'utf8'));
    assert.throws(() => workerGitdir(repo, wt), /outside the worker repo/);
    fs.writeFileSync(path.join(wt, '.git'), saved);
    const twin = path.join(repo, '.git', 'worktrees', 'twin'); fs.cpSync(path.join(repo, '.git', 'worktrees', path.basename(gitdir)), twin, { recursive: true });
    fs.writeFileSync(path.join(twin, 'gitdir'), `${path.join(other.wt, '.git')}\n`);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${twin}\n`);
    assert.throws(() => workerGitdir(repo, wt), /does not point back/);
    fs.writeFileSync(path.join(wt, '.git'), saved);
    fs.rmSync(other.root, { recursive: true, force: true });
    // a symlink to the real gitfile is not the gitfile
    fs.renameSync(path.join(wt, '.git'), path.join(root, 'gitfile')); fs.symlinkSync(path.join(root, 'gitfile'), path.join(wt, '.git'));
    assert.throws(() => workerGitdir(repo, wt), /not the gitfile/);
    fs.rmSync(path.join(wt, '.git'));
    plantMaliciousGit(wt, path.join(root, 'pwned'));
    assert.throws(() => workerGitdir(repo, wt), /not the gitfile/);
    assert.ok(!fs.existsSync(path.join(root, 'pwned')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SAFE_GIT: a repo config fsmonitor or hook does not run (and the fixture is live without it)', () => {
  const { root, wt } = workerFixture();
  const marker = path.join(root, 'pwned');
  try {
    plantMaliciousGit(wt, marker);
    fs.writeFileSync(path.join(wt, 'x.txt'), 'x\n');
    git(wt, ['status', '--porcelain']); git(wt, ['diff', '--name-only']);
    git(wt, ['add', 'x.txt']); git(wt, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x']);
    assert.ok(!fs.existsSync(marker), 'hardened git ran nothing from the repo config or hooks');
    try { rawGit(wt, ['status', '--porcelain']); } catch { /* the hook exits non-zero; it already ran */ }
    assert.ok(fs.existsSync(marker), 'control: plain git (the old host call) runs the planted fsmonitor');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runner git script: diffs against the worker gitdir, ignores a planted .git, runs nothing', () => {
  const { root, repo, wt } = workerFixture();
  const marker = path.join(root, 'pwned');
  try {
    const gitdir = workerGitdir(repo, wt);
    plantMaliciousGit(wt, marker); // what an agent can do in its tree
    // hard case for git's stat cache: same size, same inode, the checkout's mtime — git's racy check (index mtime, kept by cp -p) re-reads it
    const src = path.join(wt, 'packages/server/src/a.ts'); const st = fs.statSync(src);
    fs.writeFileSync(src, 'export const a = 2;\n'); fs.utimesSync(src, st.atime, st.mtime);
    fs.writeFileSync(path.join(wt, 'packages/server/src/new.ts'), 'export const n = 1;\n');
    // the same sh command and env the runner gets, pointed at this fixture instead of /w and /tmp; the gitdir is read-only
    // as in the runner's mount (chmod: this test does not run as root)
    const scratch = path.join(root, 'tmp'); fs.mkdirSync(scratch);
    const vars = runnerGitVars({ gitdir, repoGit: path.join(repo, '.git') }, { tree: wt, tmp: scratch });
    const run = (...steps) => execFileSync('sh', ['-c', runnerGitScript(...steps)], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...vars } });
    const before = fs.readdirSync(path.join(repo, '.git', 'objects')).length;
    execFileSync('chmod', ['-R', 'a-w', path.join(repo, '.git')]);
    try {
      assert.equal(run(GIT_NAMES), 'packages/server/src/a.ts\n');
      assert.equal(run(GIT_UNTRACKED), 'packages/server/src/new.ts\n');
      const diff = run(GIT_INTENT, GYM_DIFF);
      assert.match(diff, /^diff --git a\/packages\/server\/src\/a\.ts/m);
      assert.match(diff, /^\+export const n = 1;$/m);
      assert.match(run(GIT_INTENT, MAKER_DIFF), /^\+export const n = 1;$/m);
      if (process.getuid?.() !== 0) assert.throws(() => execFileSync('sh', ['-c', runnerGitScript(GIT_INTENT)], { cwd: wt, stdio: 'ignore', env: { ...process.env, ...vars, GIT_OBJECT_DIRECTORY: path.join(repo, '.git', 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: '' } }),
        'control: add -N needs a writable object dir, which the read-only mount is not');
    } finally { execFileSync('chmod', ['-R', 'u+w', path.join(repo, '.git')]); }
    assert.ok(!fs.existsSync(marker), 'the planted config never ran');
    assert.equal(fs.readdirSync(path.join(repo, '.git', 'objects')).length, before, 'nothing written to the worker repo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const runNode = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.on('exit', (code) => resolve({ code, out }));
});

test('llama route: runner 127.0.0.1:<port> → unix socket → host router; the maker exit code passes through', async () => {
  const router = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`router saw ${req.url}`); }).listen(0, '127.0.0.1');
  await new Promise((r) => router.once('listening', r));
  const dir = tmp('gymr-'); const sock = path.join(dir, 's.sock');
  const write = process.stdout.write; process.stdout.write = () => true; // udsProxy announces 'ready' on stdout
  const proxy = udsProxy(sock, '127.0.0.1', router.address().port);
  await new Promise((r) => proxy.once('listening', r)); process.stdout.write = write;
  try {
    assert.equal(fs.statSync(sock).mode & 0o777, 0o666, 'the runner uid (a subuid) may connect');
    const port = await freePort();
    const client = `fetch("http://127.0.0.1:${port}/v1/models").then((r) => r.text()).then((t) => { console.log(t); process.exit(3); })`;
    const r = await runNode(['-e', runnerForwarder(port, sock), process.execPath, '-e', client]);
    assert.equal(r.out.trim(), 'router saw /v1/models');
    assert.equal(r.code, 3);
  } finally { proxy.close(); router.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

/**
 * The real worker (main) against a stub API and a fake docker that logs every call: every runner step is hardened, only
 * npm ci has a network (bridge), the host worktree is never mounted, git runs in a runner, attempt volumes are removed.
 */
async function runWorker(claims, dockerScript) {
  const root = tmp('gymm-');
  const origin = path.join(root, 'origin'); fs.mkdirSync(path.join(origin, 'packages/server/src/__tests__'), { recursive: true });
  rawGit(origin, ['init', '-q']); fs.writeFileSync(path.join(origin, 'packages/server/src/a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(origin, 'package.json'), '{"scripts":{}}\n'); commitAll(origin, 'base');
  const base = rawGit(origin, ['rev-parse', 'HEAD']).trim();
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}\n${dockerScript}`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'token'), 't\n');
  const posted = {};
  const api = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => { posted[req.url] = JSON.parse(body || '{}'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(claims(req.url, base))); });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  const log = path.join(root, 'docker.log');
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [WORKER], { stdio: 'ignore', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, FAKE_STATE: path.join(root, 'state'), GYM_WORK_DIR: path.join(root, 'work'), GYM_REPO: origin, GYM_HOST: 'testhost', GYM_WORKER_TOKEN_FILE: path.join(root, 'token'), DJIMITFLO_API: `http://127.0.0.1:${api.address().port}/api`, GYM_LLAMA_URL: 'http://127.0.0.1:9' } });
    p.on('exit', resolve);
  });
  api.close();
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { root, calls, posted, code, wt: path.join(root, 'work') };
}
const FAKE_DOCKER = (onRun) => `const fs = require('fs'); const args = process.argv.slice(2); fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', () => {
  if (args[0] !== 'run') process.exit(0);
  const cmd = args.at(-1); const n = (k) => { const f = process.env.FAKE_STATE + k; const v = fs.existsSync(f) ? +fs.readFileSync(f, 'utf8') : 0; fs.writeFileSync(f, String(v + 1)); return v; };
  ${onRun}
  process.exit(0);
});`;
function assertHardened(calls, workDir) {
  const runs = calls.filter((a) => a[0] === 'run');
  assert.ok(runs.length > 5);
  for (const a of runs) {
    assert.ok(!a.includes('host') && !a.join(' ').includes('--network host'), `no host network: ${a.at(-1)}`);
    assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL'); assert.ok(a.includes('--read-only') && a.includes('no-new-privileges'));
    assert.ok(a.some((x) => x.endsWith('@sha256:b15ba19e35a994d39de0a10e6c6559af7ac355a6b24ff26425b0fa88f2f2b9ca')));
    for (let i = 0; i < a.length; i++) if (a[i] === '-v' && a[i + 1].startsWith('/')) assert.ok(a[i + 1].endsWith(':ro') && !a[i + 1].includes(`${path.sep}wt-`) && !a[i + 1].includes(`${path.sep}mk-`), `host binds are read-only and never the worktree: ${a[i + 1]}`);
  }
  const [init, ...steps] = runs;
  assert.equal(init[init.indexOf('--user') + 1], '0:0'); assert.equal(init.at(-5), 'chown');
  for (const a of steps) {
    assert.equal(a[a.indexOf('--user') + 1], RUNNER_USER, a.at(-1));
    assert.equal(a[a.indexOf('--network') + 1], a.at(-1).startsWith('npm ci') ? 'bridge' : 'none', a.at(-1).slice(0, 60));
  }
  assert.equal(steps.filter((a) => a[a.indexOf('--network') + 1] === 'bridge').length, 1, 'only npm ci has a network');
  const maker = steps.find((a) => a.at(-1).includes('atomic-agent run'));
  assert.ok(maker.some((x) => /llama\.sock:\/run\/llama\.sock:ro$/.test(x)) && maker.at(-1).startsWith('node -e '), 'the maker reaches the router only through the socket route');
  for (const g of steps.filter((a) => a.at(-1).includes('cp -p "$GIT_DIR/index"'))) assert.ok(g.includes('GIT_WORK_TREE=/w') && g.some((x) => x.startsWith('GIT_DIR=') && x.includes(`${path.sep}worktrees${path.sep}`)));
  const created = calls.filter((a) => a[0] === 'volume' && a[1] === 'create').map((a) => a.at(-1));
  const removed = calls.filter((a) => a[0] === 'volume' && a[1] === 'rm').flatMap((a) => a.slice(3));
  assert.equal(created.length, 2); assert.deepEqual(removed.sort(), created.sort(), 'attempt volumes removed');
  assert.deepEqual(fs.readdirSync(workDir).filter((f) => /^(wt|mk|route)-/.test(f)), [], 'host worktree and route dir cleaned up');
}

test('maker job: hardened runners, patch computed in a runner and posted', async () => {
  const r = await runWorker((url, base) => (url.endsWith('/maker/claim') ? { job: { id: 'job-12345678', species: 'atomic@llama-router', base_commit: base, prompt: 'fix it' } } : {}),
    FAKE_DOCKER(`if (cmd.includes("'--binary'")) process.stdout.write('diff --git a/x b/x\\n');`));
  try {
    assert.equal(r.code, 0);
    assert.deepEqual(r.posted['/api/gym-worker/maker/job-12345678/result'], { status: 'done', patch: 'diff --git a/x b/x\n', reason: 'patch 2 lines' });
    assertHardened(r.calls, r.wt);
  } finally { fs.rmSync(r.root, { recursive: true, force: true }); }
});

test('gym attempt: same verdict as before (red → maker → green, source only), every step hardened', async () => {
  const task = { commit: 'mut:1', base: null, mutant: 'export const a = 2;\n', source: 'packages/server/src/a.ts', tests: ['packages/server/src/__tests__/a.test.ts'] };
  const r = await runWorker((url, base) => (url.endsWith('/gym-worker/claim') ? { runId: 'run-1', species: 'atomic@llama-router', task: { ...task, base } } : url.endsWith('/claim') ? { job: null } : {}),
    FAKE_DOCKER(`if (cmd.includes('vitest run')) process.exit(n('vitest') === 0 ? 1 : 0);
  if (cmd.includes("'--name-only'")) process.stdout.write('packages/server/src/a.ts\\n');
  if (cmd.includes("'diff' 'HEAD'")) process.stdout.write('diff --git a/packages/server/src/a.ts b/packages/server/src/a.ts\\n');
  if (cmd.startsWith('cat ')) process.exit(1);`));
  try {
    assert.equal(r.code, 0);
    const res = r.posted['/api/gym-worker/runs/run-1/result'];
    assert.equal(res.status, 'success'); assert.equal(res.reason, 'tests green, source only');
    assert.deepEqual(res.changed_files, ['packages/server/src/a.ts']);
    assert.equal(res.graded_kind, 'binary');
    assertHardened(r.calls, r.wt);
  } finally { fs.rmSync(r.root, { recursive: true, force: true }); }
});
