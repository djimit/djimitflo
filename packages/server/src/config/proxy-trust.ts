import type { Express } from 'express';

const PRIVATE_PROXY_RANGES = ['loopback', 'linklocal', 'uniquelocal'];

/** Trust the local/private reverse proxy, never a direct Tailscale or public peer. */
export function configureProxyTrust(app: Express): void {
  app.set('trust proxy', PRIVATE_PROXY_RANGES);
}
