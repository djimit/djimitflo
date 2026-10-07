#!/usr/bin/env node
// Plan I1b: evolution-gym worker for a compute host (the workstation). One attempt per run (systemd timer).
// Pulls work from Djimitflo (/api/gym-worker/claim), replays it in docker containers, reports only the score.
// Same rules as the VPS gym (evolution-gym-service.ts): restore the parent source, tests must be red first, success =
// commit tests green and only the source changed; a maker that changed nothing is an infra discard. Nothing is pushed.
//
//   DJIMITFLO_API=http://100.86.47.122:3001/api GYM_HOST=workstation GYM_SPECIES=atomic@llama-router \
//   GYM_WORKER_TOKEN_FILE=~/.djimit/gym-worker.token node scripts/gym-worker.mjs      (--selfcheck for the pure parts)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const WORK = (env.GYM_WORK_DIR || path.join(os.homedir(), '.djimitflo-gym')).replace(/^~/, os.homedir());
const IMAGE = env.GYM_RUNNER_IMAGE || 'djimitflo-gym-runner:atomic-0.6.5';
const RUNNER_DOCKERFILE = `FROM node:22-bookworm-slim
RUN printf 'Acquire::ForceIPv4 "true";\\nAcquire::Retries "5";\\n' > /etc/apt/apt.conf.d/80r && apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl python3 make g++ libatomic1 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/a.tgz https://github.com/AtomicBot-ai/atomic-agent/releases/download/v0.6.5/atomic-agent-linux-x64.tar.gz && \\
    echo "313ac01e1d40f3a6b39780c55af176bab231d2f03dea1d9b7e7bc93188a99f87  /tmp/a.tgz" | sha256sum -c - && \\
    mkdir -p /opt/atomic-agent && tar -xzf /tmp/a.tgz -C /opt/atomic-agent --strip-components=1 && rm /tmp/a.tgz && \\
    ln -s /opt/atomic-agent/atomic-agent /usr/local/bin/atomic-agent && atomic-agent --version
`;
// species → how its maker runs inside the runner container (atomic against the host's llama-router, free compute)
// llama-server providers read localModels.url, not the provider url (without it atomic hit :8080 and got a 404 page)
const ATOMIC_LOCAL_CONFIG = JSON.stringify({ version: 72, localModels: { url: env.GYM_LLAMA_URL || 'http://127.0.0.1:8084', mode: 'external' }, llm: { activeTextProvider: 'local-llama', activeEmbeddingProvider: 'local-llama', toolTransport: 'auto', providers: [{ id: 'local-llama', kind: 'llama-server', url: env.GYM_LLAMA_URL || 'http://127.0.0.1:8084' }] } });

// EV1 (prod 2026-10-03): one shared atomic state dir let the agent's own memory steer it — 11 memories in a row "doc-drift
// run: re-applied the README count fix", so every real maker job (30/38) returned that README patch, and paired genome
// trials shared the parent's remembered fixes. Each attempt now starts from an empty state that is deleted afterwards;
// what an agent may remember is Djimitflo's decision (verified outcomes only), not the agent's.
export const oneLine = (text) => String(text).replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
const freshState = () => fs.mkdtempSync(path.join(WORK, 'state-'));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const git = (cwd, args) => sh('git', ['-C', cwd, ...args]);

/** Files the maker touched, like changedFiles() on the VPS. */
export function changedFrom(diffNames, untracked) {
  return [...diffNames.split('\n'), ...untracked.split('\n')].filter((f) => f && !f.startsWith('.djimitflo/') && f !== 'package-lock.json' && !f.startsWith('.atomic'));
}
/** The verdict, identical to the VPS gym. A maker that ran cleanly and changed nothing gave up: that is a scored failure
 * (prod 2026-09-27: one unsolvable task re-offered as 'infra' benched atomic@llama-router for a day). Only a crash or timeout
 * (makerOk = false) is infra, like the VPS gym's 0-token rule (#454). */
export function verdict(task, changed, green, makerOk = true) {
  if (!changed.length) return makerOk ? { status: 'failure', reason: 'no change (maker gave up)' } : { status: 'discarded', reason: 'infra: maker crashed or timed out without a change' };
  const inScope = changed.every((f) => f === task.source);
  if (!inScope) return { status: 'failure', reason: `out of scope: ${changed.join(', ')}` };
  return green ? { status: 'success', reason: 'tests green, source only' } : { status: 'failure', reason: 'tests still red' };
}

