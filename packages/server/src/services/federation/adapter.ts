/**
 * Federation-adapter (skelet). Gebruikt uitsluitend discovery-output — nooit
 * hardcoded endpoints. Achter DJIMITFLO_FEDERATION_ENABLED; disabled = no-op.
 *
 * Streamable-http MCP-client richting de ontdekte resource-URL.
 * ponytail: OAuth-token-dance (client-credentials bij auth.cognitum.one) is
 * bewust uitgesteld — plafond: publishExternal() blijft stub tot er een echte
 * publish-behoefte is; upgrade = eigen change met token-flow.
 */
import { discoverGateway, type GatewayMetadata } from './discovery';

export interface FederationListResult {
  ok: boolean;
  enabled: boolean;
  reason: string | null;
  items: unknown[];
}

export class FederationAdapter {
  private metadata: GatewayMetadata | null = null;

  constructor(private readonly baseUrl: string) {}

  private get enabled(): boolean {
    return !!process.env.DJIMITFLO_FEDERATION_ENABLED;
  }

  /** Discovery draait pas als de flag aan staat; anders no-op met expliciete log. */
  async connect(): Promise<{ ok: boolean; reason: string | null }> {
    if (!this.enabled) {
      console.log('[federation] disabled (DJIMITFLO_FEDERATION_ENABLED absent) — no-op');
      return { ok: false, reason: 'disabled' };
    }
    const discovery = await discoverGateway(this.baseUrl);
    if (!discovery.ok || !discovery.metadata) {
      console.warn(`[federation] discovery failed: ${discovery.reason} — adapter blijft uit`);
      return { ok: false, reason: `discovery_failed: ${discovery.reason}` };
    }
    this.metadata = discovery.metadata;
    return { ok: true, reason: null };
  }

  /** Lees externe commons. Fail-closed: nooit een niet-ontdekte URL aanroepen. */
  async listExternalCommons(): Promise<FederationListResult> {
    if (!this.enabled) return { ok: false, enabled: false, reason: 'disabled', items: [] };
    if (!this.metadata) {
      const connection = await this.connect();
      if (!connection.ok) return { ok: false, enabled: true, reason: connection.reason, items: [] };
    }
    const resource = this.metadata!.resource;
    try {
      const response = await fetch(resource, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { ok: false, enabled: true, reason: `resource_http_${response.status}`, items: [] };
      const body = await response.json() as { result?: { tools?: unknown[] } };
      return { ok: true, enabled: true, reason: null, items: body.result?.tools ?? [] };
    } catch (error) {
      return { ok: false, enabled: true, reason: `resource_error: ${error instanceof Error ? error.message : String(error)}`, items: [] };
    }
  }

  /** ponytail: stub tot token-dance-change. */
  async publishExternal(): Promise<never> {
    throw new Error('publishExternal not implemented: OAuth token-dance uitgesteld (zie design.md)');
  }
}
