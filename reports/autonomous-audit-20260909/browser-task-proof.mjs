import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const taskId = process.argv[2];
const browserLog = process.argv[3];
const output = process.argv[4];
const expectedMarker = process.argv[5];
assert.match(taskId || '', /^[a-f0-9-]{36}$/);
assert.ok(browserLog?.startsWith('reports/autonomous-audit-20260909/evidence/'));
assert.ok(output?.startsWith('reports/autonomous-audit-20260909/evidence/'));
const fixture = '/private/tmp/djimitflo-browser-task.xlbXU6';
const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim();
const testOutput = execFileSync('npm', ['test'], { cwd: fixture, encoding: 'utf8' });
assert.match(testOutput, /BROWSER_TASK_FIXTURE_VERIFIED/);
assert.equal(git('rev-parse', 'HEAD'), '351ce015894cd25ee05e51b61003137e4251ccf3');
assert.equal(git('diff', '--name-only'), 'README.md');
assert.equal(git('diff', '--', 'verify.mjs', 'AGENTS.md', 'package.json'), '');
if (expectedMarker) {
  const currentReadme = readFileSync(`${fixture}/README.md`, 'utf8');
  assert.equal(currentReadme.split(expectedMarker).length - 1, 1);
  assert.equal(currentReadme.replace(expectedMarker, '').trim(),
    git('show', 'HEAD:README.md').replace('STATUS: pending', 'STATUS: verified').trim());
}
const hashes = Object.fromEntries(['verify.mjs', 'AGENTS.md', 'package.json'].map(name => [name,
  createHash('sha256').update(readFileSync(`${fixture}/${name}`)).digest('hex')]));
const setup = JSON.parse(readFileSync('reports/autonomous-audit-20260909/evidence/browser-task-fixture-setup.json', 'utf8'));
assert.deepEqual(hashes, setup.immutable_fixture_hashes);
const log = readFileSync(browserLog, 'utf8');
const browser = JSON.parse(log.split('### Result\n')[1].split('\n### Ran')[0]);
const db = new Database('.data/audit.sqlite', { readonly: true });
try {
  const task = db.prepare('SELECT id,status,repository_id,execution_mode,metadata,started_at,completed_at,token_usage FROM tasks WHERE id=?').get(taskId);
  const metadata = JSON.parse(task.metadata);
  assert.equal(task.status, 'completed');
  assert.equal(metadata.workingDirectory, fixture);
  assert.equal(metadata.executor, 'codex');
  assert.equal(metadata.model, 'gpt-6-astra');
  const events = db.prepare('SELECT id,event_type,timestamp,level,message,tool_name FROM execution_events WHERE task_id=? ORDER BY timestamp').all(taskId);
  const audit = db.prepare('SELECT id,event_type,action,task_id,resource_id,outcome,hash,previous_hash FROM audit_events WHERE task_id=? ORDER BY chain_sequence').all(taskId);
  const evidence = db.prepare('SELECT id,evidence_type,title FROM execution_evidence WHERE task_id=?').all(taskId);
  const frames = browser.frames || [];
  const streamed = frames.filter(frame => frame.type === 'execution.event').map(frame => frame.payload.event);
  const missingLiveTimestamps = streamed.filter(event => !Number.isFinite(Date.parse(event.timestamp)));
  const durableTimes = new Map(events.map(event => [event.id, event.timestamp]));
  const mismatchedLiveTimestamps = streamed.filter(event => event.timestamp !== durableTimes.get(event.id));
  const terminalAudit = audit.filter(event => event.action === 'execution_completed');
  const approvalCount = db.prepare('SELECT count(*) AS count FROM approvals WHERE task_id=?').get(taskId).count;
  const summary = {
    evidence_class: 'actual-local-browser-provider-execution', generated_at: new Date().toISOString(),
    task: { ...task, metadata: { executor: metadata.executor, model: metadata.model,
      reasoningEffort: metadata.reasoningEffort, workingDirectory: metadata.workingDirectory } },
    fixture: { path: fixture, baseline_commit: git('rev-parse', 'HEAD'), diff: git('diff', '--', 'README.md'),
      test_output: testOutput, expected_marker: expectedMarker, unchanged_hashes: hashes },
    browser_log: browserLog, execution_response: browser.responses?.find(row => row.path.endsWith('/execute')),
    websocket: { frame_count: frames.length, execution_event_count: streamed.length,
      completion_received: frames.some(frame => frame.type === 'task.completed'),
      missing_timestamp_count: missingLiveTimestamps.length, mismatched_timestamp_count: mismatchedLiveTimestamps.length },
    events, audit, evidence, approval_count: approvalCount, terminal_audit_count: terminalAudit.length,
    observability_complete: streamed.length > 0 && missingLiveTimestamps.length === 0 && mismatchedLiveTimestamps.length === 0
      && terminalAudit.length === 1 && events.some(event => event.event_type === 'tool.call')
      && !events.some(event => event.message.includes('falling back to heuristic')),
    boundaries: ['local disposable repository only', 'actual Codex/Astra low', 'no merge, push or deployment',
      'policy allowed this task without approval; not an approval/resumption proof',
      'historical first-run defects preserved; no retroactive corrected-runtime claim'],
  };
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ output, task_id: taskId, status: task.status,
    events: events.length, audit: audit.length, terminal_audit: terminalAudit.length,
    streamed_events: streamed.length, missing_live_timestamps: missingLiveTimestamps.length,
    observability_complete: summary.observability_complete }));
} finally { db.close(); }
