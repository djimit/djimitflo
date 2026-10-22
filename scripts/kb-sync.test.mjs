// kb-sync.mjs against a fake Djimitflo: a page the server reports 'pending' (no safety verdict) is re-sent, bounded per run.
// Run: node scripts/kb-sync.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SYNC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kb-sync.mjs');

/** A fake server: `pendingPaths` is what GET /kb/pending knows; POSTed pages in `stillPending` come back pending. */
async function fakeServer({ pendingPaths = [], stillPending = new Set() } = {}) {
  const posted = []; const asked = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/api/gym-worker/kb/pending') {
      const limit = Number(u.searchParams.get('limit'));
      asked.push(limit);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ pending: pendingPaths.slice(0, limit), total: pendingPaths.length }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const pages = JSON.parse(body).pages.map((p) => p.path);
      posted.push(pages);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ accepted: pages.filter((p) => !stillPending.has(p)), pending: pages.filter((p) => stillPending.has(p)), unsafe: [], failed: [] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, posted, asked, close: () => new Promise((r) => server.close(r)) };
}

function workspace(n) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sync-'));
  const wiki = path.join(home, 'wiki');
  fs.mkdirSync(path.join(wiki, 'concepts'), { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(wiki, 'concepts', `p${String(i).padStart(3, '0')}.md`), `# Page ${i}\n\nbody ${i}\n`);
  fs.mkdirSync(path.join(home, '.djimit'));
  fs.writeFileSync(path.join(home, '.djimit', 'gym-worker.token'), 'tok\n');
  return { home, wiki, state: path.join(home, '.djimit', 'kb-sync.state.json') };
}

const run = (ws, url, args = []) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [SYNC, ...args], { env: { ...process.env, HOME: ws.home, KB_ROOT: ws.wiki, KB_DIRS: 'concepts', DJIMITFLO_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`))));
});
const readState = (ws) => JSON.parse(fs.readFileSync(ws.state, 'utf8'));

test('a page answered pending is not marked done and is re-sent next run; once accepted it is not sent again', async () => {
  const ws = workspace(2);
  const s = await fakeServer({ stillPending: new Set(['concepts/p001.md']) });
  try {
    await run(ws, s.url);
    assert.deepEqual(s.posted, [['concepts/p000.md', 'concepts/p001.md']]);
    assert.match(readState(ws)['concepts/p001.md'], /^pending:[0-9a-f]{64}$/);
    assert.match(readState(ws)['concepts/p000.md'], /^[0-9a-f]{64}$/);
    s.posted.length = 0; await run(ws, s.url);
    assert.deepEqual(s.posted, [['concepts/p001.md']], 'only the pending page is re-sent');
    s.posted.length = 0; await run(ws, s.url);
    assert.deepEqual(s.posted, [['concepts/p001.md']], 'still pending: re-sent again');
  } finally { await s.close(); }
  const s2 = await fakeServer();
  try {
    await run(ws, s2.url);
    assert.deepEqual(s2.posted, [['concepts/p001.md']]);
    s2.posted.length = 0; await run(ws, s2.url);
    assert.deepEqual(s2.posted, [], 'accepted: done');
  } finally { await s2.close(); }
});

test('backfill: pages already marked done locally but unverdicted on the server are re-sent, at most --pending-max (default 50) per run', async () => {
  const ws = workspace(70);
  const s0 = await fakeServer();
  try { await run(ws, s0.url); } finally { await s0.close(); } // all 70 accepted and marked done (the pre-fix state of prod's 456)
  const unverdicted = Array.from({ length: 60 }, (_, i) => `concepts/p${String(i).padStart(3, '0')}.md`);
  const s = await fakeServer({ pendingPaths: unverdicted, stillPending: new Set(unverdicted) });
  try {
    await run(ws, s.url);
    assert.deepEqual(s.asked, [50], 'asks the server for at most 50');
    assert.equal(s.posted.flat().length, 50, 'bounded: 50 re-sends, not 60');
    assert.ok(s.posted.every((b) => b.length <= 10), 'batches of 10');
    // next run: 50 are locally pending now, the server still reports all 60 → still at most 50 re-sends
    s.posted.length = 0; await run(ws, s.url);
    assert.equal(s.posted.flat().length, 50);
    s.posted.length = 0; s.asked.length = 0; await run(ws, s.url, ['--pending-max', '5']);
    assert.deepEqual(s.asked, [5]);
    assert.equal(s.posted.flat().length, 5);
  } finally { await s.close(); }
});

test('a server without /kb/pending (old build) still syncs', async () => {
  const ws = workspace(3);
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') { res.statusCode = 404; res.end('{}'); return; }
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { const pages = JSON.parse(body).pages.map((p) => p.path); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ accepted: pages, unsafe: [], failed: [] })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const out = await run(ws, `http://127.0.0.1:${server.address().port}`);
    assert.match(out, /sent 3:/);
    assert.equal(Object.keys(readState(ws)).length, 3);
  } finally { await new Promise((r) => server.close(r)); }
});
