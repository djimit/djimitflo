/**
 * S3 (docs/runbooks/fleet-bus-auth.md): the Djimit event bus and agent registry take a per-host bearer token.
 * This host's token is DJIMIT_EVENT_BUS_TOKEN (the registry uses AGENT_REGISTRY_TOKEN when set, else the same token).
 * Unset = no header, exactly as before; the services accept that until they run AUTH_MODE=enforce.
 */
export function fleetBusAuthHeaders(token: string | undefined = process.env.DJIMIT_EVENT_BUS_TOKEN): Record<string, string> {
  const value = token?.trim();
  return value ? { Authorization: `Bearer ${value}` } : {};
}

export const agentRegistryAuthHeaders = (): Record<string, string> =>
  fleetBusAuthHeaders(process.env.AGENT_REGISTRY_TOKEN?.trim() || process.env.DJIMIT_EVENT_BUS_TOKEN);
