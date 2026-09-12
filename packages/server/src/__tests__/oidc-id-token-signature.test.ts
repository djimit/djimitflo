import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OIDCAbstraction } from '../services/oidc-provider';

const config = {
  provider_name: 'test', client_id: 'test-client', issuer_url: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token',
  userinfo_endpoint: 'https://auth.example.com/userinfo', jwks_uri: 'https://auth.example.com/.well-known/jwks.json',
  redirect_uri: 'http://localhost:3001/callback', scopes: ['openid'], response_type: 'code' as const, pkce_enabled: true,
};

describe('OIDC ID-token signature verification', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires a matching JWKS key and verifies the signature plus issuer/audience', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = jwt.sign({ sub: 'user-1', iss: config.issuer_url, aud: config.client_id }, privateKey, { algorithm: 'RS256', keyid: 'key-1', expiresIn: '5m' });
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] }) })));
    await expect(new OIDCAbstraction(config).validateIdToken(token)).resolves.toMatchObject({ valid: true, payload: { sub: 'user-1' } });
  });

  it.each([
    ['tampered signature', (token: string) => { const parts = token.split('.'); const first = parts[2].slice(0, 1); parts[2] = `${first === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`; return parts.join('.'); }],
    ['wrong issuer', (token: string) => token],
  ])('rejects %s', async (_name, mutate) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const claims = _name === 'wrong issuer' ? { sub: 'user-1', iss: 'https://evil.example.com', aud: config.client_id } : { sub: 'user-1', iss: config.issuer_url, aud: config.client_id };
    const token = mutate(jwt.sign(claims, privateKey, { algorithm: 'RS256', keyid: 'key-1', expiresIn: '5m' }));
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] }) })));
    await expect(new OIDCAbstraction(config).validateIdToken(token)).resolves.toEqual({ valid: false });
  });

  it('rejects an unknown key id even when the token is otherwise valid', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = jwt.sign({ sub: 'user-1', iss: config.issuer_url, aud: config.client_id }, privateKey, { algorithm: 'RS256', keyid: 'unknown', expiresIn: '5m' });
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ keys: [{ ...jwk, kid: 'different', alg: 'RS256', use: 'sig' }] }) })));
    await expect(new OIDCAbstraction(config).validateIdToken(token)).resolves.toEqual({ valid: false });
  });
});
