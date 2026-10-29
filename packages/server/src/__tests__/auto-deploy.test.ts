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
// the test user stands in for root as the trusted owner of $DEPLOY_ROOT, the install dir and the staging dir
const trust = (root: string) => ({ AUTO_DEPLOY_TRUSTED_UID: String(process.getuid!()), AUTO_DEPLOY_INSTALL_DIR: path.join(root, 'lib') });
const run = (over: Record<string, string> = {}, root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'))) => {
  const env = { ...process.env, DEPLOY_ROOT: root, ...trust(root), AD_MAIN_SHA: `printf '${NEW}\\trefs/heads/main\\n'`, AD_CURRENT_SHA: `echo ${OLD}`,
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
const commitCopy = (content: string, alsoRun = '') => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bin-'));
  const src = path.join(bin, 'deploy-vps.sh'); fs.writeFileSync(src, content);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\nout=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; cat '${src}' > "$out"\n${alsoRun}\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
};
const installer = path.resolve(__dirname, '../../../../scripts/install-deploy-script.sh');
const install = (root: string, content: string, args: string[] = ['--apply']) =>
  spawnSync('bash', [installer, NEW, ...args], { env: { ...process.env, DEPLOY_ROOT: root, ...trust(root), ...commitCopy(content) }, encoding: 'utf8' });
const installedPath = (root: string) => path.join(root, 'lib', 'deploy-vps.installed.sh');
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
  // it runs a verified copy of the installed script, read once, never the installed pathname itself
  expect(out).toMatch(/deploy-script-ran-from \S+/);
  expect(out).not.toContain(`deploy-script-ran-from ${installedPath(root)}`);
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
  const r = spawnSync('bash', [script], { env: { ...process.env, DEPLOY_ROOT: root, ...trust(root), AD_MAIN_SHA: `printf '${NEW}\\trefs/heads/main\\n'`, AD_CURRENT_SHA: `echo ${OLD}`,
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
  fs.appendFileSync(installedPath(root), 'echo TAMPERED\n');
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
  expect(fs.existsSync(installedPath(root))).toBe(false);
  expect(install(root, RAN).status).toBe(0);
  expect(fs.readFileSync(installedPath(root), 'utf8')).toBe(RAN);
  expect(fs.statSync(installedPath(root)).mode & 0o022).toBe(0);
  const record = fs.readFileSync(`${installedPath(root)}.source`, 'utf8');
  expect(record).toContain(`commit=${NEW}`);
  expect(record).toMatch(/^sha256=[0-9a-f]{64}$/m);
  expect(spawnSync('bash', [installer, 'not-a-sha'], { env: { ...process.env, DEPLOY_ROOT: root, ...trust(root) }, encoding: 'utf8' }).status).not.toBe(0);
});

// S3 (fleet ≠ main): the event bus and agent registry under /srv are deployed by hand, outside the build receipt. Every
// run compares the sha256 of their deployed *.py with infra/<service>/*.py at the running commit, into the data mount.
it('S3: writes fleet-drift.json with the service whose deployed sources differ from the running commit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-fleet-'));
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const repo = path.join(tmp, 'repo');
  write(path.join(repo, 'infra/event-bus/bus.py'), 'def publish(): dedupe()\n');
  write(path.join(repo, 'infra/event-bus/main.py'), 'app = 1\n');
  write(path.join(repo, 'infra/event-bus/Dockerfile'), 'FROM python\n');
  write(path.join(repo, 'infra/agent-registry/main.py'), 'registry = 1\n');
  write(path.join(repo, 'infra/agent-registry/tests/test_main.py'), 'def test(): pass\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  // deployed: event-bus/bus.py is an older copy (one changed file); agent-registry matches; a third service is not on this host
  write(path.join(tmp, 'srv/event-bus/bus.py'), 'def publish(): pass\n');
  write(path.join(tmp, 'srv/event-bus/main.py'), 'app = 1\n');
  write(path.join(tmp, 'srv/agent-registry/main.py'), 'registry = 1\n');
  const services = `event-bus=${tmp}/srv/event-bus=infra/event-bus agent-registry=${tmp}/srv/agent-registry=infra/agent-registry absent=${tmp}/srv/absent=infra/absent`;
  const root = path.join(tmp, 'root'); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const at = (sha: string, repoDir = repo) => run({ AD_MAIN_SHA: `printf '${sha}\\trefs/heads/main\\n'`, AD_CURRENT_SHA: `echo ${sha}`,
    AUTO_DEPLOY_FLEET_SERVICES: services, AUTO_DEPLOY_FLEET_REPO: repoDir }, root);
  expect(at(commit)).toContain('up to date');
  const drift = JSON.parse(fs.readFileSync(path.join(root, 'data', 'fleet-drift.json'), 'utf8'));
  expect(drift.commit).toBe(commit);
  expect(Number.isNaN(Date.parse(drift.checked_at))).toBe(false);
  expect(Object.keys(drift.services).sort()).toEqual(['agent-registry', 'event-bus']);
  expect(drift.services['event-bus']).toMatchObject({ match: false });
  expect(drift.services['event-bus'].deployed).toMatch(/^[0-9a-f]{64}$/);
  expect(drift.services['event-bus'].main).toMatch(/^[0-9a-f]{64}$/);
  expect(drift.services['event-bus'].deployed).not.toBe(drift.services['event-bus'].main);
  expect(drift.services['agent-registry'].match).toBe(true);
  expect(drift.services['agent-registry'].deployed).toBe(drift.services['agent-registry'].main);
  // a commit tree that cannot be read is not "no drift": nothing is written
  fs.rmSync(path.join(root, 'data', 'fleet-drift.json'));
  at(commit, path.join(tmp, 'no-such-repo'));
  expect(fs.existsSync(path.join(root, 'data', 'fleet-drift.json'))).toBe(false);
});

