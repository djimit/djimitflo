import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { expect, it } from 'vitest';

// scripts/auto-deploy.sh (plan J2) with every probe simulated: which conditions let main deploy on its own.
const script = path.resolve(__dirname, '../../../../scripts/auto-deploy.sh');
const NEW = 'b'.repeat(40); const OLD = 'a'.repeat(40);
const green = JSON.stringify({ check_runs: [{ id: 1, name: 'build-and-test (22)', status: 'completed', conclusion: 'success' }, { id: 2, name: 'optional', status: 'completed', conclusion: 'skipped' }] });
const minutesAgo = (m: number) => JSON.stringify({ commit: { committer: { date: new Date(Date.now() - m * 60_000).toISOString() } } });
const run = (over: Record<string, string> = {}, root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))) => {
  const env = { ...process.env, DEPLOY_ROOT: root, AD_MAIN_SHA: `printf '${NEW}\\trefs/heads/main\\n'`, AD_CURRENT_SHA: `echo ${OLD}`,
    AD_CHECKS: `echo '${green}'`, AD_REQUIRED: `echo 'build-and-test (22)'`, AD_COMMIT: `echo '${minutesAgo(30)}'`, AD_LEASES: 'echo 0', AD_DEPLOY: 'echo DEPLOYED', AD_DEPLOY_GATE: 'true', ...over };
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

it('skip is not pass: every required context needs a success of its newest run on the commit (forensic 2026-10-26 rank 9)', () => {
  const checks = (runs: object[]) => ({ AD_CHECKS: `echo '${JSON.stringify({ check_runs: runs })}'` });
  const run_ = (id: number, name: string, conclusion: string | null, status = 'completed') => ({ id, name, status, conclusion });
  const req = { AD_REQUIRED: `printf 'build-and-test (22)\\nsbom\\n'` };
  const both = [run_(1, 'build-and-test (22)', 'success'), run_(2, 'sbom', 'success')];
  expect(run({ ...req, ...checks(both) })).toContain('DEPLOYED');
  // a required check that was skipped (or neutral) never ran: no deploy
  for (const c of ['skipped', 'neutral']) {
    const out = run({ ...req, ...checks([run_(1, 'build-and-test (22)', 'success'), run_(2, 'sbom', c)]) });
    expect(out).toContain(`required_not_success:sbom=${c}`); expect(out).not.toContain('DEPLOYED');
  }
  // a required check that has not reported yet, while everything else is green: no deploy
  const missing = run({ ...req, ...checks([run_(1, 'build-and-test (22)', 'success'), run_(3, 'gitleaks', 'success')]) });
  expect(missing).toContain('required_missing:sbom'); expect(missing).not.toContain('DEPLOYED');
  // a non-required check may still be skipped (e.g. a job gated on the event)
  expect(run({ ...req, ...checks([...both, run_(4, 'optional', 'skipped')]) })).toContain('DEPLOYED');
  // the newest run per name decides: a red rerun beats an older green, a green rerun replaces an older red
  expect(run({ ...req, ...checks([...both, run_(9, 'sbom', 'failure')]) })).not.toContain('DEPLOYED');
  expect(run({ ...req, ...checks([run_(1, 'build-and-test (22)', 'success'), run_(2, 'sbom', 'failure'), run_(9, 'sbom', 'success')]) })).toContain('DEPLOYED');
  // required contexts unreadable: never a remembered list, never a deploy
  const unreadable = run({ AD_REQUIRED: 'true', ...checks(both) });
  expect(unreadable).toContain('required checks unavailable'); expect(unreadable).not.toContain('DEPLOYED');
});

it('reads the required contexts from the public branch summary of main', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bin-'));
  const summary = JSON.stringify({ protection: { required_status_checks: { contexts: ['build-and-test (22)'], checks: [{ context: 'sbom', app_id: 15368 }] } } });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\ncase "$*" in *branches/main*) echo '${summary}' ;; *) exit 22 ;; esac\n`, { mode: 0o755 });
  const runs = JSON.stringify({ check_runs: [{ id: 1, name: 'build-and-test (22)', status: 'completed', conclusion: 'success', app: { id: 15368 } }, { id: 2, name: 'sbom', status: 'completed', conclusion: 'skipped', app: { id: 15368 } }] });
  const out = run({ AD_REQUIRED: '', AD_CHECKS: `echo '${runs}'`, PATH: `${bin}:${process.env.PATH}` });
  expect(out).toContain('required_not_success:sbom=skipped'); expect(out).not.toContain('DEPLOYED');
});

// Codex review of #1061: the required producer (app_id) is part of the check identity — Actions `sbom` skipped and another
// app's `sbom` success must not deploy.
it('a skipped required Actions check is not replaced by a same-named success from another app', () => {
  const r = (id: number, name: string, conclusion: string, app: number) => ({ id, name, status: 'completed', conclusion, app: { id: app } });
  const checks = (runs: object[]) => ({ AD_CHECKS: `echo '${JSON.stringify({ check_runs: runs })}'` });
  const req = { AD_REQUIRED: `printf 'build-and-test (22)\\t15368\\nsbom\\t15368\\n'` };
  const counter = run({ ...req, ...checks([r(1, 'build-and-test (22)', 'success', 15368), r(2, 'sbom', 'skipped', 15368), r(3, 'sbom', 'success', 999)]) });
  expect(counter).toContain('required_not_success:sbom=skipped'); expect(counter).not.toContain('DEPLOYED');
  const other = run({ ...req, ...checks([r(1, 'build-and-test (22)', 'success', 15368), r(3, 'sbom', 'success', 999)]) });
  expect(other).toContain('required_missing:sbom'); expect(other).not.toContain('DEPLOYED');
  expect(run({ ...req, ...checks([r(1, 'build-and-test (22)', 'success', 15368), r(2, 'sbom', 'success', 15368)]) })).toContain('DEPLOYED');
  // the real reader keeps the app id from the public branch summary
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bin-'));
  const summary = JSON.stringify({ protection: { required_status_checks: { contexts: ['sbom'], checks: [{ context: 'sbom', app_id: 15368 }] } } });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\ncase "$*" in *branches/main*) echo '${summary}' ;; *) exit 22 ;; esac\n`, { mode: 0o755 });
  const viaSummary = run({ AD_REQUIRED: '', PATH: `${bin}:${process.env.PATH}`, ...checks([r(2, 'sbom', 'skipped', 15368), r(3, 'sbom', 'success', 999)]) });
  expect(viaSummary).toContain('required_not_success:sbom=skipped'); expect(viaSummary).not.toContain('DEPLOYED');
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

