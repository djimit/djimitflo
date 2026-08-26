import { createHmac, timingSafeEqual } from 'crypto';
import { UserRole, type AuthTokenPayload } from './types/auth';

const VALID_ROLES = new Set(Object.values(UserRole));

export function verifyHs256Jwt(token: string, secret: string, nowSeconds = Date.now() / 1000): AuthTokenPayload | null {
  try {
    if (!secret) return null;
    const [encodedHeader, encodedPayload, signature] = token.split('.');
    if (!encodedHeader || !encodedPayload || !signature) return null;
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as AuthTokenPayload & { nbf?: number };
    if (!payload.sub || !VALID_ROLES.has(payload.role) || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds || (payload.nbf && payload.nbf > nowSeconds)) return null;
    return payload;
  } catch {
    return null;
  }
}