// Root writes into the data dir the container can write: never through a pre-planted link or a non-regular file.
it('a pre-planted symlink at data/deploy-log.jsonl is not followed: refused with a log line, the link target untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  fs.mkdirSync(path.join(root, 'data'));
  const victim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-victim-')), 'victim');
  fs.writeFileSync(victim, 'untouched\n');
  fs.symlinkSync(victim, path.join(root, 'data', 'deploy-log.jsonl'));
  const out = run({}, root);
  expect(out).toContain('DEPLOYED'); // the deploy itself is not held by the log
  expect(out).toContain('refusing to write');
  expect(fs.readFileSync(victim, 'utf8')).toBe('untouched\n');
  expect(fs.lstatSync(path.join(root, 'data', 'deploy-log.jsonl')).isSymbolicLink()).toBe(true);
  // a directory (not a regular file) at the log path is refused too, and nothing is written into it
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  fs.mkdirSync(path.join(root2, 'data', 'deploy-log.jsonl'), { recursive: true });
  expect(run({}, root2)).toContain('refusing to write');
  expect(fs.readdirSync(path.join(root2, 'data', 'deploy-log.jsonl'))).toEqual([]);
  // no temp file is left behind in the data dir
  expect(fs.readdirSync(path.join(root, 'data')).sort()).toEqual(['deploy-log.jsonl']);
});

it('the deploy log stays bounded, readable by the container user, and is replaced by rename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  fs.mkdirSync(path.join(root, 'data'));
  const log = path.join(root, 'data', 'deploy-log.jsonl');
  fs.writeFileSync(log, Array.from({ length: 1200 }, (_, i) => JSON.stringify({ event: 'old', i })).join('\n') + '\n');
  run({}, root);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  expect(lines.length).toBeLessThanOrEqual(1000);
  expect(lines.slice(-2).map((l) => JSON.parse(l).event)).toEqual(['deploying', 'done']);
  expect(fs.statSync(log).mode & 0o777).toBe(0o644);
  expect(fs.readdirSync(path.join(root, 'data'))).toEqual(['deploy-log.jsonl']);
});

it('a pre-planted symlink at data/fleet-drift.json is not followed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-fleet-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'infra/event-bus'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'infra/event-bus/bus.py'), 'x = 1\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(tmp, 'srv/event-bus'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'srv/event-bus/bus.py'), 'x = 2\n');
  const root = path.join(tmp, 'root'); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const victim = path.join(tmp, 'victim'); fs.writeFileSync(victim, 'untouched\n');
  fs.symlinkSync(victim, path.join(root, 'data', 'fleet-drift.json'));
  const out = run({ AD_MAIN_SHA: `printf '${commit}\\trefs/heads/main\\n'`, AD_CURRENT_SHA: `echo ${commit}`,
    AUTO_DEPLOY_FLEET_SERVICES: `event-bus=${tmp}/srv/event-bus=infra/event-bus`, AUTO_DEPLOY_FLEET_REPO: repo }, root);
  expect(out).toContain('refusing to write');
  expect(fs.readFileSync(victim, 'utf8')).toBe('untouched\n');
  expect(fs.lstatSync(path.join(root, 'data', 'fleet-drift.json')).isSymbolicLink()).toBe(true);
  expect(fs.readdirSync(path.join(root, 'data'))).toEqual(['fleet-drift.json']);
});