// S2: curl stub serving `content` as the commit's scripts/deploy-vps.sh (the real fetch path, no network)
const commitCopy = (content: string) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bin-'));
  const src = path.join(bin, 'deploy-vps.sh'); fs.writeFileSync(src, content);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\nout=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; cat '${src}' > "$out"\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
};
const installer = path.resolve(__dirname, '../../../../scripts/install-deploy-script.sh');
const install = (root: string, content: string, args: string[] = ['--apply']) =>
  spawnSync('bash', [installer, NEW, ...args], { env: { ...process.env, DEPLOY_ROOT: root, ...commitCopy(content) }, encoding: 'utf8' });
const realDeploy = { AD_DEPLOY: '', AD_DEPLOY_GATE: '', AD_STALLS: 'echo', AD_RESTARTS: 'echo 0' };

it('the real deploy path leaves no RETURN trap behind (bash 5: "tmp: unbound variable" after every deploy)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  // a fake deploy-vps.sh, fetched by curl exactly like the real path and installed on the host by the operator step (S2)
  expect(install(root, 'echo deployed-fake\n').status).toBe(0);
  const out = run({ ...realDeploy, ...commitCopy('echo deployed-fake\n') }, root);
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

// S2 (DEP-01): auto-deploy runs as root on the host. It runs the host-installed deploy script; the copy in the commit it
// deploys is fetched only to compare, so merging a change to deploy-vps.sh never reaches root without an operator step.
const RAN = 'echo "deploy-script-ran-from $0"\n';
const killSwitch = (root: string) => { try { return fs.readFileSync(path.join(root, 'AUTO_DEPLOY_DISABLED'), 'utf8'); } catch { return null; } };

it('S2: deploys with the host-installed copy of deploy-vps.sh when the commit carries the same script', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  expect(install(root, RAN).status).toBe(0);
  const out = run({ ...realDeploy, ...commitCopy(RAN) }, root);
  expect(out).toContain(`deploy-script-ran-from ${path.join(root, 'deploy-vps.installed.sh')}`);
  expect(out).toContain(`done ${NEW}`);
  expect(killSwitch(root)).toBeNull();
});

