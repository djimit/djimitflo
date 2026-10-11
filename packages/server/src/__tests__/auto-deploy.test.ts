import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { expect, it } from 'vitest';

// scripts/auto-deploy.sh (plan J2) with every probe simulated: which conditions let main deploy on its own.
const script = path.resolve(__dirname, '../../../../scripts/auto-deploy.sh');
const NEW = 'b'.repeat(40); const OLD = 'a'.repeat(40);
const green = JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }] });
const minutesAgo = (m: number) => JSON.stringify({ commit: { committer: { date: new Date(Date.now() - m * 60_000).toISOString() } } });
const run = (over: Record<string, string> = {}, root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))) => {
  const env = { ...process.env, DEPLOY_ROOT: root, AD_MAIN_SHA: `printf '${NEW}\\trefs/heads/main\\n'`, AD_CURRENT_SHA: `echo ${OLD}`,
    AD_CHECKS: `echo '${green}'`, AD_COMMIT: `echo '${minutesAgo(30)}'`, AD_LEASES: 'echo 0', AD_DEPLOY: 'echo DEPLOYED', ...over };
  const r = spawnSync('bash', [script], { env, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
};

it('deploys main when CI is green, main has settled and no worker runs', () => {
  expect(run()).toContain('DEPLOYED');
});

it('holds for every unsafe condition, and says why', () => {
  expect(run({ AD_CURRENT_SHA: `echo ${NEW}` })).toContain('up to date');
  expect(run({ AD_CHECKS: `echo '${JSON.stringify({ check_runs: [{ status: 'in_progress', conclusion: null }] })}'` })).toContain('CI not green');
  expect(run({ AD_CHECKS: `echo '${JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'failure' }] })}'` })).toContain('CI not green');
  expect(run({ AD_CHECKS: `echo '{"check_runs":[]}'` })).toContain('CI not green');
  // the scheduled OpenWiki `update` job gates no code: running or failing, it must not hold a deploy
  const wiki = (conclusion: string | null, status: string) => JSON.stringify({ check_runs: [{ name: 'build-and-test (22)', status: 'completed', conclusion: 'success' }, { name: 'update', status, conclusion }] });
  expect(run({ AD_CHECKS: `echo '${wiki(null, 'in_progress')}'` })).toContain('DEPLOYED');
  expect(run({ AD_CHECKS: `echo '${wiki('failure', 'completed')}'` })).toContain('DEPLOYED');
  expect(run({ AD_CHECKS: `echo '${JSON.stringify({ check_runs: [{ name: 'update', status: 'completed', conclusion: 'success' }] })}'` })).toContain('CI not green');
  expect(run({ AD_COMMIT: `echo '${minutesAgo(5)}'` })).toContain('settling until 20');
  expect(run({ AD_LEASES: 'echo 2' })).toContain('2 loop worker(s) running');
  for (const out of [run({ AD_CURRENT_SHA: `echo ${NEW}` }), run({ AD_LEASES: 'echo 1' })]) expect(out).not.toContain('DEPLOYED');
});

it('the kill switch file stops everything', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  fs.writeFileSync(path.join(root, 'AUTO_DEPLOY_DISABLED'), '');
  const out = run({}, root);
  expect(out).toContain('disabled by kill switch');
  expect(out).not.toContain('DEPLOYED');
});

// P2: the post-deploy baseline check (15 min after a deploy, once per commit)
const deployedAgo = (root: string, min: number, baseline: string) => {
  fs.writeFileSync(path.join(root, '.last-deploy'), `${OLD} ${Math.floor(Date.now() / 1000) - min * 60}\n`);
  fs.writeFileSync(path.join(root, '.deploy-baseline'), baseline);
};
const upToDate = { AD_CURRENT_SHA: `echo ${NEW}` };

it('P2: a deploy records the stall baseline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  expect(run({ AD_STALLS: `printf 'gym:atomic\\n'` }, root)).toContain('DEPLOYED');
  expect(fs.readFileSync(path.join(root, '.deploy-baseline'), 'utf8')).toBe('gym:atomic\n');
  expect(fs.readFileSync(path.join(root, '.last-deploy'), 'utf8')).toMatch(new RegExp(`^${NEW} \\d+`));
});