/**
 * RX-11 (server #642): this worker can run canaries — a task whose extra test no source-only change can turn green; a solved
 * canary means the oracle or the sandbox is compromised. The server serves them only to workers that announce it.
 */
export const CAPABILITIES = ['canary', 'write_test'];
export const claimBody = (offered) => ({ species: offered, capabilities: CAPABILITIES });
/** The canary test to write before the oracle runs, or null. Only a test file under packages/ (never outside the worktree). */
export function canaryFile(task) {
  const c = task?.canary;
  if (!c || typeof c.test_path !== 'string' || typeof c.test_content !== 'string') return null;
  if (!/^packages\/[\w./-]+\.test\.ts$/.test(c.test_path) || c.test_path.split('/').includes('..')) return null;
  return { path: c.test_path, content: c.test_content };
}
/**
 * B8 (server #677): a 'write_test' task comes from a real failed test-gap proposal — at <base>, write the test file <source>
 * covering <target>; the oracle is the lane's own one command (vitest on that file). The target must stay unchanged (scope),
 * and a green test that does not import the target, mocks it, has no expect or skips a case covers nothing.
 */
export const isWriteTest = (task) => task?.kind === 'write_test';
export const writeTestValid = (task) => /^[0-9a-f]{7,40}$/.test(String(task.base)) && /^packages\/server\/src\/__tests__\/[\w.-]+\.test\.ts$/.test(String(task.source))
  && /^packages\/server\/src\/services\/[\w-]+\.ts$/.test(String(task.target)) && Array.isArray(task.tests) && task.tests.length === 1 && task.tests[0] === task.source
  && Array.isArray(task.mutants) && task.mutants.length >= 1 && task.mutants.length <= 5
  && task.mutants.every((m) => typeof m?.key === 'string' && /^[\w.:/@-]{1,200}$/.test(m.key) && typeof m.content === 'string');
export function writeTestGap(task, content) {
  const target = task.target.replace(/\.ts$/, '');
  const resolve = (re) => [...String(content).matchAll(re)].map((m) => m[1]).filter((s) => s.startsWith('.'))
    .map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(task.source), s)).replace(/\.[jt]s$/, ''));
  if (!resolve(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g).includes(target)) return `test does not import ${task.target}`;
  if (resolve(/vi\.(?:do)?[mM]ock\(\s*['"]([^'"]+)['"]/g).includes(target)) return `test mocks ${task.target}`;
  if (!/\bexpect\s*\(/.test(content)) return 'test has no expect';
  if (/\b(?:it|test|describe)\.(?:skip|todo)\b/.test(content)) return 'test skips a case';
  return null;
}
/**
 * B8 oracle (server: gym-failure-tasks WRITE_TEST_ORACLE): a green test only counts when it also notices a broken target.
 * Each served mutant is written over <target> in turn and the test run again; red = killed. The target is always restored.
 */
export function killMutants(wt, task, runTest) {
  const file = path.join(wt, task.target); const original = fs.readFileSync(file, 'utf8'); const killed = [];
  try {
    for (const m of task.mutants) { fs.writeFileSync(file, m.content); if (!runTest()) killed.push(m.key); }
  } finally { fs.writeFileSync(file, original); }
  return killed;
}
/** The write_test verdict after the mutant runs: success needs at least one killed mutant. */
export const mutantVerdict = (task, killed) => killed.length
  ? { status: 'success', reason: `tests green, source only, kills ${killed.length}/${task.mutants.length} mutants`, killed_mutants: killed }
  : { status: 'failure', reason: 'test kills no mutant', killed_mutants: [] };
export const DIFF_MAX = 50_000;
/** What the hack classifier needs: the files the maker changed and its diff (capped, the server caps it too). */
export const resultExtras = (changed, diffText) => ({ changed_files: changed.slice(0, 50), diff: String(diffText ?? '').slice(0, DIFF_MAX) });

function docker(args, input, timeoutMs) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}
// Runner containers carry the host label and a name: a timeout kills only the docker CLI, so the container kept running
// and kept calling the model server (prod 2026-09-30: five orphans, the oldest 17 h, slowed both workers into more timeouts).
export const hostLabel = (host = env.GYM_HOST || 'workstation') => `djimitflo-gym-host=${host}`;
let runnerSeq = 0;
export function runnerArgs(wt, cmd, extra = [], name = `gym-${(env.GYM_HOST || 'workstation').replace(/[^A-Za-z0-9_.-]/g, '_')}-${process.pid}-${runnerSeq++}`) {
  return ['run', '--rm', '-i', '--name', name, '--label', hostLabel(), '--network', 'host', '-v', `${wt}:/w`, '-v', 'djimitflo-gym-npm:/root/.npm', '-w', '/w', ...extra, IMAGE, 'sh', '-c', cmd];
}
function inRunner(wt, cmd, { input, timeoutMs = 900_000, extra = [] } = {}) {
  const args = runnerArgs(wt, cmd, extra);
  const result = docker(args, input, timeoutMs);
  if (result.error || result.signal) docker(['rm', '-f', args[args.indexOf('--name') + 1]], undefined, 60_000);
  return result;
}
/** One attempt per host at a time (systemd oneshot): any runner still carrying this host's label at start is an orphan. */
function sweepOrphans() {
  const ids = docker(['ps', '-q', '--filter', `label=${hostLabel()}`], undefined, 30_000).stdout?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (ids.length) { docker(['rm', '-f', ...ids], undefined, 60_000); console.log(`removed ${ids.length} orphaned runner container(s)`); }
}
const oracle = (wt, task) => inRunner(wt, `cd packages/server && npx vitest run ${task.tests.map((t) => t.replace(/^packages\/server\//, '')).map((t) => `'${t}'`).join(' ')}`, { timeoutMs: 300_000 }).status === 0;

