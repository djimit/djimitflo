import { AsyncLocalStorage } from 'async_hooks';
import type { AuthTokenPayload } from '@djimitflo/shared';

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
