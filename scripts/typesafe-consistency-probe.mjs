#!/usr/bin/env node
// Self-consistency probe (docs.typesafe.ai cookbook "consistency_noul"): ask the same typed questions K times per sample and
// report, per question, the mean probability and standard deviation, so unstable judgments are visible BEFORE anything acts on them.
// Usage: TYPESAFE_API_KEY=... node scripts/typesafe-consistency-probe.mjs samples.json [K=10]
// samples.json: { "questions": { "<id>": { "type": "noul", "instructions": "..." } }, "samples": [ { "id": "...", "state": {...}, "label": "optional" } ] }
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const [file, kArg] = process.argv.slice(2);
if (!file || !process.env.TYPESAFE_API_KEY) { console.error('usage: TYPESAFE_API_KEY=... node typesafe-consistency-probe.mjs samples.json [K]'); process.exit(2); }
const K = Number(kArg) || 10;
const { questions, samples } = JSON.parse(readFileSync(file, 'utf8'));
const model = process.env.TYPESAFE_MODEL || 'jev-1.13.0';
const base = (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');

const stats = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return { mean: m, sd: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) }; };
let tokens = 0; let calls = 0; let ms = 0;
const rows = [];
for (const sample of samples) {
  const per = Object.fromEntries(Object.keys(questions).map((q) => [q, []]));
  for (let i = 0; i < K; i += 1) {
    const started = Date.now();
    // a throwaway uid defeats any caching so repeats are real independent calls (as in the cookbook)
    const res = await fetch(`${base}/v1/systemone`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify({ state: { uid: randomBytes(4).toString('hex'), ...sample.state }, model, questions }) });
    if (!res.ok) { console.error(`sample ${sample.id}: HTTP ${res.status}`); continue; }
    const j = await res.json(); calls += 1; ms += Date.now() - started; tokens += j.usage?.input_tokens ?? 0;
    for (const q of Object.keys(questions)) { const a = j.answers[q]; const p = a?.noul ?? a?.score; if (typeof p === 'number') per[q].push(p); }
  }
  for (const [q, xs] of Object.entries(per)) if (xs.length) rows.push({ sample: sample.id, label: sample.label ?? '', question: q, ...stats(xs) });
}
console.table(rows.map((r) => ({ sample: r.sample, label: r.label, question: r.question, mean: r.mean.toFixed(2), sd: r.sd.toFixed(3) })));
const sds = rows.map((r) => r.sd);
console.log(`calls=${calls} mean latency=${Math.round(ms / Math.max(calls, 1))} ms input tokens=${tokens} (~$${(tokens * 0.042 / 1e6).toFixed(5)}) mean sd=${(sds.reduce((a, b) => a + b, 0) / Math.max(sds.length, 1)).toFixed(4)} max sd=${Math.max(0, ...sds).toFixed(3)}`);
