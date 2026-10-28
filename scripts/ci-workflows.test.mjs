// Release-enforcement lint over .github/workflows (forensic 2026-10-26 rank 9: HY-001, ROOT-001).
// GitHub branch protection counts a required check that concluded `skipped` as passed, and a job is skipped when its own
// `if:` — or the `if:` of any job it `needs` — is false. So a required context must come from a job that cannot be skipped,
// cannot swallow a failure, and tests the exact PR head commit. Run: node scripts/ci-workflows.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

// The contexts branch protection on main requires (the operator's list; PR body of ci/release-enforcement). The first five
// were required on 2026-10-26; fleet-auth-infra and mutation-test are the recommended additions — both run on every PR.
export const REQUIRED_CONTEXTS = ['build-and-test (22)', 'build-and-test (24)', 'security-scan', 'sbom', 'gitleaks', 'fleet-auth-infra', 'mutation-test'];
const HEAD_REF = '${{ github.event.pull_request.head.sha || github.sha }}';

/** Minimal reader for the block YAML these workflows use: top-level sections and per-job blocks by indentation. */
export function readWorkflow(text) {
  const lines = text.split('\n');
  const section = (key) => {
    const start = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (start < 0) return [];
    const end = lines.findIndex((l, i) => i > start && /^\S/.test(l) && !l.startsWith('#'));
    return lines.slice(start, end < 0 ? undefined : end);
  };
  const jobs = {};
  let current = null;
  for (const line of section('jobs').slice(1)) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) { current = m[1]; jobs[current] = []; continue; }
    if (current) jobs[current].push(line);
  }
  const on = section('on');
  return { on, jobs };
}

const prop = (block, key) => block.find((l) => new RegExp(`^ {4}${key}:`).test(l))?.replace(new RegExp(`^ {4}${key}:\\s*`), '').trim();
const list = (v) => (v ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
const steps = (block) => block.join('\n').split(/\n(?= {6}- )/).filter((s) => /^ {6}- /m.test(s));

/** The check-run names a job reports: `name` or the job id, plus ` (<matrix values>)` for a one-dimensional matrix. */
export function contextsOf(id, block) {
  const name = prop(block, 'name') ?? id;
  const matrix = block.find((l) => /^ {8}[\w-]+: \[.*\]\s*$/.test(l));
  return matrix ? list(matrix.replace(/^ {8}[\w-]+:\s*/, '')).map((v) => `${name} (${v})`) : [name];
}

export function loadWorkflows(dir = WF) {
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((file) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    return { file, text, ...readWorkflow(text) };
  });
}

