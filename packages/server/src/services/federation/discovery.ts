/**
 * Federation-gateway discovery (OAuth2 protected-resource metadata).
 *
 * Fail-closed: alleen geldige `.well-known/oauth-protected-resource/mcp` JSON
 * met resource + authorization_servers + scopes_supported wordt geaccepteerd.
 * Geen redirect-follow, geen hardcoded fallback-URL's, geen caching in v1.
 */

export interface GatewayMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
}

export interface DiscoveryResult {
  ok: boolean;
  reason: string | null;
  metadata: GatewayMetadata | null;
}

const JSONISH = /application\/json|\+json/i;

function isValidMetadata(value: unknown): value is GatewayMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.resource === 'string' && candidate.resource.length > 0
    && Array.isArray(candidate.authorization_servers) && candidate.authorization_servers.length > 0
    && candidate.authorization_servers.every((s) => typeof s === 'string' && s.length > 0)
    && Array.isArray(candidate.scopes_supported)
    && candidate.scopes_supported.every((s) => typeof s === 'string')
  );
}

export async function discoverGateway(baseUrl: string): Promise<DiscoveryResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}/.well-known/oauth-protected-resource/mcp`;
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'manual', // een omleiding is geen geldige metadata en betekent fail
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    return { ok: false, reason: `network_error: ${error instanceof Error ? error.message : String(error)}`, metadata: null };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, reason: `redirect_not_allowed: ${response.status}`, metadata: null };
  }
  if (!response.ok) {
    return { ok: false, reason: `http_error: ${response.status}`, metadata: null };
  }
  if (!JSONISH.test(response.headers.get('content-type') || '')) {
    return { ok: false, reason: 'invalid_content_type', metadata: null };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'invalid_json', metadata: null };
  }
  if (!isValidMetadata(body)) {
    return { ok: false, reason: 'invalid_metadata_shape', metadata: null };
  }
  return { ok: true, reason: null, metadata: body };
}
