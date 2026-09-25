import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverGateway } from './discovery';

// Fixture op basis van de werkelijke x.ruv.io-response (C-verificatie).
const X_RUV_FIXTURE = {
  resource: 'https://x.ruv.io/mcp',
  authorization_servers: ['https://auth.cognitum.one'],
  scopes_supported: ['swarm:read', 'swarm:publish'],
};

function mockResponse(init: { status?: number; contentType?: string; body?: unknown }): Response {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: { get: (key: string) => (key.toLowerCase() === 'content-type' ? init.contentType ?? 'application/json' : null) } as Headers,
    json: async () => init.body,
  } as Response;
}

describe('discoverGateway', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('accepteert geldige metadata (x.ruv.io-fixture)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ body: X_RUV_FIXTURE })));
    const r = await discoverGateway('https://x.ruv.io');
    expect(r.ok).toBe(true);
    expect(r.metadata?.resource).toBe('https://x.ruv.io/mcp');
    expect(r.metadata?.authorization_servers).toEqual(['https://auth.cognitum.one']);
  });

  it('roept het .well-known-pad aan zonder redirect-follow', async () => {
    const fetchMock = vi.fn(async () => mockResponse({ body: X_RUV_FIXTURE }));
    vi.stubGlobal('fetch', fetchMock);
    await discoverGateway('https://x.ruv.io/');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.ruv.io/.well-known/oauth-protected-resource/mcp');
    expect(init.redirect).toBe('manual');
  });

  it('reject bij ontbrekend verplicht veld', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ body: { resource: 'https://x.ruv.io/mcp' } })));
    const r = await discoverGateway('https://x.ruv.io');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_metadata_shape');
    expect(r.metadata).toBeNull();
  });

  it('reject bij 30x-redirect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ status: 302, body: null })));
    const r = await discoverGateway('https://x.ruv.io');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('redirect_not_allowed');
  });

  it('reject bij netwerkfout en bij timeout (fail-closed, geen fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const r = await discoverGateway('https://x.ruv.io');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('network_error');
    expect(r.metadata).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation timed out', 'TimeoutError'); }));
    const r2 = await discoverGateway('https://x.ruv.io');
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('network_error');
  });

  it('reject bij niet-JSON content-type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ contentType: 'text/html', body: X_RUV_FIXTURE })));
    const r = await discoverGateway('https://x.ruv.io');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_content_type');
  });
});