async function api(pathName, body) {
  const token = fs.readFileSync((env.GYM_WORKER_TOKEN_FILE || '~/.djimit/gym-worker.token').replace(/^~/, os.homedir()), 'utf8').trim();
  // a network blip used to throw away a finished attempt (prod 2026-09-27 22:51 'fetch failed'): retry network errors only
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${(env.DJIMITFLO_API || 'http://100.86.47.122:3001/api').replace(/\/$/, '')}${pathName}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gym-Host': env.GYM_HOST || 'workstation', 'X-Gym-Worker-Token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, [5_000, 15_000, 45_000][attempt]));
    }
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathName} ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

/** Plan I3b: a real maker job (queued by the VPS runtime 'remote'); only the patch goes back. */
async function runMakerJob(job) {
  const done = (r) => api(`/gym-worker/maker/${job.id}/result`, r);
  fs.mkdirSync(WORK, { recursive: true });
  const repo = path.join(WORK, 'repo');
  if (!fs.existsSync(repo)) sh('git', ['clone', '-q', env.GYM_REPO || 'https://github.com/djimit/djimitflo.git', repo]);
  git(repo, ['fetch', '-q', 'origin']);
  const wt = fs.mkdtempSync(path.join(WORK, 'mk-')); const states = [];
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', wt, job.base_commit]);
    if (inRunner(wt, 'npm ci --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1').status !== 0) return done({ status: 'failed', reason: 'infra: npm ci failed' });
    const [runtime] = job.species.split('@');
    if (runtime !== 'atomic') return done({ status: 'failed', reason: `infra: species ${job.species} not supported by this worker` });
    const state = freshState(); states.push(state);
    if (inRunner(wt, `atomic-agent config set '${ATOMIC_LOCAL_CONFIG}' >/dev/null`, { extra: ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'], timeoutMs: 60_000 }).status !== 0) return done({ status: 'failed', reason: 'infra: atomic config failed' });
    // atomic-agent run reads one message per stdin line: a multi-line assignment became "# Objective Assignment" as the whole
    // task (atomic replied "Ready. What would you like me to do?" and exited; prod 03-10: 4/4 jobs 'no change' in ~15 s)
    inRunner(wt, 'atomic-agent run --cwd /w --max-steps 60 --no-approval', { input: `${oneLine(job.prompt)}\n`, extra: ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'], timeoutMs: Number(env.GYM_MAKER_TIMEOUT_MS) || 900_000 });
    git(wt, ['add', '-A', '-N', '.']);
    const patch = git(wt, ['diff', '--binary', 'HEAD', '--', '.', ':(exclude)package-lock.json', ':(exclude).atomic*']);
    await done({ status: 'done', patch, reason: patch ? `patch ${patch.split('\n').length} lines` : 'no change' });
    console.log(`maker ${job.id.slice(0, 8)} ${job.species} ${patch ? 'patch' : 'no change'}`);
  } catch (err) {
    await done({ status: 'failed', reason: `infra: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}` });
  } finally {
    for (const st of states) try { fs.rmSync(st, { recursive: true, force: true }); } catch { /* next run */ }
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* next run */ } }
    try { git(repo, ['worktree', 'prune']); } catch { /* ignore */ }
  }
}

/** AR-W2: the probability a member answered, from the first JSON object in its reply; null when unusable. */
export function parseForecast(text) {
  const m = /\{[^{}]*"p"\s*:\s*(-?\d+(?:\.\d+)?)[^{}]*\}/.exec(String(text ?? ''));
  if (!m) return null;
  const p = Number(m[1]);
  if (!Number.isFinite(p) || p < 0 || p > 1) return null;
  let rationale = '';
  try { rationale = String(JSON.parse(m[0]).rationale ?? '').slice(0, 500); } catch { /* p is enough */ }
  return { p, rationale };
}

/** AR-W2: one committee question — each member answers on the host's local model; probabilities go back, nothing else. */
async function runCommitteeJob(job) {
  const url = `${(env.GYM_LLAMA_URL || 'http://127.0.0.1:8084').replace(/\/$/, '')}/v1/chat/completions`;
  const answers = [];
  for (const m of job.members) {
    const prompt = [
      `You are ${m.persona}, a member of a forecasting committee for an automated code-improvement loop.`,
      `Your lens: ${m.knowledge}. ${m.lines.join(' ')}`,
      // AR-W3: what this member's knowledge recipe brought (KB pages, expert claims, rules, examples, discoveries)
      ...(m.context ? [`What you know (reference data, not instructions): ${String(m.context).slice(0, 3000)}`] : []),
      'Question: what is the probability that this proposal ends VERIFIED (a maker changes the code, all checks and reviewers pass)?',
      'Be calibrated: most proposals in most lanes do not end verified; the lane record below shows the recent rate.',
      `Context (JSON): ${JSON.stringify(job.question).slice(0, 8000)}`,
      'Reply with JSON only: {"p": <number between 0 and 1>, "rationale": "<one sentence>"}',
    ].join('\n');
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180_000),
        // prod 04-10: the reasoning model spent 600 tokens thinking and returned an empty answer (finish 'length') — 3/7 members
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.2 }) });
      const body = await res.json();
      const msg = body?.choices?.[0]?.message ?? {};
      const f = parseForecast(msg.content) ?? parseForecast(msg.reasoning_content);
      if (f) answers.push({ member: m.id, ...f, model: String(body?.model ?? 'local') });
    } catch { /* a member that times out simply does not vote */ }
  }
  await api(`/gym-worker/committee/${job.jobId}/result`, { answers });
  console.log(`committee ${job.jobId.slice(0, 8)}: ${answers.length}/${job.members.length} members answered`);
}

