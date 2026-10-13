import { useAuthStore } from './auth-store';

/**
 * UX-4: the permission the server checks for each operator action and page, in one place, so the UI hides or disables
 * what the role cannot do instead of showing a button that ends in a 403. Mirrors the server routes (the test pins them);
 * the server stays the authority — this only changes what is shown.
 */
export const ACTION_PERMISSIONS = {
  approveRequest: 'approve:task', // POST /approvals/:id/approve|deny
  fleetCommandDecide: 'approve:task', // POST /fleet-hosts/commands/:id/approve|deny
  fleetCommandRequest: 'manage:config', // POST /fleet-hosts/commands
  requeueProposal: 'write:governance', // POST /self-improve/proposals/:id/requeue
  labelPrescreen: 'write:governance', // POST /self-improve/proposals/:id/prescreen-label
  dismissRequeue: 'write:governance', // POST /self-improve/proposals/:id/requeue-dismiss
  auditAttribution: 'write:governance', // POST /self-improve/attribution-audit/:runId
  memoryReview: 'approve:task', // POST /swarms/memory/candidates/:id/promote|reject
  telegramIdentity: 'manage:config', // PUT|DELETE /self-improve/telegram-identities/:id
  mcpCreateServer: 'manage:config', // POST /mcp/servers
  policyUpdate: 'manage:config', // PATCH /policies/:id
  runtimeConfig: 'manage:config', // GET /health/config
} as const;

/** Nav entries whose page's main endpoint needs more than a login + read:evidence. */
export const NAV_PERMISSIONS: Record<string, string> = {
  '/configuration': ACTION_PERMISSIONS.runtimeConfig, // GET /health/config
  '/audit': 'read:audit', // GET /audit
};

export const needsText = (permission: string): string => `Needs ${permission}`;

/** A server 403 as a sentence the operator can act on. */
export function permissionError(error: unknown, permission: string, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return /403|forbidden|insufficient|permission|access denied/i.test(message)
    ? `Not allowed: this action ${needsText(permission).toLowerCase()} (${message}).`
    : message || fallback;
}

export function useCan(permission: string): boolean {
  return useAuthStore((s) => s.hasPermission(permission));
}
