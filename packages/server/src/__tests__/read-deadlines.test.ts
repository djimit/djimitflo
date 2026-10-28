/**
 * Forensic audit 2026-10-26 rank 7 (CODE-004): every outbound effect read on a request or tick path carries a
 * deadline, so a hung downstream ends instead of pinning the caller forever.
 *
 * - a source guard: every fetch()/fetchImpl()/fetcher() call in the server and MCP server passes an AbortSignal
 * - hung loopback servers (accept the request, never answer): the caller settles with an explicit timeout
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import type * as TS from 'typescript';
import { MemorySyncService } from '../services/memory-sync-service';
import { OIDCAbstraction } from '../services/oidc-provider';

const PACKAGES = path.resolve(__dirname, '../../..');
// The workspace packages build with TypeScript 7 (native, no JS compiler API); the root devDependency (6.x) still
// ships the parser, so resolve it from the repository root.
const ts = createRequire(path.join(PACKAGES, '../package.json'))('typescript') as typeof TS;
const ROOTS = [path.join(PACKAGES, 'server/src'), path.join(PACKAGES, 'mcp-server/src')];
// fetch-shaped callees; `arxiv.fetch(id)` / technique-card `fetcher(ref)` are adapters, not HTTP calls.
const FETCH_CALLEE = /^(globalThis\.)?fetch$|^(this\.)?(fetchImpl|fetchFn)$|^this\.fetcher$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '__tests__' && entry.name !== 'node_modules') sourceFiles(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function fetchCallsWithoutDeadline(): string[] {
  const missing: string[] = [];
  for (const file of ROOTS.flatMap((r) => sourceFiles(r))) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: TS.Node): void => {
      if (ts.isCallExpression(node) && FETCH_CALLEE.test(node.expression.getText(sf))) {
        const init = node.arguments[1];
        // a forwarded init (wrapper such as nvidiaFetch/ollama-balance) is checked at its own call sites
        const ok = init && (!ts.isObjectLiteralExpression(init)
          || init.properties.some((p) => ts.isSpreadAssignment(p) || p.name?.getText(sf) === 'signal'));
        if (!ok) missing.push(`${path.relative(PACKAGES, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return missing;
}

/** Accepts every request and never answers: the hung downstream. */
async function hungServer(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = http.createServer((req) => { hits.push(`${req.method} ${req.url}`); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// Shrink every AbortSignal.timeout deadline so a hung read settles in test time; a call without a signal still hangs.
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
beforeEach(() => { vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(50)); });
afterEach(() => { vi.restoreAllMocks(); });

describe('outbound read deadlines (CODE-004)', () => {
  it('every fetch call in server and mcp-server carries an AbortSignal', () => {
    expect(fetchCallsWithoutDeadline()).toEqual([]);
  });

  describe('memory fan-out against hung UAMS / Ollama / Qdrant', () => {
    let tmpOkf: string;
    const env = ['UAMS_URL', 'QDRANT_URL', 'QDRANT_WRITE_URL', 'OLLAMA_URL', 'OKF_BASE'] as const;
    beforeEach(() => { tmpOkf = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-deadline-')); process.env.OKF_BASE = tmpOkf; });
    afterEach(() => { for (const k of env) delete process.env[k]; fs.rmSync(tmpOkf, { recursive: true, force: true }); });

    const db = {
      prepare: (sql: string) => ({
        get: () => (sql.includes('FROM tasks')
          ? { id: 'task-hung', title: 'T', description: 'do the thing', status: 'completed', created_by: 'm', created_at: 'x' }
          : null),
      }),
    } as any;

    it('settles within budget and does not re-send a timed-out UAMS write (outcome unknown)', async () => {
      const hung = await hungServer();
      process.env.UAMS_URL = hung.url;
      process.env.OLLAMA_URL = hung.url;
      process.env.QDRANT_URL = hung.url;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const started = Date.now();
        await new MemorySyncService(db).onTaskCompleted('task-hung');
        expect(Date.now() - started).toBeLessThan(5_000);
        // one POST: a timed-out write may have landed, so it is not blindly retried
        expect(hung.hits.filter((h) => h === 'POST /memory/entry')).toHaveLength(1);
        const messages = warn.mock.calls.map((c) => c.map(String).join(' '));
        expect(messages.some((m) => /UAMS sync for task task-hung timed out.*outcome unknown/.test(m))).toBe(true);
      } finally {
        await hung.close();
      }
    }, 10_000);

    it('ends a hung Qdrant upsert', async () => {
      const hung = await hungServer();
      process.env.QDRANT_URL = hung.url;
      process.env.UAMS_URL = 'http://127.0.0.1:9'; // refused fast
      const realFetch = globalThis.fetch;
      // embedding and collection check answer; only the point upsert hangs
      vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
        if (url.includes('/api/embed')) return Promise.resolve(new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] })));
        if (url.endsWith('/collections/djimitflo_swarm') && !init?.method) {
          return Promise.resolve(new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 3 } } } } })));
        }
        return realFetch(url, init);
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await new MemorySyncService(db).onTaskCompleted('task-hung');
        expect(hung.hits).toContain('PUT /collections/djimitflo_swarm/points');
        expect(warn.mock.calls.some((c) => String(c[0]).includes('Qdrant sync error for task task-hung'))).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        await hung.close();
      }
    }, 10_000);
  });

  it('OIDC userinfo and JWKS reads on the login path end against a hung IdP', async () => {
    const hung = await hungServer();
    const oidc = new OIDCAbstraction({
      provider_name: 'hung', issuer_url: hung.url, client_id: 'c', redirect_uri: 'http://localhost/cb', scopes: ['openid'],
      authorization_endpoint: `${hung.url}/auth`, token_endpoint: `${hung.url}/token`,
      userinfo_endpoint: `${hung.url}/userinfo`, jwks_uri: `${hung.url}/jwks`, response_type: 'code', pkce_enabled: false,
    });
    try {
      await expect(oidc.getUserInfo('token')).rejects.toThrow();
      await expect(oidc.validateIdToken('a.b.c')).rejects.toThrow();
    } finally {
      await hung.close();
    }
  }, 10_000);
});
