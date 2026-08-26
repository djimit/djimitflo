/**
 * HTTP (Streamable HTTP) transport for DjimFlo MCP Server.
 * Serves MCP endpoints at /mcp for remote fleet access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import http from 'http';
import type { AuthTokenPayload } from '@djimitflo/shared';
import { verifyHs256Jwt } from '@djimitflo/shared/jwt';
import { runWithMcpAuth } from '../auth-context.js';

export async function startHttpServer(server: McpServer, port: number, jwtSecret = process.env.JWT_SECRET || ''): Promise<http.Server> {
  if (!jwtSecret) throw new Error('JWT_SECRET is required for MCP HTTP transport');
  const transports: Map<string, SSEServerTransport> = new Map();
  const sessionPrincipals = new Map<string, string>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', name: 'djimflo-mcp' }));
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'AUTH_REQUIRED' }));
      return;
    }
    const token = authHeader.slice(7);
    const payload = verifyHs256Jwt(token, jwtSecret) as AuthTokenPayload | null;
    if (!payload) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_TOKEN' }));
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'GET') {
      const transport = new SSEServerTransport('/mcp', res);
      transports.set(transport.sessionId, transport);
      sessionPrincipals.set(transport.sessionId, `${payload.sub}:${payload.role}`);
      res.on('close', () => { transports.delete(transport.sessionId); sessionPrincipals.delete(transport.sessionId); });
      await runWithMcpAuth({ payload, token }, () => server.connect(transport));
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(404).end('Session not found');
        return;
      }
      if (sessionPrincipals.get(sessionId!) !== `${payload.sub}:${payload.role}`) {
        res.writeHead(403).end('Session principal mismatch');
        return;
      }
      await runWithMcpAuth({ payload, token }, () => transport.handlePostMessage(req, res));
      return;
    }

    res.writeHead(404).end('Not Found');
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, '0.0.0.0', resolve);
  });
  return httpServer;
}
