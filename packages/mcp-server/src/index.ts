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
import { createDatabase, labelDbTools } from './db.js';
import { registerLoopTools } from './tools/loops.js';
import { registerGoalTools } from './tools/goals.js';
import { registerAgentTools } from './tools/agents.js';
import { registerMissionControlTools } from './tools/mission-control.js';
import { registerOrchestrationTools } from './tools/orchestration.js';
import { registerOkfTools } from './tools/okf.js';
import { registerOpenMythosTools } from './tools/openmythos.js';
import { registerGovernanceTools } from './tools/governance.js';
import { registerNotebookTools } from './tools/notebooks.js';
import { registerExplainerTools } from './tools/explainer.js';
import { registerAuthorityTools } from './tools/authority.js';
import { registerPlatformTools } from './tools/platform.js';
import { registerDjimitSecTools } from './tools/djimitsec.js';
import { runWithMcpAuth } from './auth-context.js';
import { UserRole } from '@djimitflo/shared';
import type { DbHandle } from './db.js';
import { pathToFileURL } from 'url';

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

  const createServer = () => {
    const server = new McpServer({ name: 'djimitflo', version: '0.1.0' });
    registerTools(server, db);
    return server;
  };

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
    }, () => createServer().connect(transport));
    console.error('DjimFlo MCP Server running on stdio');
  } else {
    const { startHttpServer } = await import('./transports/http.js');
    await startHttpServer(createServer, opts.port, process.env.JWT_SECRET || '', '0.0.0.0', db);
    console.error(`DjimFlo MCP Server running on http://0.0.0.0:${opts.port}/mcp`);
  }
}

export function registerTools(server: McpServer, db: DbHandle): void {
  // O2c: every DB-backed tool answers with data_as_of / is_production (OKF and notebooks read no DB)
  const dbServer = labelDbTools(server, db);
  registerLoopTools(dbServer, db);
  registerGoalTools(dbServer, db);
  registerAgentTools(dbServer, db);
  registerMissionControlTools(dbServer, db);
  registerOrchestrationTools(dbServer, db);
  registerOkfTools(server);
  registerOpenMythosTools(dbServer, db);
  registerGovernanceTools(dbServer, db);
  registerNotebookTools(server);
  registerExplainerTools(dbServer, db.db);
  registerAuthorityTools(dbServer, db);
  registerPlatformTools(dbServer, db);
  registerDjimitSecTools(dbServer, db);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Fatal error starting DjimFlo MCP Server:', error);
    process.exit(1);
  });
}
