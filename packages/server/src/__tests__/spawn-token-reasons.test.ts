import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { createHostAgentRoutes, HOST_AGENT_SCOPE } from '../routes/host-agent';
import { mintSpawnToken, resolveSpawnTokenSecret, spawnTokenRejection, validateSpawnToken } from '../services/spawn-token';

const secret = 'test-spawn-token-reason-secret';
const sign = (payload: string) => {
  const b64 = Buffer.from(payload, 'utf8').toString('base64url');
  return `${b64}.${createHmac('sha256', secret).update(b64).digest('base64url')}`;
};

describe('spawnTokenRejection: why a token was refused', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('returns null for a valid token, and the boolean validator still agrees', () => {
    const token = mintSpawnToken(secret, 'agent-a', 'social-runtime', 60_000);
    expect(spawnTokenRejection(secret, token, 'agent-a', 'social-runtime')).toBeNull();
    expect(validateSpawnToken(secret, token, 'agent-a', 'social-runtime')).toBe(true);
  });

  it('names malformed, bad_mac, wrong_subject, wrong_scope and expired separately', () => {
    const token = mintSpawnToken(secret, 'agent-a', 'social-runtime', 60_000);
    expect(spawnTokenRejection(secret, '', 'agent-a', 'social-runtime')).toBe('malformed');
    expect(spawnTokenRejection(secret, 'no-dot', 'agent-a', 'social-runtime')).toBe('malformed');
    expect(spawnTokenRejection(secret, sign('only-one-field'), 'agent-a', 'social-runtime')).toBe('malformed');
    expect(spawnTokenRejection('another-secret', token, 'agent-a', 'social-runtime')).toBe('bad_mac');
    expect(spawnTokenRejection(secret, `${token.split('.')[0]}.tampered`, 'agent-a', 'social-runtime')).toBe('bad_mac');
    expect(spawnTokenRejection(secret, token, 'agent-b', 'social-runtime')).toBe('wrong_subject');
    expect(spawnTokenRejection(secret, token, 'agent-a', 'host-agent')).toBe('wrong_scope');
    expect(spawnTokenRejection(secret, sign(`agent-a|social-runtime|${Date.now() - 1}`), 'agent-a', 'social-runtime')).toBe('expired');
    expect(spawnTokenRejection(secret, sign('agent-a|social-runtime|soon'), 'agent-a', 'social-runtime')).toBe('malformed');
  });

  it('keeps the boolean validator false for every rejection (no change in who is accepted)', () => {
    const token = mintSpawnToken(secret, 'agent-a', 'social-runtime', 60_000);
    for (const [tok, sub, scope] of [['', 'agent-a', 'social-runtime'], [token, 'agent-b', 'social-runtime'], [token, 'agent-a', 'host-agent'], [sign(`agent-a|social-runtime|${Date.now() - 1}`), 'agent-a', 'social-runtime']]) {
      expect(validateSpawnToken(secret, tok, sub, scope)).toBe(false);
    }
  });
});

describe('host-agent auth logs the rejection reason', () => {
  it('logs wrong_subject / malformed instead of a bare invalid, and still answers 401 HOST_TOKEN_INVALID', async () => {
    const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
    const app = express(); app.use(express.json());
    app.use('/host-agent', createHostAgentRoutes(db, { requireAuth: (_q: any, _s: any, n: any) => n(), requirePermission: () => (_q: any, _s: any, n: any) => n() } as any));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = mintSpawnToken(resolveSpawnTokenSecret(), 'workstation', HOST_AGENT_SCOPE);
    const other = await request(app).post('/host-agent/poll').set('X-Host', 'macmini').set('X-Host-Token', token);
    const junk = await request(app).post('/host-agent/poll').set('X-Host', 'workstation').set('X-Host-Token', 'junk');
    expect([other.status, junk.status]).toEqual([401, 401]);
    expect(other.body.error.code).toBe('HOST_TOKEN_INVALID');
    const logged = warn.mock.calls.map((call) => call.join(' '));
    expect(logged.some((line) => line.includes('host-agent') && line.includes('wrong_subject'))).toBe(true);
    expect(logged.some((line) => line.includes('host-agent') && line.includes('malformed'))).toBe(true);
    expect(logged.join('\n')).not.toContain(token);
    warn.mockRestore(); db.close();
  });
});
