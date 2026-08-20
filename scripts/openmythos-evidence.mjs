#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const benchmark = resolve(process.env.OPENMYTHOS_BENCHMARK_PATH || '/Users/dlandman/OpenMythos/openmythos-benchmark');
const corpus = resolve(benchmark, 'cases/corpus.jsonl');
const manifestPath = resolve(benchmark, 'cases/manifest.json');
const anchors = resolve(benchmark, 'cases/drafts/skill-lifecycle-oracle-anchors.json');
const output = resolve(root, 'openspec/changes/assurance-truth-closure/openmythos-evidence.json');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function python(script) {
  const result = spawnSync('python3', [script], { cwd: benchmark, encoding: 'utf8' });
  return { status: result.status === 0 ? 'pass' : 'fail', exit_code: result.status, evidence: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

let report;
try {
  const cases = readFileSync(corpus, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const corpusHash = sha256(corpus);
  if (manifest.schema_version !== 1 || manifest.case_count !== cases.length || manifest.sha256 !== corpusHash) {
    throw new Error('OPENMYTHOS_CORPUS_MANIFEST_MISMATCH');
  }
  const maturity = Object.fromEntries(['draft', 'reviewed', 'validated', 'community'].map(status => [status, cases.filter(item => item.validation_status === status).length]));
  const corpusValidation = python('scripts/validate.py');
  const lifecycle = python('scripts/skill_lifecycle_gate.py');
  const broadCertificationReady = corpusValidation.status === 'pass'
    && lifecycle.status === 'pass'
    && maturity.validated === cases.length;
  report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    status: corpusValidation.status === 'fail' || lifecycle.status === 'fail' ? 'fail' : broadCertificationReady ? 'pass' : 'blocked',
    corpus: { path: corpus, manifest_path: manifestPath, sha256: corpusHash, cases: cases.length, maturity },
    oracle_anchors: { path: anchors, sha256: sha256(anchors) },
    gates: { corpus_validation: corpusValidation, lifecycle_oracle: lifecycle, repeatability: 'not_run', held_out_discrimination: 'not_run' },
    admissibility: {
      structural_validation: corpusValidation.status === 'pass' && lifecycle.status === 'pass',
      broad_governance_certification: broadCertificationReady,
      reason: broadCertificationReady ? null : 'Only validated cases may support broad certification; repeatability and held-out discrimination are not established.',
    },
  };
} catch (error) {
  report = { schema_version: 1, generated_at: new Date().toISOString(), status: 'blocked', reason: error instanceof Error ? error.message : String(error) };
}

writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.status.toUpperCase()} ${output}`);
process.exitCode = report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1;
