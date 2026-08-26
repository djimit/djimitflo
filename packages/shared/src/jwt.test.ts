import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { UserRole } from './types/auth';
import { verifyHs256Jwt } from './jwt';

function sign(payload: Record<string, unknown>, secret = 'secret') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
}

describe('verifyHs256Jwt', () => {
  it('accepts a signed, unexpired DjimFlo principal', () => {
    expect(verifyHs256Jwt(sign({ sub: 'user-1', role: UserRole.APPROVER, exp: 200 }), 'secret', 100)).toMatchObject({ sub: 'user-1', role: UserRole.APPROVER });
  });

  it('rejects expired tokens and unknown roles', () => {
    expect(verifyHs256Jwt(sign({ sub: 'user-1', role: UserRole.APPROVER, exp: 100 }), 'secret', 100)).toBeNull();
    expect(verifyHs256Jwt(sign({ sub: 'user-1', role: 'root', exp: 200 }), 'secret', 100)).toBeNull();
  });
});
