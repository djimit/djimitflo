/**
 * Legacy SSE transport for DjimFlo MCP Server over authenticated HTTP.
 * Serves MCP endpoints at /mcp for remote fleet access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import http from 'http';
import { verifyHs256Jwt } from '@djimitflo/shared/jwt';
import { runWithMcpAuth } from '../auth-context.js';
import { requireLiveMode, type DbHandle } from '../db.js';
import { ROLE_PERMISSIONS, type AuthTokenPayload, type UserRole } from '@djimitflo/shared';

export async function startHttpServer(server: McpServer | (() => McpServer), port: number, jwtSecret = process.env.JWT_SECRET || '', host = '0.0.0.0', authority?: DbHandle): Promise<http.Server> {
  if (!jwtSecret) throw new Error('JWT_SECRET is required for MCP HTTP transport');
  const transports: Map<string, SSEServerTransport> = new Map();
  const sessionPrincipals = new Map<string, string>();

  function currentPrincipal(payload: AuthTokenPayload): AuthTokenPayload | null {
    // A snapshot or standalone signature verifier cannot establish whether a
    // browser session family is still live. Legacy bearer behavior is retained.
    if (authority?.mode !== 'live') return payload.sid === undefined ? payload : null;
    try {
      requireLiveMode(authority);
      const user = authority.db.prepare('SELECT email, role, is_active, organization_id FROM users WHERE id = ?')
        .get(payload.sub) as { email: string; role: UserRole; is_active: number; organization_id: string | null } | undefined;
      if (!user?.is_active || !ROLE_PERMISSIONS[user.role]) return null;
      const organization = payload.organization_id ?? 'default';
      if (organization !== 'default' && organization !== (user.organization_id ?? 'default')) return null;
      if (payload.sid !== undefined) {
        if (typeof payload.sid !== 'string' || !payload.sid.trim()) return null;
        const active = authority.db.prepare(`SELECT 1 FROM refresh_tokens
          WHERE user_id = ? AND session_id = ? AND revoked = 0 AND julianday(expires_at) > julianday(?) LIMIT 1`)
          .get(payload.sub, payload.sid, new Date().toISOString());
        if (!active) return null;
      }
      return { ...payload, role: user.role, email: user.email, organization_id: organization };
    } catch {
      // Missing/invalid live authority is a refusal, never a signature fallback.
      return null;
    }
  }

  const principalKey = (payload: AuthTokenPayload) => JSON.stringify([
    payload.sub, payload.role, payload.organization_id ?? 'default', payload.sid ?? null,
  ]);

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', name: 'djimflo-mcp' }));
      return;
    }

    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'AUTH_REQUIRED' }));
      return;
    }
    const token = authorization.slice(7);
    const signed = verifyHs256Jwt(token, jwtSecret);
    const payload = signed && currentPrincipal(signed);
    if (!payload) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_TOKEN' }));
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'GET') {
      const transport = new SSEServerTransport('/mcp', res);
      transports.set(transport.sessionId, transport);
      sessionPrincipals.set(transport.sessionId, principalKey(payload));
      res.on('close', () => { transports.delete(transport.sessionId); sessionPrincipals.delete(transport.sessionId); });
      try {
        const sessionServer = typeof server === 'function' ? server() : server;
        await runWithMcpAuth({ payload, token }, () => sessionServer.connect(transport));
      } catch {
        transports.delete(transport.sessionId);
        sessionPrincipals.delete(transport.sessionId);
        if (!res.headersSent) res.writeHead(503);
        res.end('MCP session unavailable');
      }
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined ?? url.searchParams.get('sessionId');
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(404).end('Session not found');
        return;
      }
      if (sessionPrincipals.get(sessionId!) !== principalKey(payload)) {
        res.writeHead(403).end('Session principal mismatch');
        return;
      }
      await runWithMcpAuth({ payload, token }, () => transport.handlePostMessage(req, res));
      return;
    }

    res.writeHead(404).end('Not Found');
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });
  return httpServer;
}