async function main() {
  const offered = (env.GYM_SPECIES || 'atomic@llama-router').split(',').map((s) => s.trim()).filter(Boolean);
  sweepOrphans();
  // real work first: a queued maker job beats a gym replay
  const maker = await api('/gym-worker/maker/claim', { species: offered }).catch(() => ({ job: null }));
  if (maker.job) return runMakerJob(maker.job);
  // AR-W2: then a committee question (short local-model calls), then a gym replay
  const committee = await api('/gym-worker/committee/claim', {}).catch(() => ({ job: null }));
  if (committee?.job) return runCommitteeJob(committee.job);
  const claim = await api('/gym-worker/claim', claimBody(offered));
  if (claim.skipped) { console.log(`skipped: ${claim.skipped}`); return; }
  const { runId, species, task } = claim;
  const started = Date.now();
  const report = async (r) => { await api(`/gym-worker/runs/${runId}/result`, { ...r, tokens: 0, durationMs: Date.now() - started }); console.log(`${species} ${task.commit.slice(0, 8)} ${r.status}: ${r.reason}`); };
  fs.mkdirSync(WORK, { recursive: true });
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status !== 0) {
    const b = docker(['build', '--network', 'host', '-t', IMAGE, '-'], RUNNER_DOCKERFILE, 1_800_000);
    if (b.status !== 0) return report({ status: 'discarded', reason: `infra: runner image build failed ${(b.stderr || '').slice(-120)}` });
  }
  const repo = path.join(WORK, 'repo');
  if (!fs.existsSync(repo)) sh('git', ['clone', '-q', env.GYM_REPO || 'https://github.com/djimit/djimitflo.git', repo]);
  git(repo, ['fetch', '-q', 'origin']);
  const wt = fs.mkdtempSync(path.join(WORK, 'wt-')); const states = [];
  const writeTest = isWriteTest(task);
  try {
    if (writeTest && !writeTestValid(task)) return report({ status: 'discarded', reason: 'task: malformed write_test task' });
    // Y4: a mutant-repair task starts from its base commit with the server's mutated file; a mined task from the fix
    // commit with the parent version of the source restored; a write_test task from its base as is (the test is the change)
    git(repo, ['worktree', 'add', '-q', '--detach', wt, task.mutant || writeTest ? task.base : task.commit]);
    if (!writeTest) {
      fs.writeFileSync(path.join(wt, task.source), task.mutant ?? git(wt, ['show', `${task.commit}^:${task.source}`]));
      // RX-11: the canary test belongs to the oracle — committed with the task, so it is never the maker's change (and a
      // maker that edits it shows up as out of scope)
      const canary = canaryFile(task);
      if (canary) { fs.mkdirSync(path.dirname(path.join(wt, canary.path)), { recursive: true }); fs.writeFileSync(path.join(wt, canary.path), canary.content); git(wt, ['add', '--', canary.path]); }
      git(wt, ['-c', 'user.email=gym@djimitflo', '-c', 'user.name=djimitflo-gym', 'commit', '-qam', task.mutant ? `gym: mutate ${task.source}` : `gym: restore parent of ${task.source}`]);
    }
    const ci = inRunner(wt, 'npm ci --legacy-peer-deps --no-audit --no-fund > /tmp/ci.log 2>&1; rc=$?; tail -40 /tmp/ci.log; exit $rc');
    if (ci.status !== 0) return report(npmCiFailure(ci.stdout));
    if (oracle(wt, task)) return report({ status: 'discarded', reason: writeTest ? 'task: test already green at base (gap closed)' : task.mutant ? 'task: mutant survives (tests stay green)' : 'tests already green on the parent' });
    // Y3: a trial genome adds its strategy lines to the task (the only thing a genome may change)
    const strategy = Array.isArray(claim.genome?.lines) && claim.genome.lines.length ? `\n\nStrategy:\n${claim.genome.lines.map((l) => `- ${String(l).slice(0, 300)}`).join('\n')}` : '';
    const goal = oneLine(writeTest
      ? `Evolution gym: write the vitest test file ${task.source} that covers ${task.target}. Import ${task.target} with a relative import, do not mock it, assert its real behaviour with expect precisely enough that a subtly broken ${task.target} makes the test fail, skip nothing, and make it pass with: cd packages/server && npx vitest run ${task.source.replace(/^packages\/server\//, '')}. Change only ${task.source}; do not edit ${task.target} or any other file.${strategy}`
      : `Evolution gym: make ${task.tests.join(', ')} pass. Change only ${task.source}. The tests describe the intended behaviour; do not edit them.${strategy}`);
    const [runtime] = species.split('@');
    if (runtime !== 'atomic') return report({ status: 'discarded', reason: `infra: species ${species} not supported by this worker` });
    const state = freshState(); states.push(state);
    const cfg = inRunner(wt, `atomic-agent config set '${ATOMIC_LOCAL_CONFIG}' >/dev/null`, { extra: ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'], timeoutMs: 60_000 });
    if (cfg.status !== 0) return report({ status: 'discarded', reason: 'infra: atomic config failed' });
    const run = inRunner(wt, 'atomic-agent run --cwd /w --max-steps 40 --no-approval', { input: `${goal}\n`, extra: ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'], timeoutMs: Number(env.GYM_MAKER_TIMEOUT_MS) || 900_000 });
    const makerOk = run.status === 0 && !run.error;
    const changed = changedFrom(git(wt, ['diff', '--name-only', 'HEAD']), git(wt, ['ls-files', '--others', '--exclude-standard']));
    const scoped = changed.length > 0 && changed.every((f) => f === task.source);
    const gap = writeTest && scoped ? writeTestGap(task, fs.readFileSync(path.join(wt, task.source), 'utf8')) : null;
    const green = scoped && !gap && oracle(wt, task);
    let diffText = '';
    try { git(wt, ['add', '-A', '-N', '.']); diffText = git(wt, ['diff', 'HEAD', '--', '.', ':(exclude)package-lock.json', ':(exclude).atomic*', ':(exclude).djimitflo']); } catch { /* the verdict does not need it */ }
    let result = gap ? { status: 'failure', reason: gap } : verdict(task, changed, green, makerOk);
    // B8: green on the real target is not enough — the test must also go red on at least one seeded mutant of it
    if (writeTest && result.status === 'success') result = mutantVerdict(task, killMutants(wt, task, () => oracle(wt, task)));
    return report({ ...result, ...resultExtras(changed, diffText) });
  } catch (err) {
    return report({ status: 'discarded', reason: `infra: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}` });
  } finally {
    for (const st of states) try { fs.rmSync(st, { recursive: true, force: true }); } catch { /* next run */ }
    // rootless docker: container root writes as this user, so no chown (a chown to our uid inside the container maps to
    // subuid 100999 and locks us out — the first workstation run crashed on exactly that). Cleanup never throws.
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* left for the next run */ } }
    try { git(repo, ['worktree', 'prune']); } catch { /* ignore */ }
  }
}

/**
 * A lock file out of sync with package.json at the task's commit can never install: that is a defect of the mined task, not
 * of the host or the species (prod 2026-09-30: commits from 21-08 failed `npm ci` with EUSAGE every time and tripped the
 * breaker for atomic@llama-router). A non-infra discard earns no outcome, marks the task tried and does not count as a trip.
 */
export function npmCiFailure(out = '') {
  return /EUSAGE|in sync|does not satisfy|Missing: .* from lock file/.test(out)
    ? { status: 'discarded', reason: 'task: lock file out of sync at this commit (npm ci EUSAGE)' }
    : { status: 'discarded', reason: 'infra: npm ci failed' };
}

/** A committed canary test is not the maker's change; a maker that edits it is out of scope (real git, no docker). */
function canaryScopeCheck() {
  const assert = (c, m) => { if (!c) throw new Error(`selfcheck: ${m}`); };
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-canary-'));
  try {
    const task = { source: 'packages/server/src/services/a.ts', canary: { test_path: 'packages/server/src/__tests__/gym-canary.test.ts', test_content: "it('x', () => {});\n" } };
    git(wt, ['init', '-q']); fs.mkdirSync(path.join(wt, 'packages/server/src/services'), { recursive: true });
    fs.writeFileSync(path.join(wt, task.source), 'export const a = 1;\n');
    git(wt, ['add', '-A']); git(wt, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    const canary = canaryFile(task);
    fs.mkdirSync(path.dirname(path.join(wt, canary.path)), { recursive: true }); fs.writeFileSync(path.join(wt, canary.path), canary.content); git(wt, ['add', '--', canary.path]);
    git(wt, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'gym: mutate']);
    assert(fs.readFileSync(path.join(wt, canary.path), 'utf8') === canary.content, 'canary file written at its path');
    fs.writeFileSync(path.join(wt, task.source), 'export const a = 2;\n');
    const changed = changedFrom(git(wt, ['diff', '--name-only', 'HEAD']), git(wt, ['ls-files', '--others', '--exclude-standard']));
    assert(JSON.stringify(changed) === JSON.stringify([task.source]), 'canary test is not counted as maker scope');
    fs.writeFileSync(path.join(wt, canary.path), "it('x', () => { /* cheated */ });\n");
    const cheated = changedFrom(git(wt, ['diff', '--name-only', 'HEAD']), git(wt, ['ls-files', '--others', '--exclude-standard']));
    assert(verdict(task, cheated, true).reason.startsWith('out of scope'), 'a maker that edits the canary test is out of scope');
  } finally { fs.rmSync(wt, { recursive: true, force: true }); }
}

/** A write_test maker's new (untracked) test file is its change; editing the target too is out of scope (real git, no docker). */
function writeTestScopeCheck() {
  const assert = (c, m) => { if (!c) throw new Error(`selfcheck: ${m}`); };
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-write-test-'));
  try {
    const task = { kind: 'write_test', source: 'packages/server/src/__tests__/widget.test.ts', target: 'packages/server/src/services/widget.ts' };
    git(wt, ['init', '-q']); fs.mkdirSync(path.join(wt, 'packages/server/src/services'), { recursive: true }); fs.mkdirSync(path.join(wt, 'packages/server/src/__tests__'));
    fs.writeFileSync(path.join(wt, task.target), 'export const widget = () => 1;\n');
    git(wt, ['add', '-A']); git(wt, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base']);
    fs.writeFileSync(path.join(wt, task.source), "import { widget } from '../services/widget';\n");
    const changed = changedFrom(git(wt, ['diff', '--name-only', 'HEAD']), git(wt, ['ls-files', '--others', '--exclude-standard']));
    assert(JSON.stringify(changed) === JSON.stringify([task.source]), 'write_test: the new test file is the maker change');
    fs.writeFileSync(path.join(wt, task.target), 'export const widget = () => 2;\n');
    const cheated = changedFrom(git(wt, ['diff', '--name-only', 'HEAD']), git(wt, ['ls-files', '--others', '--exclude-standard']));
    assert(verdict(task, cheated, true).reason.startsWith('out of scope'), 'write_test: a maker that edits the target is out of scope');
  } finally { fs.rmSync(wt, { recursive: true, force: true }); }
}

/** B8 oracle: kills are counted per mutant with a stubbed runner, and the target is restored even when the runner throws. */
function killMutantsCheck() {
  const assert = (c, m) => { if (!c) throw new Error(`selfcheck: ${m}`); };
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-kill-'));
  try {
    const original = 'export const widget = () => 1;\n';
    const task = { target: 'packages/server/src/services/widget.ts', mutants: [{ key: 'm1', content: 'export const widget = () => 2;\n' }, { key: 'm2', content: 'export const widget = () => 1 ;\n' }, { key: 'm3', content: 'export const widget = () => 0;\n' }] };
    const file = path.join(wt, task.target); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, original);
    const seen = [];
    // the stub test is green exactly when widget returns 1 or the equivalent mutant m2 is in place
    const runTest = () => { const c = fs.readFileSync(file, 'utf8'); seen.push(c); return c.includes('=> 1'); };
    const killed = killMutants(wt, task, runTest);
    assert(JSON.stringify(killed) === '["m1","m3"]', 'killMutants: red runs are the killed mutants');
    assert(JSON.stringify(seen) === JSON.stringify(task.mutants.map((m) => m.content)), 'killMutants: each mutant is written over the target before its run');
    assert(fs.readFileSync(file, 'utf8') === original, 'killMutants: target restored');
    const v = mutantVerdict(task, killed);
    assert(v.status === 'success' && v.reason.endsWith('kills 2/3 mutants') && JSON.stringify(v.killed_mutants) === '["m1","m3"]', 'mutantVerdict: a kill is success and reports the killed keys');
    assert(JSON.stringify(killMutants(wt, task, () => true)) === '[]' && mutantVerdict(task, []).status === 'failure' && mutantVerdict(task, []).reason === 'test kills no mutant', 'a test that survives every mutant is a failure');
    let threw = false;
    try { killMutants(wt, task, () => { throw new Error('docker gone'); }); } catch { threw = true; }
    assert(threw && fs.readFileSync(file, 'utf8') === original, 'killMutants: target restored when the runner throws');
  } finally { fs.rmSync(wt, { recursive: true, force: true }); }
}

function selfcheck() {
  const task = { source: 'packages/server/src/a.ts' };
  const assert = (c, m) => { if (!c) throw new Error(`selfcheck: ${m}`); };
  assert(JSON.stringify(changedFrom('packages/server/src/a.ts\npackage-lock.json\n', '.djimitflo/x\n')) === '["packages/server/src/a.ts"]', 'changedFrom');
  assert(verdict(task, [], false).status === 'failure', 'clean run, no change = scored failure');
  assert(verdict(task, [], false, false).status === 'discarded', 'crash/timeout without change = infra discard');
  assert(verdict(task, ['packages/server/src/a.ts', 'packages/server/src/__tests__/a.test.ts'], true).status === 'failure', 'out of scope');
  assert(verdict(task, ['packages/server/src/a.ts'], true).status === 'success', 'success');
  assert(verdict(task, ['packages/server/src/a.ts'], false).reason === 'tests still red', 'red');
  assert(npmCiFailure("npm error code EUSAGE\nnpm error Invalid: lock file's ws@8.21.0 does not satisfy ws@8.22.0").reason.startsWith('task:'), 'lock drift = task defect');
  assert(npmCiFailure('npm error network ETIMEDOUT').reason.startsWith('infra:'), 'network = infra');
  const args = runnerArgs('/tmp/w', 'true', [], 'gym-x-1-0');
  assert(args.includes('--name') && args[args.indexOf('--name') + 1] === 'gym-x-1-0', 'runner is named (timeout can remove it)');
  assert(args[args.indexOf('--label') + 1] === hostLabel(), 'runner carries the host label (orphan sweep)');
  assert(hostLabel('workstation-2060') === 'djimitflo-gym-host=workstation-2060', 'label per host: workers never sweep each other');
  assert(oneLine('# Objective Assignment\n\nFile: a.ts\n  Change only this file.') === '# Objective Assignment File: a.ts Change only this file.', 'oneLine collapses an assignment');
  assert(!oneLine('a\nb\n\nc').includes('\n'), 'oneLine has no newline');
  assert(parseForecast('thinking... {"p": 0.35, "rationale": "lane rate is low"} done')?.p === 0.35, 'parseForecast reads p');
  assert(parseForecast('{"p": 1.7}') === null && parseForecast('no json') === null, 'parseForecast rejects bad output');
  assert(JSON.stringify(claimBody(['atomic@llama-router'])) === '{"species":["atomic@llama-router"],"capabilities":["canary","write_test"]}', 'claim announces the canary and write_test capabilities');
  const wTask = { commit: 'fail:r1', kind: 'write_test', base: 'a'.repeat(40), source: 'packages/server/src/__tests__/widget.test.ts', tests: ['packages/server/src/__tests__/widget.test.ts'], target: 'packages/server/src/services/widget.ts',
    mutants: [{ key: 'mut:aaaaaaaaaaaa:packages/server/src/services/widget.ts:1:1', content: 'export const widget = () => 2;\n' }] };
  assert(isWriteTest(wTask) && !isWriteTest(task) && writeTestValid(wTask), 'write_test task recognised and valid');
  assert(!writeTestValid({ ...wTask, base: 'HEAD;rm' }) && !writeTestValid({ ...wTask, source: '../x.test.ts', tests: ['../x.test.ts'] }) && !writeTestValid({ ...wTask, tests: [] }), 'malformed write_test task rejected');
  assert(!writeTestValid({ ...wTask, mutants: [] }) && !writeTestValid({ ...wTask, mutants: undefined }) && !writeTestValid({ ...wTask, mutants: [{ key: 'a b;rm', content: 'x' }] }), 'a write_test task without valid mutants is rejected');
  const good = "import { expect, it } from 'vitest';\nimport { widget } from '../services/widget';\nit('w', () => { expect(widget()).toBe(1); });\n";
  assert(writeTestGap(wTask, good) === null && writeTestGap(wTask, good.replace("'../services/widget'", "'../services/widget.js'")) === null, 'a real test of the target passes the gap check');
  assert(writeTestGap(wTask, "import { expect, it } from 'vitest';\nit('w', () => { expect(1).toBe(1); });\n")?.startsWith('test does not import'), 'a test without the target import covers nothing');
  assert(writeTestGap(wTask, `${good}vi.mock('../services/widget');\n`)?.startsWith('test mocks'), 'a test that mocks the target covers nothing');
  assert(writeTestGap(wTask, "import { widget } from '../services/widget';\nit('w', () => { widget(); });\n") === 'test has no expect' && writeTestGap(wTask, good.replace("it('w'", "it.skip('w'")) === 'test skips a case', 'no expect / skipped case covers nothing');
  assert(verdict(wTask, [wTask.source], true).status === 'success' && verdict(wTask, [wTask.source, wTask.target], true).reason.startsWith('out of scope'), 'write_test: only the test file may change, never the target');
  const cTask = { source: 'packages/server/src/services/a.ts', canary: { test_path: 'packages/server/src/__tests__/gym-canary.test.ts', test_content: 'x' } };
  assert(canaryFile(cTask)?.path === 'packages/server/src/__tests__/gym-canary.test.ts', 'canary test path accepted');
  assert(canaryFile({ canary: { test_path: '../etc/x.test.ts', test_content: 'x' } }) === null && canaryFile({ canary: { test_path: 'packages/../../x.test.ts', test_content: 'x' } }) === null, 'canary path cannot leave the worktree');
  assert(canaryFile({ canary: { test_path: 'packages/server/src/a.ts', test_content: 'x' } }) === null && canaryFile({ source: 'a' }) === null, 'only a test file; no canary = null');
  const extras = resultExtras(['packages/server/src/a.ts'], 'd'.repeat(DIFF_MAX + 10));
  assert(extras.diff.length === DIFF_MAX && JSON.stringify(extras.changed_files) === '["packages/server/src/a.ts"]', 'result carries changed_files and a diff capped at 50 KB');
  assert(resultExtras([], undefined).diff === '', 'no diff = empty string');
  canaryScopeCheck();
  writeTestScopeCheck();
  killMutantsCheck();
  console.log('selfcheck ok');
}

if (process.argv.includes('--selfcheck')) selfcheck();
else main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
