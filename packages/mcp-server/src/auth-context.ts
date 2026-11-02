import { AsyncLocalStorage } from 'async_hooks';
import { ROLE_PERMISSIONS, type AuthTokenPayload } from '@djimitflo/shared';

export interface McpAuthContext {
  payload: AuthTokenPayload;
  token: string;
}

const storage = new AsyncLocalStorage<McpAuthContext>();

export function runWithMcpAuth<T>(context: McpAuthContext, work: () => T): T {
  return storage.run(context, work);
}

export function currentMcpAuth(): McpAuthContext {
  const context = storage.getStore();
  if (!context) throw new Error('MCP_AUTH_CONTEXT_REQUIRED');
  return context;
}

/**
 * The caller's role must carry `permission` (same table as the HTTP API). MCP tools that write must ask for the
 * permission of their HTTP route twin, so the MCP surface is never a wider door than the API.
 */
export function requireMcpPermission(permission: string): AuthTokenPayload {
  const principal = currentMcpAuth().payload;
  if (!ROLE_PERMISSIONS[principal.role]?.includes(permission)) throw new Error(`MCP_PERMISSION_DENIED: ${permission}`);
  return principal;
}
