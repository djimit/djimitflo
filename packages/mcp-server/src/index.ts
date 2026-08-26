#!/usr/bin/env node

/**
 * DjimFlo MCP Server
 *
 * Exposes DjimFlo capabilities (loop orchestration, goal management,
 * agent status, mission control) as MCP tools via stdio or HTTP transport.
 *
 * Usage:
 *   djimitflo-mcp --transport stdio
 *   djimitflo-mcp --transport http --port 3002
 *   djimitflo-mcp --db /path/to/djimitflo.sqlite
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDatabase } from './db.js';
import { registerTools } from './register-tools.js';
import { runWithMcpAuth } from './auth-context.js';
import { UserRole } from '@djimitflo/shared';

interface ServerOptions {
  transport: 'stdio' | 'http';
  port: number;
  dbPath: string;
}

function parseArgs(): ServerOptions {
  const args = process.argv.slice(2);
  const transport = (args.indexOf('--transport') >= 0 ? args[args.indexOf('--transport') + 1] : 'stdio') as 'stdio' | 'http';
  const portStr = args.indexOf('--port') >= 0 ? args[args.indexOf('--port') + 1] : '3002';
  const dbPath = args.indexOf('--db') >= 0 ? args[args.indexOf('--db') + 1] : process.env.DJIMITFLO_DB || '';

  return { transport, port: parseInt(portStr, 10) || 3002, dbPath };
}

async function main() {
  const opts = parseArgs();
  const db = createDatabase(opts.dbPath);

  const server = new McpServer({
    name: 'djimitflo',
    version: '0.1.0',
  });

  registerTools(server, db);

  if (opts.transport === 'stdio') {
    const transport = new StdioServerTransport();
    const now = Math.floor(Date.now() / 1000);
    await runWithMcpAuth({
      payload: {
        sub: process.env.DJIMITFLO_MCP_STDIO_PRINCIPAL || `stdio:${process.getuid?.() ?? 'local'}`,
        email: 'stdio@localhost',
        role: UserRole.VIEWER,
        iat: now,
        exp: now + 24 * 60 * 60,
      },
      token: process.env.DJIMITFLO_MCP_TOKEN || '',
    }, () => server.connect(transport));
    console.error('DjimFlo MCP Server running on stdio');
  } else {
    const { startHttpServer } = await import('./transports/http.js');
    await startHttpServer(server, opts.port);
    console.error(`DjimFlo MCP Server running on http://0.0.0.0:${opts.port}/mcp`);
  }
}

main().catch((error) => {
  console.error('Fatal error starting DjimFlo MCP Server:', error);
  process.exit(1);
});
