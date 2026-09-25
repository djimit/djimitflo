import assert from 'node:assert/strict';
import { probeContext7 } from './integration-probes.mjs';

const originalFetch = globalThis.fetch;
try {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 'djimitflo-assurance-discover',
      result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const pass = await probeContext7('https://context7.example.test/mcp');
  assert.equal(pass.status, 'pass');
  assert.equal(request.url, 'https://context7.example.test/mcp');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['MCP-Protocol-Version'], '2026-07-28');
  assert.equal(request.options.headers['Mcp-Method'], 'server/discover');
  assert.equal(request.body.method, 'server/discover');

  globalThis.fetch = async () => new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 'djimitflo-assurance-discover',
    result: { supportedVersions: ['2025-11-25'], capabilities: { tools: {} } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const mismatch = await probeContext7('https://context7.example.test/mcp');
  assert.equal(mismatch.status, 'fail');
  assert.equal(mismatch.reason, 'MCP discovery contract mismatch');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Context7 MCP discovery probe validates negotiated protocol and capabilities: pass');
