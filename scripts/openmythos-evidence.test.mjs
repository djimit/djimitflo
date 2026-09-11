import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// Disposable structural-validator stand-ins test the real report CLI/predicate.
// These fixtures never represent actual corpus quality or model execution.
function probe({ certificationReady = false, maturity = ['validated'], validatorFails = false, mismatch = false, repeatabilityDecision, heldOutDecision } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'djimitflo-openmythos-admission-'));
  try {
    mkdirSync(join(root, 'cases', 'drafts'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    const corpus = maturity.map((validation_status, index) => JSON.stringify({ id: `fixture-${index}`, validation_status })).join('\n') + (maturity.length ? '\n' : '');
    writeFileSync(join(root, 'cases', 'corpus.jsonl'), corpus);
    writeFileSync(join(root, 'cases', 'manifest.json'), JSON.stringify({ schema_version: 1, case_count: maturity.length,
      sha256: mismatch ? 'wrong' : createHash('sha256').update(corpus).digest('hex'), certification_ready: certificationReady }));
    writeFileSync(join(root, 'cases', 'drafts', 'skill-lifecycle-oracle-anchors.json'), '{}');
    writeFileSync(join(root, 'scripts', 'validate.py'), validatorFails ? 'raise SystemExit(1)\n' : 'print("SYNTHETIC structural fixture only")\n');
    writeFileSync(join(root, 'scripts', 'skill_lifecycle_gate.py'), 'print("SYNTHETIC lifecycle fixture only")\n');
    if (repeatabilityDecision || heldOutDecision) {
      const reports = join(root, 'analysis', 'openmythos-apex-runs', 'reports');
      mkdirSync(reports, { recursive: true });
      if (repeatabilityDecision) writeFileSync(join(reports, 'apex-r28-deterministic-repeatability.json'), JSON.stringify({ complete: true, decision: { status: repeatabilityDecision }, model: 'fixture' }));
      if (heldOutDecision) writeFileSync(join(reports, 'apex-r29-deterministic-policy-full.json'), JSON.stringify({ complete: true, decision: { status: heldOutDecision }, model: 'fixture' }));
    }
    const output = join(root, 'report.json');
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'openmythos-evidence.mjs')], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, OPENMYTHOS_BENCHMARK_PATH: root, OPENMYTHOS_REPORT_PATH: output, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.ifError(result.error);
    return { exit: result.status, report: JSON.parse(readFileSync(output, 'utf8')) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const certificationReady of [false, true, 'true', null]) {
  test(`validated labels and manifest certification_ready=${JSON.stringify(certificationReady)} cannot replace unexecuted evidence`, () => {
    const { exit, report } = probe({ certificationReady });
    assert.equal(report.admissibility.structural_validation, true);
    assert.equal(report.gates.repeatability, 'not_run');
    assert.equal(report.gates.held_out_discrimination, 'not_run');
    assert.equal(report.status, 'blocked', JSON.stringify({ observed_status: report.status, exit, gates: report.gates }));
    assert.equal(report.admissibility.broad_governance_certification, false);
    assert.equal(exit, 2);
  });
}

test('empty corpus cannot certify vacuously', () => {
  const { exit, report } = probe({ certificationReady: true, maturity: [] });
  assert.equal(report.admissibility.broad_governance_certification, false);
  assert.equal(exit, 2);
});

test('reviewed and draft cases remain explicitly blocked', () => {
  const { exit, report } = probe({ maturity: ['reviewed', 'draft', 'validated'] });
  assert.deepEqual(report.corpus.maturity, { draft: 1, reviewed: 1, validated: 1, community: 0 });
  assert.equal(report.status, 'blocked');
  assert.equal(exit, 2);
});

test('failed structural validation remains failure, not blocked or pass', () => {
  const { exit, report } = probe({ validatorFails: true });
  assert.equal(report.status, 'fail');
  assert.equal(report.admissibility.structural_validation, false);
  assert.equal(exit, 1);
});

test('mismatched corpus provenance remains blocked', () => {
  const { exit, report } = probe({ mismatch: true });
  assert.equal(report.reason, 'OPENMYTHOS_CORPUS_MANIFEST_MISMATCH');
  assert.equal(report.status, 'blocked');
  assert.equal(exit, 2);
});

test('executed model evidence closes gates and preserves a rejected policy pair', () => {
  const accepted = probe({ certificationReady: true, repeatabilityDecision: 'pass', heldOutDecision: 'accept' });
  assert.equal(accepted.report.gates.repeatability, 'pass');
  assert.equal(accepted.report.gates.held_out_discrimination, 'pass');
  assert.equal(accepted.report.status, 'pass');

  const rejected = probe({ certificationReady: true, repeatabilityDecision: 'pass', heldOutDecision: 'reject' });
  assert.equal(rejected.report.gates.repeatability, 'pass');
  assert.equal(rejected.report.gates.held_out_discrimination, 'fail');
  assert.equal(rejected.report.status, 'blocked');
  assert.equal(rejected.report.evaluations.held_out_discrimination.decision, 'reject');
});
