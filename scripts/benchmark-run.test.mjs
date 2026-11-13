// The benchmark runner never completed in prod (2026-11-13): the image ENTRYPOINT is the relative ./docker-entrypoint.sh, so
// every `docker run -w /tmp` failed to start, and it read DJIMITFLO_BUILD_SHA, which the image did not set.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = process.argv[2] || path.join(ROOT, 'scripts/benchmark-run.sh');
for (const bench of ['sec-f1', 'f1']) {
  const r = spawnSync('bash', [script, bench], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${bench} dry run exits 0: ${r.stderr}`);
  const runs = r.stdout.split('\n').filter((l) => /^\+ docker run /.test(l));
  assert.ok(runs.length >= 2, `${bench}: the dry run prints its docker run commands`);
  for (const l of runs) assert.match(l, / --entrypoint /, `${bench}: every docker run resets the image entrypoint: ${l.slice(0, 80)}`);
  assert.match(r.stdout, /printenv DJIMITFLO_BUILD_COMMIT/, `${bench}: the build sha comes from DJIMITFLO_BUILD_COMMIT`);
}
assert.match(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'), /^ENV DJIMITFLO_BUILD_SHA=\$VCS_REF$/m, 'the image sets DJIMITFLO_BUILD_SHA');
console.log('benchmark-run.test.mjs ok');
