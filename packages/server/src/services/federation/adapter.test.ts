import { afterEach, describe, expect, it, vi } from 'vitest';
import { FederationAdapter } from './adapter';

const DISCOVERY_FIXTURE = {
  resource: 'https://x.ruv.io/mcp',
  authorization_servers: ['https://auth.cognitum.one'],
  scopes_supported: ['swarm:read', 'swarm:publish'],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => (key.toLowerCase() === 'content-type' ? 'application/json' : null) } as Headers,
    json: async () => body,
  } as Response;
}

describe('FederationAdapter', () => {
  afterEach(() => {
    delete process.env.DJIMITFLO_FEDERATION_ENABLED;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is een no-op als de flag uit staat (geen fetch, geen connect)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new FederationAdapter('https://x.ruv.io');
    expect((await adapter.connect()).reason).toBe('disabled');
    const list = await adapter.listExternalCommons();
    expect(list).toMatchObject({ ok: false, enabled: false, reason: 'disabled', items: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lijst via ontdekte resource bij flag aan + geldige discovery', async () => {
    process.env.DJIMITFLO_FEDERATION_ENABLED = '1';
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('.well-known')) return jsonResponse(200, DISCOVERY_FIXTURE);
      return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'commons.list' }] } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new FederationAdapter('https://x.ruv.io');
    const list = await adapter.listExternalCommons();
    expect(list.ok).toBe(true);
    expect(list.items).toEqual([{ name: 'commons.list' }]);
    // enige resource-call ging naar de ontdekte resource-URL
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === 'https://x.ruv.io/mcp')).toBe(true);
  });

  it('fail-closed bij discovery-falen: adapter blijft uit en raakt resource niet aan', async () => {
    process.env.DJIMITFLO_FEDERATION_ENABLED = '1';
    const fetchMock = vi.fn(async () => jsonResponse(200, { unrelated: true }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new FederationAdapter('https://x.ruv.io');
    const list = await adapter.listExternalCommons();
    expect(list.ok).toBe(false);
    expect(list.reason).toContain('discovery_failed');
    expect(list.items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // alleen discovery
  });

  it('publishExternal is bewust een stub', async () => {
    await expect(new FederationAdapter('https://x.ruv.io').publishExternal()).rejects.toThrow('not implemented');
  });
});
