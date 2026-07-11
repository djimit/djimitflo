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
import { registerLoopTools } from './tools/loops.js';
import { registerGoalTools } from './tools/goals.js';
import { registerAgentTools } from './tools/agents.js';
import { registerMissionControlTools } from './tools/mission-control.js';
import { registerOrchestrationTools } from './tools/orchestration.js';
import { registerOkfTools } from './tools/okf.js';

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

  registerLoopTools(server, db);
  registerGoalTools(server, db);
  registerAgentTools(server, db);
  registerMissionControlTools(server, db);
  registerOrchestrationTools(server, db);
  registerOkfTools(server);

  if (opts.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
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
