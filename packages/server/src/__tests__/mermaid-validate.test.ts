import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { ExplainerMermaidService, MERMAID_VALIDATE_URL, mermaidValidateEvidence, shadowValidateMermaid, validateWithMermaidApi } from '../services/explainer-mermaid-service';
import type { GraphSummary } from '@djimitflo/shared';

// No real API calls: every fetch here is a stub.
const json = (status: number, body: unknown) => vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as typeof fetch;
const VALID = () => json(200, { valid: true, diagramType: 'flowchart-v2' });
const INVALID = () => json(200, { valid: false, error: { code: 'ERR_DIAGRAM_INVALID', message: 'Parse error on line 2', details: { name: 'ParseError', line: 2, column: 5 } } });
const hanging = () => vi.fn((_u: unknown, init: { signal: AbortSignal }) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))) as unknown as typeof fetch;
const SHADOW = { MERMAID_VALIDATE_MODE: 'shadow', MERMAID_API_KEY: 'mmd_test.secret' } as NodeJS.ProcessEnv;
const graph = { total_nodes: 3, total_edges: 2, total_files: 2, communities: [{ name: 'core', language: 'ts', size: 3 }, { name: 'api', language: 'ts', size: 2 }], hub_nodes: [] } as unknown as GraphSummary;

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.exec(schema); runMigrations(db); });
afterEach(() => { db.close(); });
const rows = () => db.prepare(`SELECT * FROM judgments WHERE judgment = 'mermaid_validate'`).all() as Array<Record<string, string>>;

describe('validateWithMermaidApi (fail-open)', () => {
  it('maps valid / invalid and sends the key only as a bearer header', async () => {
    const f = VALID();
    expect(await validateWithMermaidApi('flowchart LR\n  A --> B', 'k1', f)).toEqual({ status: 'valid', code: null, diagram_type: 'flowchart-v2' });
    const [url, init] = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0];
    expect(url).toBe(MERMAID_VALIDATE_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k1');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'flowchart LR\n  A --> B' });
    expect(await validateWithMermaidApi('x', 'k', INVALID())).toEqual({ status: 'invalid', code: 'ERR_DIAGRAM_INVALID', diagram_type: undefined, line: 2, column: 5 });
  });

  it('401 / 402 / 429 / 5xx / timeout / network are unavailable, never invalid', async () => {
    expect(await validateWithMermaidApi('x', 'k', json(401, { error: { code: 'ERR_KEY_UNKNOWN', message: 'no' } }))).toEqual({ status: 'unavailable', code: 'http_401:ERR_KEY_UNKNOWN' });
    expect((await validateWithMermaidApi('x', 'k', json(402, { error: { code: 'ERR_CREDITS_EXHAUSTED', message: 'no' } }))).status).toBe('unavailable');
    expect((await validateWithMermaidApi('x', 'k', json(429, null))).code).toBe('http_429');
    expect((await validateWithMermaidApi('x', 'k', json(503, null))).status).toBe('unavailable');
    expect(await validateWithMermaidApi('x', 'k', hanging(), 20)).toEqual({ status: 'unavailable', code: 'timeout' });
    expect(await validateWithMermaidApi('x', 'k', vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch)).toEqual({ status: 'unavailable', code: 'network' });
  });
});