it('P2: a new structural stall or a restart pauses auto-deploy; provider noise is only logged; nothing before 15 min', () => {
  const pausedBy = (over: Record<string, string>, baseline = 'gym:atomic\n', min = 20) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-')); deployedAgo(root, min, baseline);
    const out = run({ ...upToDate, AD_RESTARTS: 'echo 0', ...over }, root);
    return { out, paused: fs.existsSync(path.join(root, 'AUTO_DEPLOY_DISABLED')) };
  };
  const panel = pausedBy({ AD_STALLS: `printf 'gym:atomic\\npanel\\n'` });
  expect(panel.paused).toBe(true); expect(panel.out).toContain('auto-deploy paused');
  expect(pausedBy({ AD_STALLS: `printf 'gym:atomic\\n'`, AD_RESTARTS: 'echo 2' }).paused).toBe(true);
  const noise = pausedBy({ AD_STALLS: `printf 'gym:atomic\\njudgment:content_safety\\n'` });
  expect(noise.paused).toBe(false); expect(noise.out).toContain('new stalls since'); expect(noise.out).toContain('post-deploy check ok');
  const early = pausedBy({ AD_STALLS: `printf 'panel\\n'` }, 'gym:atomic\n', 5);
  expect(early.paused).toBe(false); expect(early.out).not.toContain('post-deploy');
});

it('P2: a failed deploy says so and records no baseline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  const out = run({ AD_DEPLOY: 'false', AD_STALLS: 'true' }, root);
  expect(out).toContain('deploy of'); expect(out).toContain('failed');
  expect(fs.existsSync(path.join(root, '.last-deploy'))).toBe(false);
});

it('the real deploy path leaves no RETURN trap behind (bash 5: "tmp: unbound variable" after every deploy)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  // a fake deploy-vps.sh behind a file:// URL; curl fetches it exactly like the real path
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bin-'));
  fs.writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nout=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; echo "echo deployed-fake" > "$out"\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const out = run({ AD_DEPLOY: '', AD_STALLS: 'echo', AD_RESTARTS: 'echo 0', ...env }, root);
  expect(out).toContain('deployed-fake');
  expect(out).not.toContain('unbound');
  expect(out).toContain(`done ${NEW}`);
  expect(fs.existsSync(path.join(root, '.last-deploy'))).toBe(true);
});

it('deploy-vps keeps a week of build cache after a healthy deploy; only a low-disk prune clears it', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/deploy-vps.sh'), 'utf8');
  const fn = script.slice(script.indexOf('prune_old_builds() {'), script.indexOf('\n}\n', script.indexOf('prune_old_builds() {')) + 3);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-'));
  const log = path.join(bin, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${log}\n`, { mode: 0o755 });
  const prune = (arg: string) => {
    fs.rmSync(log, { force: true });
    execFileSync('bash', ['-euo', 'pipefail', '-c', `${fn}\nSHORT=a PREV_SHORT=b; prune_old_builds ${arg}`], { cwd: bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('image prune'));
  };
  expect(prune('')).toEqual(['image prune -f --filter until=168h']);
  expect(prune('all')).toEqual(['image prune -f']);
});

it('S1: writes deploy events as JSON lines into the data dir the container mounts, when it exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  run({}, root); // no data dir: nothing written, nothing breaks
  expect(fs.existsSync(path.join(root, 'data', 'deploy-log.jsonl'))).toBe(false);
  fs.mkdirSync(path.join(root, 'data'));
  run({}, root);
  const events = fs.readFileSync(path.join(root, 'data', 'deploy-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(events.map((e) => e.event)).toEqual(['deploying', 'done']);
  expect(events[0]).toMatchObject({ sha: NEW, detail: `was ${OLD}` });
});
