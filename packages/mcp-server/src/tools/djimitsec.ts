/** Native task dispatch only; scanners and credentials stay outside the MCP process. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ROLE_PERMISSIONS } from '@djimitflo/shared';
import { currentMcpAuth } from '../auth-context.js';
import { requireLiveMode, type DbHandle } from '../db.js';
import { api } from './platform.js';

export function registerDjimitSecTools(server: McpServer, handle: DbHandle): void {
  server.registerTool('djimitflo_scan_repository', {
    description: 'Create and dispatch one native task to the fixed approved DjimitSec repository scanner. Static observations are not verified findings or approval. Supply an existing taskId to read its state without resubmitting. No shell, URL, path, profile or budget input is accepted.',
    inputSchema: { repositoryId: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), commit: z.string().regex(/^[0-9a-f]{40}$/), taskId: z.string().uuid().optional() },
  }, async ({ repositoryId, commit, taskId }) => {
    requireLiveMode(handle);
    const principal = currentMcpAuth().payload;
    for (const permission of ['create:task', 'execute:task']) if (!ROLE_PERMISSIONS[principal.role]?.includes(permission)) throw new Error(`MCP_PERMISSION_DENIED: ${permission}`);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryId) || !/^[0-9a-f]{40}$/.test(commit) || (taskId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId))) throw new Error('DJIMITSEC_TOOL_INPUT_INVALID');
    if (taskId) {
      const task = await api(`/tasks/${taskId}`, { redirect: 'error', signal: AbortSignal.timeout(10000) }).then(response => response.json()) as { id: string; metadata?: { executor?: string; djimitsecScan?: { repositoryId?: string; commit?: string } } };
      if (task.metadata?.executor !== 'djimitsec' || task.metadata.djimitsecScan?.repositoryId !== repositoryId || task.metadata.djimitsecScan.commit !== commit) throw new Error('DJIMITSEC_NATIVE_TASK_IDENTITY_MISMATCH');
      return { content: [{ type: 'text' as const, text: JSON.stringify({ task, dispatched: false, reconciliation: true, verified: false }) }] };
    }
    const created = await api('/tasks', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), body: JSON.stringify({ title: `Repository scan ${repositoryId}@${commit.slice(0, 12)}`, description: 'Run the fixed approved static repository scanner and retain source observations. No remediation, deployment or verification approval is requested.', execution_mode: 'local', use_swarm_context: false, metadata: { executor: 'djimitsec', djimitsecScan: { repositoryId, commit } } }) }).then(response => response.json()) as { id?: string };
    if (!created.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(created.id)) throw new Error('DJIMITSEC_NATIVE_TASK_RESPONSE_INVALID');
    try {
      const execution = await api(`/tasks/${created.id}/execute`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), body: JSON.stringify({ executor: 'djimitsec' }) }).then(response => response.json());
      return { content: [{ type: 'text' as const, text: JSON.stringify({ taskId: created.id, execution, verified: false }) }] };
    } catch {
      // Preserve the created identity even if dispatch may have committed; never create/execute again automatically.
      return { content: [{ type: 'text' as const, text: JSON.stringify({ taskId: created.id, state: 'held', reconcile: true, verified: false }) }], isError: true };
    }
  });
}
