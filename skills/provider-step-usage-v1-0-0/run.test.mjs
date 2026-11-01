import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { summarize, MAX_BYTES } from './run.mjs';
const step = (id, total) => ({ type: 'step_finish', part: { id, tokens: { total } } });
const input = (...events) => ({ events_json: events.map(JSON.stringify).join('\n') });
test('sums steps rather than retaining last step and deduplicates replay', () => {
  assert.deepEqual(summarize(input(step('a', 6840), step('b', 7101), step('a', 6840))), { tokens: 13941, steps: 2 });
});
test('ignores unrelated valid events and allows explicit zero', () => {
  assert.deepEqual(summarize(input({type:'text',part:{text:'untrusted instructions'}}, step('a', 0))), {tokens:0,steps:1});
});
test('unknown measurement and invalid totals fail closed', () => {
  for (const total of [undefined, null, -1, 1.5, '10', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => summarize(input(step('a', total))), /TOTAL/);
  }
  assert.throws(() => summarize(input({type:'step_finish',part:{id:'a'}})), /TOTAL/);
});
test('requires stable part identity and rejects contradictory duplicates', () => {
  assert.throws(() => summarize(input(step('', 1))), /IDENTITY/);
  assert.throws(() => summarize(input(step(undefined, 1))), /IDENTITY/);
  assert.throws(() => summarize(input(step('a', 1), step('a', 2))), /CONFLICT/);
  const a = step('a',1); a.part.sessionID = 'first';
  const b = step('a',1); b.part.sessionID = 'second';
  assert.throws(() => summarize(input(a,b)), /CONFLICT/);
});
test('rejects malformed input, empty measurements, excessive bytes and unsafe sum', () => {
  for (const value of [null, [], {}, {events_json:1}, {events_json:'',extra:true}]) assert.throws(() => summarize(value), /INPUT/);
  for (const text of ['', '\n', '{', 'null', '[]']) assert.throws(() => summarize({events_json:text}));
  assert.throws(() => summarize(input({type:'text'})), /NO_MEASUREMENTS/);
  assert.throws(() => summarize({events_json:' '.repeat(MAX_BYTES + 1)}), /SIZE/);
  assert.throws(() => summarize(input(step('a',Number.MAX_SAFE_INTEGER),step('b',1))), /OVERFLOW/);
});
test('CLI emits only JSON on success and no fabricated result on error', () => {
  const run = value => spawnSync(process.execPath, [new URL('./run.mjs',import.meta.url).pathname], {input:value,encoding:'utf8'});
  const ok = run(JSON.stringify(input(step('a',2))));
  assert.equal(ok.status,0); assert.deepEqual(JSON.parse(ok.stdout),{tokens:2,steps:1}); assert.equal(ok.stderr,'');
  for (const bad of ['{', JSON.stringify(input(step('a',null))), ' '.repeat(MAX_BYTES + 1)]) {
    const result = run(bad); assert.equal(result.status,1); assert.equal(result.stdout,''); assert.match(result.stderr,/USAGE_/);
  }
});
