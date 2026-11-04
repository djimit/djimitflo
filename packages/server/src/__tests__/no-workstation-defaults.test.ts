import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * M2d (E-A23, prod 10-10 → 10-23: 8 refused hourly buckets to 192.168.1.28): the control plane never calls the workstation,
 * so no source default may point at it. Unset env = the feature is off / unavailable, never a workstation call.
 */
const DENIED = ['192.168.1.28', '100.81.133.48'];
// Not a request target: catalog rows marked known_unreachable (routes/mcp.ts never probes them) and the OKF link label
// pinned byte-for-byte by memory-sync-off-pinned.test.ts.
const EXEMPT: Array<[string, RegExp]> = [
  ['server/src/database/seed-mcp-servers.ts', /\.\.\.workstationOnly/],
  ['server/src/services/memory-sync-service.ts', /^\s*`resource: http:\/\/192\.168\.1\.28:3001\/api\/tasks\//],
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['__tests__', 'node_modules', 'dist', 'fixtures'].includes(e.name)) sourceFiles(p, out); }
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); vi.resetModules(); });

it('M2d: no source default (or any other literal) in packages/*/src names a denied workstation host', () => {
  const packages = path.resolve(__dirname, '../../..');
  const hits: string[] = [];
  for (const pkg of fs.readdirSync(packages)) {
    const src = path.join(packages, pkg, 'src');
    if (!fs.existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const rel = path.relative(packages, file);
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!DENIED.some((h) => line.includes(h))) return;
        if (EXEMPT.some(([f, re]) => f === rel && re.test(line))) return;
        hits.push(`${rel}:${i + 1}`);
      });
    }
  }
  expect(hits).toEqual([]);
});

it('M2d: skill acquisition without DEERFLOW_URL is unavailable and makes no request', async () => {
  delete process.env.DEERFLOW_URL;
  process.env.OKF_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'm2d-okf-'));
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  const { SkillService } = await import('../services/skill-service');
  const db = new Database(':memory:');
  const r = await new SkillService(db).acquire('vector search');
  expect(r).toMatchObject({ status: 'failed', error: 'DEERFLOW_URL_UNSET' });
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('M2d: the LLM router marks ollama/litellm offline without OLLAMA_URL/LITELLM_URL and never probes them', async () => {
  delete process.env.OLLAMA_URL; delete process.env.LITELLM_URL;
  process.env.LITELLM_API_KEY = 'k';
  const fetchSpy = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchSpy);
  const { LlmRouterService } = await import('../services/llm-router-service');
  const health = await new LlmRouterService(new Database(':memory:')).refreshProviderHealth();
  for (const name of ['ollama', 'litellm']) expect(health.find((p) => p.name === name)).toMatchObject({ status: 'offline', available: false });
  expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith('https://'))).toEqual([]);
});
