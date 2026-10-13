import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import type { LoopRunRecord, WorkerLeaseRecord } from '../services/loop-types';

let db: Database.Database; let loops: LoopService; let dir: string;
beforeEach(() => {
  db = new Database(':memory:'); db.exec(schema); runMigrations(db); loops = new LoopService(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-budget-'));
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * Prod 09-10, run 5b91e689 (mutation-gap, stall-watch): checker, security checker and both retries all died on
 * "OpenCode token budget exceeded: 1.03M > 1M". Per step the context was only 19k–45k tokens, but opencode's total adds
 * every step's input + cache read: 26–29 steps × ~36k ≈ 1.03M. 20–24 of the ~30 tool calls went to `npm ci` (the prompt
 * told them to), a better-sqlite3 native build the container cannot do (no make/g++), apt-get, prebuild-install, and
 * re-running Stryker/vitest — because the check logs live outside the worktree (opencode external_directory deny), so
 * the mutation result was invisible. The prompt now carries the check output and forbids re-running it.
 */
it('the reviewer assignment carries the deterministic check output (incl. the mutation score) and forbids installs and re-runs', () => {
  const out = (name: string, text: string) => { const p = path.join(dir, `${name}.stdout.log`); fs.writeFileSync(p, text); return p; };
  const checks = [
    { name: 'test:changed', status: 'pass', exit_status: 0, stdout_path: out('test-changed', '\u001b[32m✓\u001b[39m src/__tests__/stall-watch.test.ts (8 tests)\n Tests  8 passed (8)\n') },
    { name: 'test:mutation:grounded', status: 'pass', exit_status: 0, stdout_path: out('mutation', `${'x'.repeat(5_000)}\n{"mutation_gain":{"file":"packages/server/src/services/stall-watch.ts","test":"packages/server/src/__tests__/stall-watch.test.ts","before":14.5,"after":98.2,"gain":83.7,"min_gain":10,"pass":true}}\n`) },
    { name: 'lint', status: 'pass', exit_status: 0, stdout_path: path.join(dir, 'missing.log') },
  ];
  const maker = { id: 'maker', role: 'maker', worktree_path: '', metadata: { deterministic_checks: checks } } as unknown as WorkerLeaseRecord;
  const checker = { id: 'checker', role: 'checker', metadata: {} } as unknown as WorkerLeaseRecord;
  const prompt = loops.buildCheckerPrompt({ id: 'run', loop_name: 'doc-drift-and-small-fix-loop' } as LoopRunRecord, maker, checker);
  expect(prompt).toContain('"after":98.2');
  expect(prompt).toContain('8 passed (8)');
  expect(prompt).not.toContain('\u001b[');
  expect(prompt).not.toContain('x'.repeat(2_000)); // tails only: tool output is capped
  expect(prompt).not.toContain('install dependencies here with `npm ci');
  expect(prompt).toMatch(/Do not install dependencies/);
  expect(prompt).toMatch(/mutation testing/);
  expect(prompt).toContain("Work only inside your own worktree (the maker's changes are already in it); do not read the maker's worktree.");
});

/**
 * Prod 02-10, run 3d7dbc93 lease 09272945: an opencode reviewer exited 0 with a clear needs_revision verdict, but wrapped
 * the JSON in backticks in the middle of its final paragraph; the line-based parser saw no line starting with '{', so
 * the lease got verdict=insufficient_evidence and the raw event stream as notes. (Run 161f7840, 09-10, the other
 * suspect, did parse: both verdicts 'accepted'; its checker_verdict gate failed on the read-only contract instead —
 * `npm install-scripts approve` added 4 lines to package.json.)
 */
it('a completed opencode reviewer whose verdict JSON is embedded in prose gets that verdict and its notes, not the raw stream', () => {
  const stdout = fs.readFileSync(new URL('./fixtures/opencode-reviewer-unparsed-verdict.jsonl', import.meta.url), 'utf8');
  expect(loops.extractCheckerVerdict(stdout)).toBe('needs_revision');
  expect(loops.extractCheckerNotes(stdout)).toMatch(/^The finding required adding packages\/server\/src\/__tests__\/assignment-context\.exports\.test\.ts/);
});

it('takes the last valid verdict object; the echoed format template and nested usage objects are not verdicts', () => {
  const text = 'Format: `{"verdict":"accepted|needs_revision|rejected|insufficient_evidence","notes":"..."}`. Draft: {"verdict":"needs_revision","notes":"draft"} final → `{"verdict":"accepted","notes":"final","usage":{"total_tokens":2}}` done.';
  const stdout = [JSON.stringify({ type: 'step_start' }), JSON.stringify({ type: 'text', part: { type: 'text', text } }), JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } })].join('\n');
  expect(loops.extractCheckerVerdict(stdout)).toBe('accepted');
  expect(loops.extractCheckerNotes(stdout)).toBe('final');
});

it('an earlier text part does not shadow the final answer', () => {
  const part = (text: string) => JSON.stringify({ type: 'text', part: { type: 'text', text } });
  const stdout = [part('Plan.\n{"verdict":"insufficient_evidence","notes":"not yet checked"}'), part('Checked.\n{"verdict":"rejected","notes":"wrong file"}')].join('\n');
  expect(loops.extractCheckerVerdict(stdout)).toBe('rejected');
  expect(loops.extractCheckerNotes(stdout)).toBe('wrong file');
});

it('existing semantics kept: an explicit insufficient_evidence stays insufficient_evidence even when its own notes approve; no verdict → notes are the last text, not the event stream', () => {
  const part = (text: string) => JSON.stringify({ type: 'text', part: { type: 'text', text } });
  const approving = part('{"verdict":"insufficient_evidence","notes":"Looks correct, I would approve, but I could not run the tests."}');
  expect(loops.extractCheckerVerdict(approving)).toBe('insufficient_evidence');
  const prose = [JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }), part('All good, approve.')].join('\n');
  expect(loops.extractCheckerVerdict(prose)).toBe('insufficient_evidence');
  expect(loops.extractCheckerNotes(prose)).toBe('All good, approve.');
});