describe('shadowValidateMermaid', () => {
  it('records one shadow judgment with heuristic vs API verdict and the sha256, never the code', async () => {
    const code = 'flowchart LR\n  A["secret label"] --> B';
    expect(await shadowValidateMermaid(db, { repo: 'djimit/djimitflo', source: code, heuristicValid: true }, SHADOW, INVALID())).toBe('heuristic_pass_api_invalid');
    const [r] = rows();
    expect(r).toMatchObject({ subject_type: 'explainer_diagram', subject_id: 'djimit/djimitflo', mode: 'shadow', decision: 'heuristic_pass_api_invalid', reason: 'ERR_DIAGRAM_INVALID', model: 'mermaid-api' });
    expect(r.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(r.answers_json)).toMatchObject({ heuristic_valid: true, api_valid: false, line: 2, column: 5, diagram_sha256: r.state_hash });
    expect(JSON.stringify(r)).not.toContain('secret label');
    expect(JSON.stringify(r)).not.toContain('mmd_test');
    // same diagram again (critic retry): no second credit
    const again = VALID();
    expect(await shadowValidateMermaid(db, { repo: 'djimit/djimitflo', source: code, heuristicValid: true }, SHADOW, again)).toBeNull();
    expect(again).not.toHaveBeenCalled();
  });

  it('agree / heuristic_fail_api_valid / unavailable decisions', async () => {
    expect(await shadowValidateMermaid(db, { repo: 'djimit/djimitflo', source: 'graph TD\n A', heuristicValid: true }, SHADOW, VALID())).toBe('agree');
    expect(await shadowValidateMermaid(db, { repo: 'djimit/djimitflo', source: 'graph TD\n B', heuristicValid: false }, SHADOW, VALID())).toBe('heuristic_fail_api_valid');
    expect(await shadowValidateMermaid(db, { repo: 'djimit/djimitflo', source: 'graph TD\n C', heuristicValid: true }, SHADOW, json(402, null))).toBe('unavailable');
    expect(await shadowValidateMermaid(db, { repo: 'djimit/djimitflo', source: 'graph TD\n D', heuristicValid: true }, SHADOW, hanging())).toBe('unavailable'); // 5 s timeout
    const ev = mermaidValidateEvidence(db, SHADOW);
    expect(ev.counts).toEqual({ agree: 1, heuristic_pass_api_invalid: 0, heuristic_fail_api_valid: 1, unavailable: 2 });
    expect(ev).toMatchObject({ mode: 'shadow', key_set: true, repos: ['djimit/djimitflo'] });
    expect(JSON.stringify(ev)).not.toContain('mmd_test');
  }, 10_000);

  it('does nothing when off, without a key, or for a repo outside MERMAID_VALIDATE_REPOS', async () => {
    const f = VALID();
    const input = { repo: 'djimit/djimitflo', source: 'graph TD\n A', heuristicValid: true };
    expect(await shadowValidateMermaid(db, input, { MERMAID_API_KEY: 'k' }, f)).toBeNull();
    expect(await shadowValidateMermaid(db, input, { MERMAID_VALIDATE_MODE: 'shadow' }, f)).toBeNull();
    expect(await shadowValidateMermaid(db, { ...input, repo: 'djimit/private-thing' }, SHADOW, f)).toBeNull();
    expect(await shadowValidateMermaid(db, input, { ...SHADOW, MERMAID_VALIDATE_REPOS: 'djimit/other' }, f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(mermaidValidateEvidence(db, {}).mode).toBe('off');
  });
});

describe('ExplainerMermaidService shadow wiring', () => {
  it('off mode: output byte-identical to the plain service, no fetch, no row', async () => {
    const f = VALID();
    const svc = new ExplainerMermaidService({ db, repo: 'djimit/djimitflo', env: {}, fetchFn: f });
    const out = svc.generateArchitectureDiagram(graph);
    expect(JSON.stringify(out)).toBe(JSON.stringify(new ExplainerMermaidService().generateArchitectureDiagram(graph)));
    expect(await svc.lastShadow).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('shadow mode: the heuristic decision is unchanged even when the API disagrees', async () => {
    const svc = new ExplainerMermaidService({ db, repo: 'djimit/djimitflo', env: SHADOW, fetchFn: INVALID() });
    const out = svc.generateArchitectureDiagram(graph);
    expect(out).toEqual(new ExplainerMermaidService().generateArchitectureDiagram(graph));
    expect(out?.valid).toBe(true);
    expect(await svc.lastShadow).toBe('heuristic_pass_api_invalid');
    expect(out?.valid).toBe(true);
  });
});

describe('scripts/mermaid-validate.mjs', () => {
  type Script = {
    extractMermaidBlocks: (t: string) => Array<{ line: number; code: string }>;
    run: (o: { files: string[]; env: NodeJS.ProcessEnv; fetchFn: typeof fetch; log: (s: string) => void; warn: (s: string) => void; maxCalls?: number; timeoutMs?: number }) => Promise<number>;
  };
  const load = async () => (await import('../../../../scripts/mermaid-validate.mjs')) as Script;
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmd-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const doc = (body: string) => { const p = path.join(dir, 'a.md'); fs.writeFileSync(p, body); return p; };
  const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, log: (s: string) => out.push(s), warn: (s: string) => err.push(s) }; };

  it('extracts fenced mermaid blocks with the first code line', async () => {
    const { extractMermaidBlocks } = await load();
    expect(extractMermaidBlocks('# t\n\n```mermaid\ngraph TD\n A-->B\n```\ntext\n~~~mermaid\npie\n~~~\n```js\nx\n```')).toEqual([
      { line: 4, code: 'graph TD\n A-->B' }, { line: 9, code: 'pie' }]);
  });

  it('exit 0 "skipped: no key" without MERMAID_API_KEY; no fetch', async () => {
    const { run } = await load();
    const f = VALID(); const o = io();
    expect(await run({ files: [doc('```mermaid\ngraph TD\n```')], env: {}, fetchFn: f, ...o })).toBe(0);
    expect(o.out.join('\n')).toContain('skipped: no key');
    expect(f).not.toHaveBeenCalled();
  });

  it('exit 1 only on a definite valid:false, with file:line', async () => {
    const { run } = await load();
    const p = doc('intro\n```mermaid\ngraph TD\n  A-->\n```\n');
    const o = io();
    expect(await run({ files: [p], env: { MERMAID_API_KEY: 'k' }, fetchFn: INVALID(), ...o })).toBe(1);
    expect(o.out[0]).toBe(`${p}:4:5: ERR_DIAGRAM_INVALID Parse error on line 2`);
    expect(await run({ files: [p], env: { MERMAID_API_KEY: 'k' }, fetchFn: VALID(), ...io() })).toBe(0);
  });

  it('401 / 402 / timeout → warning, exit 0', async () => {
    const { run } = await load();
    const p = doc('```mermaid\ngraph TD\n```\n```mermaid\npie\n```\n');
    for (const f of [json(401, { error: { code: 'ERR_KEY_UNKNOWN', message: 'x' } }), json(402, null), hanging()]) {
      const o = io();
      expect(await run({ files: [p], env: { MERMAID_API_KEY: 'k' }, fetchFn: f, timeoutMs: 20, ...o })).toBe(0);
      expect(o.err.join('\n')).toMatch(/unavailable/);
      expect(o.out.join('\n') + o.err.join('\n')).not.toContain('Bearer');
    }
  });

  it('caps calls per run and sends an identical block once', async () => {
    const { run } = await load();
    const p = doc(['A', 'A', 'B', 'C'].map((x) => `\`\`\`mermaid\ngraph TD\n ${x}\n\`\`\``).join('\n'));
    const f = VALID(); const o = io();
    expect(await run({ files: [p], env: { MERMAID_API_KEY: 'k' }, fetchFn: f, maxCalls: 2, ...o })).toBe(0);
    expect(f).toHaveBeenCalledTimes(2);
    expect(o.err.join('\n')).toContain('call cap 2 reached, 1 block(s) not checked');
  });
});

it('GET /api/health/mermaid-validate needs auth and returns the readout without the key', async () => {
  const { default: express } = await import('express');
  const { rateLimit } = await import('express-rate-limit');
  const { default: request } = await import('supertest');
  const { UserRole } = await import('@djimitflo/shared');
  const { createTestDb } = await import('./helpers/test-db');
  const { createAuthMiddleware } = await import('../middleware/auth');
  const { AuthService } = await import('../services/auth-service');
  const { createHealthRoutes } = await import('../routes/health');
  const tdb = createTestDb();
  const authService = new AuthService(tdb);
  const viewer = authService.generateToken(authService.createUser('mmd-viewer@example.test', 'disposable-password', UserRole.VIEWER));
  const app = express().use(rateLimit({ windowMs: 60_000, limit: 600 })).use('/api/health', createHealthRoutes(tdb, createAuthMiddleware(authService)));
  expect((await request(app).get('/api/health/mermaid-validate')).status).toBe(401);
  const res = await request(app).get('/api/health/mermaid-validate').set('Authorization', `Bearer ${viewer}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ window_days: 30, counts: null }); // no judgments table in the auth test db: fail-soft null
  tdb.exec(`CREATE TABLE judgments (id TEXT PRIMARY KEY, judgment TEXT, decision TEXT, created_at TEXT)`);
  tdb.prepare(`INSERT INTO judgments VALUES ('j1', 'mermaid_validate', 'agree', ?)`).run(new Date().toISOString());
  const after = await request(app).get('/api/health/mermaid-validate').set('Authorization', `Bearer ${viewer}`);
  expect(after.body.counts).toEqual({ agree: 1, heuristic_pass_api_invalid: 0, heuristic_fail_api_valid: 0, unavailable: 0 });
  expect(JSON.stringify(after.body)).not.toMatch(/MERMAID_API_KEY|mmd_/);
  tdb.close();
});