/** Every rule a required context must satisfy; [] means enforceable. Pure, so the failing shapes are tested below. */
export function requiredContextViolations(workflows, required = REQUIRED_CONTEXTS) {
  const out = [];
  const producers = new Map();
  for (const wf of workflows) for (const [id, block] of Object.entries(wf.jobs)) for (const c of contextsOf(id, block)) {
    producers.set(c, [...(producers.get(c) ?? []), { wf, id, block }]);
  }
  for (const ctx of required) {
    const found = producers.get(ctx) ?? [];
    if (found.length !== 1) { out.push(`${ctx}: produced by ${found.length} jobs (need exactly 1)`); continue; }
    const { wf, id } = found[0];
    const on = wf.on.join('\n');
    if (!/^ {2}pull_request:/m.test(on)) out.push(`${ctx}: ${wf.file} does not run on pull_request`);
    if (/^ {2}pull_request_target:/m.test(on)) out.push(`${ctx}: ${wf.file} runs on pull_request_target (base code, not the head)`);
    if (/^ {4}(paths|paths-ignore|branches-ignore|types):/m.test(on)) out.push(`${ctx}: ${wf.file} filters its triggers (a filtered head never reports)`);
    // the job and every job it needs, transitively: one false `if:` skips them all, and skipped counts as passed
    const seen = new Set();
    const walk = (jobId) => {
      if (seen.has(jobId)) return; seen.add(jobId);
      const block = wf.jobs[jobId];
      if (!block) { out.push(`${ctx}: needs unknown job ${jobId}`); return; }
      if (prop(block, 'if') !== undefined) out.push(`${ctx}: job ${jobId} in ${wf.file} has a job-level if: (a skip passes protection)`);
      if (block.some((l) => /continue-on-error:\s*(true|\$\{\{)/.test(l))) out.push(`${ctx}: job ${jobId} in ${wf.file} sets continue-on-error`);
      for (const n of list(prop(block, 'needs'))) walk(n);
    };
    walk(id);
    for (const step of steps(found[0].block)) {
      if (/uses: actions\/checkout@/.test(step) && !step.includes(`ref: ${HEAD_REF}`)) out.push(`${ctx}: job ${id} checks out without ref: ${HEAD_REF}`);
      if (/^ {8}if:/m.test(step)) out.push(`${ctx}: job ${id} has a step-level if: (a skipped step is a green job)`);
    }
  }
  return out;
}

test('every required context comes from one unskippable, fail-closed job that tests the exact head', () => {
  assert.deepEqual(requiredContextViolations(loadWorkflows()), []);
});

test('the lint catches each way a required check can pass without running (fail-first shapes)', () => {
  const wf = (jobs, on = 'on:\n  pull_request:\n    branches: [main]\n') => readWorkflow(`${on}jobs:\n${jobs}`);
  const ok = `  sbom:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@abc\n        with:\n          ref: ${HEAD_REF}\n`;
  const one = (w) => requiredContextViolations([{ file: 't.yml', ...w }], ['sbom']);
  assert.deepEqual(one(wf(ok)), []);
  assert.match(one(wf(ok.replace('    runs-on: x\n', "    if: github.actor != 'x'\n    runs-on: x\n")))[0], /job-level if/);
  assert.match(one(wf(`  pre:\n    if: false\n    runs-on: x\n${ok.replace('    runs-on: x\n', '    needs: pre\n    runs-on: x\n')}`))[0], /job pre .* job-level if/);
  assert.match(one(wf(ok.replace(`          ref: ${HEAD_REF}\n`, '          fetch-depth: 1\n')))[0], /checks out without ref/);
  assert.match(one(wf(ok, 'on:\n  pull_request:\n    paths: [src/**]\n'))[0], /filters its triggers/);
  assert.match(one(wf(ok, 'on:\n  push:\n    branches: [main]\n'))[0], /does not run on pull_request/);
  assert.match(one(wf(`${ok}      - run: x\n        continue-on-error: true\n`))[0], /continue-on-error/);
  assert.match(one(wf(`${ok}      - run: x\n        if: always()\n`))[0], /step-level if/);
  assert.match(one(wf(ok.replace('  sbom:', '  other:')))[0], /produced by 0 jobs/);
});

test('matrix jobs report one context per value, as GitHub names them', () => {
  const { jobs } = readWorkflow('jobs:\n  build-and-test:\n    strategy:\n      matrix:\n        node-version: [22, 24]\n    steps: []\n');
  assert.deepEqual(contextsOf('build-and-test', jobs['build-and-test']), ['build-and-test (22)', 'build-and-test (24)']);
});

test('every third-party action is pinned to a full commit sha (a moved tag changes CI inputs silently)', () => {
  const loose = loadWorkflows().flatMap(({ file, text }) => [...text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)]
    .map((m) => m[1]).filter((u) => !u.startsWith('./') && !/@[0-9a-f]{40}$/.test(u)).map((u) => `${file}: ${u}`));
  assert.deepEqual(loose, []);
});

test('Dependabot auto-merge goes through the corrected gate, never GitHub-native auto-merge', () => {
  // GitHub-native auto-merge counts a skipped required check as passed; the Dependabot path calls scripts/dependabot-merge.sh
  // (merge-train checks_verdict on the exact head, then a sha-pinned merge) instead (operator decision on #1061).
  const native = loadWorkflows().filter(({ text }) => /gh pr merge[^\n]*--auto|enablePullRequestAutoMerge/.test(text)).map((w) => w.file);
  assert.deepEqual(native, []);
  const dep = loadWorkflows().find((w) => w.file === 'dependabot-auto-merge.yml');
  assert.ok(dep, 'dependabot-auto-merge.yml is kept (operator decision)');
  assert.match(dep.text, /bash scripts\/dependabot-merge\.sh /);
  assert.match(dep.text, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, 'the gate runs from main, never from the PR');
});
