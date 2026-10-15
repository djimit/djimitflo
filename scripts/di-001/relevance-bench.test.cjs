// node --test scripts/di-001/relevance-bench.test.cjs — L2 first-pass scoring vs re-label consistency (PREREG amendment 2)
const test = require('node:test');
const assert = require('node:assert');
const { parseL2, verifyRef, consistency, cohenKappa } = require('./relevance-bench.cjs');

const row = (ref, pass, label, at, extra = {}) => ({ subject_id: ref, decision: { relevant: 'yes', not_relevant: 'no', unclear: 'unclear' }[label],
  created_at: at, answers_json: JSON.stringify({ label, pass, sample: 'protected', actor: 'op@x', seconds: 30, ...extra }) });

test('a later blind re-label never overwrites the first label', () => {
  const l2 = parseL2([row('arxiv:1', 'first', 'not_relevant', '2026-10-15T08:00:00Z'), row('arxiv:1', 'relabel', 'relevant', '2026-10-23T08:00:00Z')]);
  assert.strictEqual(l2.first.get('arxiv:1').value, 'negative');
  assert.strictEqual(l2.relabel.get('arxiv:1').value, 'positive');
  const v = verifyRef({ l2First: l2.first.get('arxiv:1') });
  assert.deepStrictEqual([v.label, v.source, v.use], ['negative', 'L2', 'evaluation']);
});

test('only pass=first scores; a relabel alone is not a label; rows without a pass are ignored', () => {
  const l2 = parseL2([row('arxiv:2', 'relabel', 'relevant', '2026-10-23T08:00:00Z'),
    { subject_id: 'arxiv:3', decision: 'yes', created_at: '2026-10-15T08:00:00Z', answers_json: '{}' }]);
  assert.strictEqual(l2.first.size, 0);
  assert.deepStrictEqual(l2.ignored, ['arxiv:3']);
  assert.strictEqual(verifyRef({ l2First: l2.first.get('arxiv:2') || null }).label, 'unlabelled');
  assert.deepStrictEqual(consistency(l2.first, l2.relabel).relabels_without_first, ['arxiv:2']);
});

test('the earliest first-pass row wins; AL labels are training-only; first-pass L2 beats L1', () => {
  const l2 = parseL2([row('arxiv:4', 'first', 'relevant', '2026-10-15T08:00:00Z'), row('arxiv:4', 'first', 'not_relevant', '2026-10-16T08:00:00Z'),
    row('arxiv:5', 'first', 'relevant', '2026-10-15T09:00:00Z', { sample: 'al' })]);
  assert.strictEqual(l2.first.get('arxiv:4').value, 'positive');
  assert.strictEqual(verifyRef({ l2First: l2.first.get('arxiv:5') }).use, 'training');
  const v = verifyRef({ l1Event: { to_state: 'REJECTED', created_at: '2026-10-01 10:00:00' }, l2First: l2.first.get('arxiv:4') });
  assert.deepStrictEqual([v.label, v.source], ['positive', 'L2']);
  assert.strictEqual(verifyRef({ l2First: parseL2([row('arxiv:6', 'first', 'unclear', 't')]).first.get('arxiv:6') }).label, 'unclear');
});

test('re-label pairs: same actor is intra-annotator consistency, different actors inter-annotator agreement', () => {
  const rows = [];
  const pairs = [['relevant', 'relevant'], ['relevant', 'not_relevant'], ['not_relevant', 'not_relevant'], ['not_relevant', 'not_relevant'], ['relevant', 'relevant']];
  pairs.forEach(([a, b], i) => { rows.push(row(`arxiv:1${i}`, 'first', a, `2026-10-15T0${i}:00:00Z`)); rows.push(row(`arxiv:1${i}`, 'relabel', b, `2026-10-23T0${i}:00:00Z`)); });
  rows.push(row('arxiv:99', 'first', 'relevant', '2026-10-15T09:00:00Z'), row('arxiv:99', 'relabel', 'relevant', '2026-10-23T09:00:00Z', { actor: 'second@x' }));
  const l2 = parseL2(rows); const c = consistency(l2.first, l2.relabel);
  assert.strictEqual(c.intra_annotator_consistency.n, 5);
  assert.strictEqual(c.intra_annotator_consistency.raw_agreement.k, 4);
  assert.strictEqual(c.intra_annotator_consistency.kappa, +cohenKappa(pairs).toFixed(4));
  assert.strictEqual(c.inter_annotator_agreement.n, 1);
  assert.strictEqual(c.annotator_unknown.n, 0);
  assert.match(c.note, /not inter-annotator/);
  // first labels stay as scored labels
  assert.strictEqual(l2.first.get('arxiv:11').value, 'positive');
});

test('cohenKappa: perfect agreement 1, chance-level 0', () => {
  assert.strictEqual(cohenKappa([['positive', 'positive'], ['negative', 'negative']]), 1);
  assert.strictEqual(cohenKappa([['positive', 'positive'], ['positive', 'negative'], ['negative', 'positive'], ['negative', 'negative']]), 0);
});
