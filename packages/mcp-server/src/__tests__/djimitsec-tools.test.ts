import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { UserRole } from '@djimitflo/shared';
import { registerDjimitSecTools } from '../tools/djimitsec.js';
import { runWithMcpAuth } from '../auth-context.js';
import type { DbHandle } from '../db.js';

let handle: DbHandle;
let tool: { handler: (input: { repositoryId: string; commit: string; taskId?: string }) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
const taskId = '0040b22b-86d1-488d-bcd3-5def1bc09bca', repositoryId = 'owned/fixture', commit = 'a'.repeat(40);
const authenticated = (input = { repositoryId, commit }, role = UserRole.MAKER) => runWithMcpAuth({ payload: { sub: 'fixture-maker', email: 'fixture@test', role, iat: 1, exp: 9999999999 }, token: 'fixture-token' }, () => tool.handler(input));
beforeEach(() => {
  const db = new Database(':memory:'); db.exec("CREATE TABLE system_state(key TEXT PRIMARY KEY,value TEXT); INSERT INTO system_state VALUES('database_instance_id','test-instance');");
  handle = { db, mode: 'live', close: () => db.close() };
  const server = new McpServer({ name: 'scan-fixture', version: '1' }); registerDjimitSecTools(server, handle);
  tool = (server as unknown as { _registeredTools: Record<string, typeof tool> })._registeredTools.djimitflo_scan_repository;
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); handle.close(); });
it('uses canonical authenticated native task create/execute and never accepts caller executable controls', async () => {
  const requests: Array<{ url: string; options: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => { requests.push({ url, options }); return Response.json(requests.length === 1 ? { id: taskId } : { status: 'started' }); }));
  const result = JSON.parse((await authenticated()).content[0].text);
  expect(result).toEqual({ taskId, execution: { status: 'started' }, verified: false });
  expect(requests.map(row => new URL(row.url).pathname)).toEqual(['/api/tasks', `/api/tasks/${taskId}/execute`]);
  const created = JSON.parse(String(requests[0].options.body));
  expect(created).toMatchObject({ use_swarm_context: false, metadata: { executor: 'djimitsec', djimitsecScan: { repositoryId, commit } } });
  expect(Object.keys(created.metadata)).toEqual(['executor', 'djimitsecScan']);
  expect(requests[0].options.headers).toMatchObject({ authorization: 'Bearer fixture-token' });
});
it('retains created task identity when dispatch is ambiguous and readback never resubmits', async () => {
  const send = vi.fn().mockResolvedValueOnce(Response.json({ id: taskId })).mockRejectedValueOnce(new Error('transport lost'));
  vi.stubGlobal('fetch', send);
  const result = await authenticated();
  expect(result.isError).toBe(true); expect(JSON.parse(result.content[0].text)).toEqual({ taskId, state: 'held', reconcile: true, verified: false });
  expect(send).toHaveBeenCalledTimes(2);
  send.mockReset().mockResolvedValueOnce(Response.json({ id: taskId, metadata: { executor: 'djimitsec', djimitsecScan: { repositoryId, commit } } }));
  const readback = await runWithMcpAuth({ payload: { sub: 'fixture-maker', email: 'fixture@test', role: UserRole.MAKER, iat: 1, exp: 9999999999 }, token: 'fixture-token' }, () => tool.handler({ taskId, repositoryId, commit }));
  expect(JSON.parse(readback.content[0].text)).toMatchObject({ dispatched: false, reconciliation: true, verified: false });
  expect(send).toHaveBeenCalledTimes(1);
});
it('preserves anonymous/viewer/snapshot boundaries before HTTP dispatch', async () => {
  const send = vi.fn(); vi.stubGlobal('fetch', send);
  await expect(tool.handler({ repositoryId, commit })).rejects.toThrow('MCP_AUTH_CONTEXT_REQUIRED');
  await expect(authenticated({ repositoryId, commit }, UserRole.VIEWER)).rejects.toThrow('MCP_PERMISSION_DENIED');
  handle.mode = 'snapshot'; await expect(authenticated()).rejects.toThrow('DJIMITFLO_LIVE_DATA_REQUIRED');
  expect(send).not.toHaveBeenCalled();
});