it('the staged copy of a data-dir write is never written through a link swapped in after it was created', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  fs.mkdirSync(path.join(root, 'data'));
  const victim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-victim-')), 'victim');
  fs.writeFileSync(victim, 'untouched\n');
  // test seam: replace the staged temp pathname with a link right after it is created, before the content is written
  const out = run({ AUTO_DEPLOY_TEST_HOOK_AFTER_TEMP: `rm -f "$TEMP_PATH"; ln -s '${victim}' "$TEMP_PATH"` }, root);
  expect(out).toContain('DEPLOYED');
  expect(out).toContain('refusing to write');
  expect(fs.readFileSync(victim, 'utf8')).toBe('untouched\n');
  for (const name of fs.readdirSync(path.join(root, 'data'))) expect(fs.lstatSync(path.join(root, 'data', name)).isSymbolicLink()).toBe(false);
});

// S2: the installed copy is trusted only when it and every directory above it are root's and not group/other-writable;
// it is read once into a private copy that is hashed and executed, so a swap after the check runs nothing new.
it('S2: a swap of the installed script after it was verified does not reach execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  expect(install(root, RAN).status).toBe(0);
  // the commit-copy fetch happens after the installed copy was read; it rewrites the installed file as a side effect
  const out = run({ ...realDeploy, ...commitCopy(RAN, `echo 'echo TAMPERED' >> '${installedPath(root)}'`) }, root);
  expect(fs.readFileSync(installedPath(root), 'utf8')).toContain('TAMPERED');
  expect(out).not.toContain('TAMPERED');
  expect(out).toContain('deploy-script-ran-from');
  expect(out).toContain(`done ${NEW}`);
});

it('S2: an installed script in a group-writable dir, or group-writable itself, is not trusted and not run', () => {
  for (const loosen of [(root: string) => fs.chmodSync(path.join(root, 'lib'), 0o775), (root: string) => fs.chmodSync(installedPath(root), 0o775)]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
    expect(install(root, RAN).status).toBe(0);
    loosen(root);
    const r = spawnSync('bash', [script], { env: { ...process.env, DEPLOY_ROOT: root, ...trust(root), AD_MAIN_SHA: `printf '${NEW}\\trefs/heads/main\\n'`, AD_CURRENT_SHA: `echo ${OLD}`,
      AD_CHECKS: `echo '${green}'`, AD_REQUIRED: `echo 'build-and-test (22)'`, AD_COMMIT: `echo '${minutesAgo(30)}'`, AD_LEASES: 'echo 0', ...realDeploy, ...commitCopy(RAN) }, encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(out).toContain('not trusted');
    expect(out).toContain('writable by group or others');
    expect(out).not.toContain('deploy-script-ran-from');
  }
});

it('S2: an installed script not owned by the trusted uid is not run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  expect(install(root, RAN).status).toBe(0);
  // the test user owns the file; requiring a different owner stands in for "not owned by root"
  const out = run({ ...realDeploy, ...commitCopy(RAN), AUTO_DEPLOY_TRUSTED_UID: String(process.getuid!() + 1) }, root);
  expect(out).toContain('not trusted');
  expect(out).not.toContain('deploy-script-ran-from');
});

it('S2: auto-deploy refuses to act at all when $DEPLOY_ROOT is writable by group or others', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  fs.chmodSync(root, 0o777);
  const out = run({}, root);
  expect(out).toContain('not trusted');
  expect(out).not.toContain('DEPLOYED');
});

it('S2: install-deploy-script.sh installs only into a trusted dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-'));
  fs.mkdirSync(path.join(root, 'open')); fs.chmodSync(path.join(root, 'open'), 0o777);
  const dir = path.join(root, 'open', 'lib');
  const r = spawnSync('bash', [installer, NEW, '--apply'], { env: { ...process.env, DEPLOY_ROOT: root, ...trust(root), AUTO_DEPLOY_INSTALL_DIR: dir, ...commitCopy(RAN) }, encoding: 'utf8' });
  expect(r.status).not.toBe(0);
  expect(`${r.stdout}${r.stderr}`).toContain('writable by group or others');
  expect(fs.existsSync(path.join(dir, 'deploy-vps.installed.sh'))).toBe(false);
});
