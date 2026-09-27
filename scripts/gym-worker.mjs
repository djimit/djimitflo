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

function docker(args, input, timeoutMs) {
  return spawnSync('docker', args, { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}
function inRunner(wt, cmd, { input, timeoutMs = 900_000, extra = [] } = {}) {
  return docker(['run', '--rm', '-i', '--network', 'host', '-v', `${wt}:/w`, '-v', 'djimitflo-gym-npm:/root/.npm', '-w', '/w', ...extra, IMAGE, 'sh', '-c', cmd], input, timeoutMs);
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
  const wt = fs.mkdtempSync(path.join(WORK, 'mk-'));
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', wt, job.base_commit]);
    if (inRunner(wt, 'npm ci --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1').status !== 0) return done({ status: 'failed', reason: 'infra: npm ci failed' });
    const [runtime] = job.species.split('@');
    if (runtime !== 'atomic') return done({ status: 'failed', reason: `infra: species ${job.species} not supported by this worker` });
    const state = path.join(WORK, 'atomic-state'); fs.mkdirSync(state, { recursive: true });
    if (inRunner(wt, `atomic-agent config set '${ATOMIC_LOCAL_CONFIG}' >/dev/null`, { extra: ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'], timeoutMs: 60_000 }).status !== 0) return done({ status: 'failed', reason: 'infra: atomic config failed' });
    inRunner(wt, 'atomic-agent run --cwd /w --max-steps 60 --no-approval', { input: `${job.prompt}\n`, extra: ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'], timeoutMs: Number(env.GYM_MAKER_TIMEOUT_MS) || 900_000 });
    git(wt, ['add', '-A', '-N', '.']);
    const patch = git(wt, ['diff', '--binary', 'HEAD', '--', '.', ':(exclude)package-lock.json', ':(exclude).atomic*']);
    await done({ status: 'done', patch, reason: patch ? `patch ${patch.split('\n').length} lines` : 'no change' });
    console.log(`maker ${job.id.slice(0, 8)} ${job.species} ${patch ? 'patch' : 'no change'}`);
  } catch (err) {
    await done({ status: 'failed', reason: `infra: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}` });
  } finally {
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* next run */ } }
    try { git(repo, ['worktree', 'prune']); } catch { /* ignore */ }
  }
}

async function main() {
  const offered = (env.GYM_SPECIES || 'atomic@llama-router').split(',').map((s) => s.trim()).filter(Boolean);
  // real work first: a queued maker job beats a gym replay
  const maker = await api('/gym-worker/maker/claim', { species: offered }).catch(() => ({ job: null }));
  if (maker.job) return runMakerJob(maker.job);
  const claim = await api('/gym-worker/claim', { species: offered });
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
  const wt = fs.mkdtempSync(path.join(WORK, 'wt-'));
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', wt, task.commit]);
    fs.writeFileSync(path.join(wt, task.source), git(wt, ['show', `${task.commit}^:${task.source}`]));
    git(wt, ['-c', 'user.email=gym@djimitflo', '-c', 'user.name=djimitflo-gym', 'commit', '-qam', `gym: restore parent of ${task.source}`]);
    if (inRunner(wt, 'npm ci --legacy-peer-deps --no-audit --no-fund >/dev/null 2>&1').status !== 0) return report({ status: 'discarded', reason: 'infra: npm ci failed' });
    if (oracle(wt, task)) return report({ status: 'discarded', reason: 'tests already green on the parent' });
    const goal = `Evolution gym: make ${task.tests.join(', ')} pass. Change only ${task.source}. The tests describe the intended behaviour; do not edit them.`;
    const [runtime] = species.split('@');
    if (runtime !== 'atomic') return report({ status: 'discarded', reason: `infra: species ${species} not supported by this worker` });
    const state = path.join(WORK, 'atomic-state'); fs.mkdirSync(state, { recursive: true });
    const cfg = inRunner(wt, `atomic-agent config set '${ATOMIC_LOCAL_CONFIG}' >/dev/null`, { extra: ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'], timeoutMs: 60_000 });
    if (cfg.status !== 0) return report({ status: 'discarded', reason: 'infra: atomic config failed' });
    const run = inRunner(wt, 'atomic-agent run --cwd /w --max-steps 40 --no-approval', { input: `${goal}\n`, extra: ['-v', `${state}:/state`, '-e', 'ATOMIC_AGENT_STATE_DIR=/state'], timeoutMs: Number(env.GYM_MAKER_TIMEOUT_MS) || 900_000 });
    const makerOk = run.status === 0 && !run.error;
    const changed = changedFrom(git(wt, ['diff', '--name-only', 'HEAD']), git(wt, ['ls-files', '--others', '--exclude-standard']));
    const green = changed.length > 0 && changed.every((f) => f === task.source) && oracle(wt, task);
    return report(verdict(task, changed, green, makerOk));
  } catch (err) {
    return report({ status: 'discarded', reason: `infra: ${(err instanceof Error ? err.message : String(err)).slice(0, 150)}` });
  } finally {
    // rootless docker: container root writes as this user, so no chown (a chown to our uid inside the container maps to
    // subuid 100999 and locks us out — the first workstation run crashed on exactly that). Cleanup never throws.
    try { git(repo, ['worktree', 'remove', '--force', wt]); } catch { try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* left for the next run */ } }
    try { git(repo, ['worktree', 'prune']); } catch { /* ignore */ }
  }
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
  console.log('selfcheck ok');
}

if (process.argv.includes('--selfcheck')) selfcheck();
else main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
