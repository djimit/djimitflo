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
