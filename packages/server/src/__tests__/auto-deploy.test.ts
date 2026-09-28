import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
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
