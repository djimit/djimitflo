import net from 'node:net';
import https from 'node:https';
import { createRequire } from 'node:module';

/**
 * Test isolation on macOS: keep loopback test traffic away from other processes' 127.0.0.1 listeners.
 *
 * supertest's `request(app)` calls `app.listen(0)`, which binds the wildcard address `::`, and then connects to
 * 127.0.0.1:<port>. On macOS that wildcard socket can be given a port that another process already listens on
 * at 127.0.0.1 (observed: Tailscale's IPNExtension and a local codex app-server). Loopback IPv4 connections go to
 * the more specific 127.0.0.1 listener, so the test reads a foreign response: 401, 404, or 200 with an unrelated
 * body. That made route-inventory, explore-public, loops-http-proof and route-permissions-http flaky on developer
 * machines. Evidence: docs/research/w8/RETIREMENT_REVIEW.md, section "Local failures". Linux refuses that bind
 * with EADDRINUSE, so CI never saw it. The patch is therefore darwin-only.
 *
 * - supertest: keep its synchronous `listen(0)` (it reads `address()` right after), but connect over [::1]. The
 *   dual-stack wildcard socket accepts it, and the foreign 127.0.0.1 listeners never see IPv6 traffic.
 * - Hand-rolled `server.listen(0, cb)` + fetch(127.0.0.1): bind 127.0.0.1 explicitly. These callers already wait
 *   for the callback, so the async host lookup is fine, and the kernel does not hand out a port already bound on
 *   127.0.0.1.
 */
if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const Test = require('supertest/lib/test.js') as { prototype: { serverAddress(app: net.Server, path: string): string; _server?: net.Server } };
  Test.prototype.serverAddress = function serverAddress(app: net.Server, path: string): string {
    if (!app.address()) this._server = app.listen(0);
    const address = app.address() as net.AddressInfo;
    const protocol = app instanceof https.Server ? 'https' : 'http';
    const host = address.family === 'IPv6' && (address.address === '::' || address.address === '::1') ? '[::1]' : '127.0.0.1';
    return `${protocol}://${host}:${address.port}${path}`;
  };

  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function patchedListen(this: net.Server, ...args: unknown[]) {
    const [port, maybeCallback] = args;
    if (typeof port === 'number' && port === 0 && args.length === 2 && typeof maybeCallback === 'function') args.splice(1, 0, '127.0.0.1');
    return (originalListen as (...a: unknown[]) => net.Server).apply(this, args);
  } as typeof net.Server.prototype.listen;
}
