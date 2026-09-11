#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const benchmark = resolve(process.env.OPENMYTHOS_BENCHMARK_PATH || '/Users/dlandman/OpenMythos/openmythos-benchmark');
const corpus = resolve(benchmark, 'cases/corpus.jsonl');
const manifestPath = resolve(benchmark, 'cases/manifest.json');
const anchors = resolve(benchmark, 'cases/drafts/skill-lifecycle-oracle-anchors.json');
const output = resolve(root, process.env.OPENMYTHOS_REPORT_PATH || 'openspec/changes/assurance-truth-closure/openmythos-evidence.json');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function evaluationGate(path, acceptedDecision) {
  if (!existsSync(path)) return { status: 'not_run', report: null };
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const status = report.complete === true && report.decision?.status === acceptedDecision ? 'pass' : 'fail';
    return { status, report: {
      path,
      model: report.model,
      complete: report.complete === true,
      decision: report.decision?.status ?? null,
      reasons: report.decision?.reasons ?? [],
      cases: report.cases ?? report.cases_per_arm ?? null,
      baseline: report.baseline ?? null,
      policy: report.policy_arm ?? null,
      paired: report.paired ?? null,
    } };
  } catch (error) {
    return { status: 'fail', report: { path, parse_error: error instanceof Error ? error.message : String(error) } };
  }
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
  const repeatability = evaluationGate(
    resolve(benchmark, process.env.OPENMYTHOS_REPEATABILITY_REPORT_PATH || 'analysis/openmythos-apex-runs/reports/apex-r28-deterministic-repeatability.json'),
    'pass',
  );
  const heldOut = evaluationGate(
    resolve(benchmark, process.env.OPENMYTHOS_HELD_OUT_REPORT_PATH || 'analysis/openmythos-apex-runs/reports/apex-r29-deterministic-policy-full.json'),
    'accept',
  );
  const gates = { corpus_validation: corpusValidation, lifecycle_oracle: lifecycle, repeatability: repeatability.status, held_out_discrimination: heldOut.status };
  const broadCertificationReady = corpusValidation.status === 'pass'
    && lifecycle.status === 'pass'
    && cases.length > 0
    && maturity.validated === cases.length
    && manifest.certification_ready === true
    && gates.repeatability === 'pass'
    && gates.held_out_discrimination === 'pass';
  report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    status: corpusValidation.status === 'fail' || lifecycle.status === 'fail' ? 'fail' : broadCertificationReady ? 'pass' : 'blocked',
    corpus: { path: corpus, manifest_path: manifestPath, sha256: corpusHash, cases: cases.length, maturity, certification_ready: manifest.certification_ready === true },
    oracle_anchors: { path: anchors, sha256: sha256(anchors) },
    gates,
    admissibility: {
      structural_validation: corpusValidation.status === 'pass' && lifecycle.status === 'pass',
      broad_governance_certification: broadCertificationReady,
      reason: broadCertificationReady ? null : 'Broad certification requires a nonempty fully validated corpus, certification-ready manifest, and passing repeatability and held-out discrimination evidence.',
    },
    evaluations: { repeatability: repeatability.report, held_out_discrimination: heldOut.report },
  };
} catch (error) {
  report = { schema_version: 1, generated_at: new Date().toISOString(), status: 'blocked', reason: error instanceof Error ? error.message : String(error) };
}

writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.status.toUpperCase()} ${output}`);
process.exitCode = report.status === 'pass' ? 0 : report.status === 'blocked' ? 2 : 1;