it('S2: a deploy-vps.sh changed in the deployed commit is not executed; auto-deploy pauses until the operator installs it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  expect(install(root, RAN).status).toBe(0);
  const changed = 'echo COMMIT-COPY-RAN\n';
  const out = run({ ...realDeploy, ...commitCopy(changed) }, root);
  expect(out).not.toContain('COMMIT-COPY-RAN');
  expect(out).not.toContain('deploy-script-ran-from');
  expect(out).toContain('auto-deploy paused');
  expect(killSwitch(root)).toContain('scripts/deploy-vps.sh');
  expect(killSwitch(root)).toContain('install-deploy-script.sh');
  expect(fs.existsSync(path.join(root, '.last-deploy'))).toBe(false);
  // the explicit operator step installs the reviewed script; after the kill switch is removed it deploys with it
  expect(install(root, changed).status).toBe(0);
  fs.rmSync(path.join(root, 'AUTO_DEPLOY_DISABLED'));
  const resumed = run({ ...realDeploy, ...commitCopy(changed) }, root);
  expect(resumed).toContain('COMMIT-COPY-RAN');
  expect(resumed).toContain(`done ${NEW}`);
});

it('S2: without a host-installed copy auto-deploy refuses, says how to install it and runs nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  const r = spawnSync('bash', [script], { env: { ...process.env, DEPLOY_ROOT: root, AD_MAIN_SHA: `printf '${NEW}\\trefs/heads/main\\n'`, AD_CURRENT_SHA: `echo ${OLD}`,
    AD_CHECKS: `echo '${green}'`, AD_REQUIRED: `echo 'build-and-test (22)'`, AD_COMMIT: `echo '${minutesAgo(30)}'`, AD_LEASES: 'echo 0', ...realDeploy, ...commitCopy(RAN) }, encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  expect(r.status).not.toBe(0);
  expect(out).toContain('install-deploy-script.sh');
  expect(out).not.toContain('deploy-script-ran-from');
  expect(fs.existsSync(path.join(root, '.last-deploy'))).toBe(false);
});

it('S2: an installed copy edited outside the installer does not run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  expect(install(root, RAN).status).toBe(0);
  fs.appendFileSync(path.join(root, 'deploy-vps.installed.sh'), 'echo TAMPERED\n');
  const out = run({ ...realDeploy, ...commitCopy(RAN) }, root);
  expect(out).not.toContain('TAMPERED');
  expect(out).not.toContain('deploy-script-ran-from');
  expect(killSwitch(root)).toContain('install record');
});

it('S2: install-deploy-script.sh is a dry run by default and records the source commit and hash on --apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  const dry = install(root, RAN, []);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toContain('dry run');
  expect(fs.existsSync(path.join(root, 'deploy-vps.installed.sh'))).toBe(false);
  expect(install(root, RAN).status).toBe(0);
  expect(fs.readFileSync(path.join(root, 'deploy-vps.installed.sh'), 'utf8')).toBe(RAN);
  const record = fs.readFileSync(path.join(root, 'deploy-vps.installed.sh.source'), 'utf8');
  expect(record).toContain(`commit=${NEW}`);
  expect(record).toMatch(/^sha256=[0-9a-f]{64}$/m);
  expect(spawnSync('bash', [installer, 'not-a-sha'], { env: { ...process.env, DEPLOY_ROOT: root }, encoding: 'utf8' }).status).not.toBe(0);
});
