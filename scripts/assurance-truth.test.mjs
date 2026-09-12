import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, sourceState } from './assurance-truth.mjs';

assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer [REDACTED]');
assert.equal(redact('api_key=supersecret'), 'api_key=[REDACTED]');
assert.equal(redact('password: hunter2'), 'password: [REDACTED]');
console.log('assurance redaction: pass');

const fixture = mkdtempSync(join(tmpdir(), 'djimitflo-assurance-source-'));
try {
  const git = (...args) => execFileSync('git', args, { cwd: fixture, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  writeFileSync(join(fixture, 'source.txt'), 'base\n');
  git('add', 'source.txt');
  git('-c', 'user.name=Disposable fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture base');
  const clean = sourceState(fixture);
  assert.equal(clean.dirty, false);
  const prefix = '0123456789abcdef\n'.repeat(100_000);
  let previous;
  for (const tail of ['first-tail', 'changed-after-one-megabyte']) {
    writeFileSync(join(fixture, 'source.txt'), `${prefix}${tail}\n`);
    const diff = git('diff', '--binary', 'HEAD');
    assert.ok(diff.length > 1024 * 1024);
    const state = sourceState(fixture);
    assert.equal(state.commit, clean.commit);
    assert.equal(state.dirty, true);
    assert.equal(state.dirty_state_sha256, createHash('sha256').update(diff).digest('hex'));
    assert.notEqual(state.dirty_state_sha256, createHash('sha256').update(diff.subarray(0, 1024 * 1024)).digest('hex'));
    if (previous) assert.notEqual(state.dirty_state_sha256, previous);
    previous = state.dirty_state_sha256;
  }
  // Fail closed on unavailable Git state; do not substitute a clean identity.
  assert.throws(() => sourceState(join(fixture, 'missing-repository')));
  console.log('assurance source identity: full >1MB diff, late-change sensitivity, unavailable-repo rejection: pass');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
