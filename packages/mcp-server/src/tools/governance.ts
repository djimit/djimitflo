/**
 * Read-only governance and evidence MCP tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DbHandle } from '../db.js';

type OpenApiToolRow = {
  id: string;
  server_id: string;
  name: string;
  description: string;
  permission: string;
  risk_level: string;
  input_schema: string;
  metadata: string;
};

type OpenApiDiscovery = {
  server_id: unknown;
  server_name: unknown;
  openapi_url: string;
  operations: OpenApiToolRow[];
  error?: string;
};

function rows(dbHandle: DbHandle, sql: string, ...params: unknown[]) {
  return dbHandle.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function one(dbHandle: DbHandle, sql: string, ...params: unknown[]) {
  return dbHandle.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function tableCount(dbHandle: DbHandle, table: string) {
  return Number((one(dbHandle, `SELECT COUNT(*) AS c FROM ${table}`) || {}).c || 0);
}

function metadata(row: Record<string, unknown>) {
  try {
    return JSON.parse(String(row.metadata || '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function probeSpec(row: Record<string, unknown>) {
  const meta = metadata(row);
  const url = String(meta.probe_url || new URL(String(meta.probe_path || ''), String(row.url)).toString());
  const accept = Array.isArray(meta.probe_accept_statuses)
    ? meta.probe_accept_statuses.map(Number)
    : [];
  return {
    url,
    accepts: (status: number) => (accept.length > 0 ? accept.includes(status) : status >= 200 && status < 400),
  };
}

function openApiUrl(row: Record<string, unknown>) {
  const meta = metadata(row);
  if (meta.openapi_url) return String(meta.openapi_url);
  if (meta.openapi_path) return new URL(String(meta.openapi_path), String(row.url)).toString();
  return '';
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toolName(method: string, path: string) {
  return slug(`${method}_${path}`);
}

function classifyHttpTool(method: string) {
  return /^(get|head|options)$/i.test(method)
    ? { permission: 'allowed', risk_level: 'low' }
    : { permission: 'requires_approval', risk_level: 'medium' };
}

function sidecarServers(dbHandle: DbHandle, serverId?: string) {
  const where = serverId ? 'WHERE id = ? AND COALESCE(url, \'\') != \'\'' : 'WHERE COALESCE(url, \'\') != \'\'';
  const params = serverId ? [serverId] : [];
  return rows(dbHandle, `
    SELECT id, name, status, url, last_ping_at, error_message, metadata
    FROM mcp_servers
    ${where}
    ORDER BY updated_at DESC
  `, ...params);
}

function openApiServers(dbHandle: DbHandle, serverId?: string) {
  return sidecarServers(dbHandle, serverId).filter((row) => openApiUrl(row));
}

function getRegisteredToolRows(server: McpServer) {
  const registered = (server as unknown as { _registeredTools?: Record<string, { description?: string }> })._registeredTools || {};
  return Object.keys(registered).sort().map((name) => {
    const classification = classifyTool(name);
    return {
      id: `djimitflo-runtime:${name}`,
      server_id: 'djimitflo-runtime',
      name,
      description: registered[name]?.description || name,
      permission: classification.permission,
      risk_level: classification.risk_level,
      input_schema: JSON.stringify({ synced_from: 'runtime_registry' }),
      metadata: JSON.stringify({ synced_from: 'djimitflo_sync_mcp_catalog' }),
    };
  });
}

function classifyTool(name: string) {
  if (/approve|spawn|handoff/i.test(name)) {
    return { permission: 'requires_approval', risk_level: 'high' };
  }
  if (/evidence|cost|permission|mcp_/i.test(name)) {
    return { permission: 'allowed', risk_level: 'medium' };
  }
  return { permission: 'allowed', risk_level: 'low' };
}

export function registerGovernanceTools(server: McpServer, dbHandle: DbHandle) {
  server.registerTool(
    'djimitflo_mcp_doctor',
    {
      description: 'Diagnose drift between the live Djimitflo MCP server, DB registry, permissions, and stale server records',
      inputSchema: {
        includeToolNames: z.boolean().default(false).optional(),
      },
    },
    async ({ includeToolNames = false }) => {
      const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools || {};
      const runtimeToolNames = Object.keys(registered).sort();
      const dbTools = rows(dbHandle, 'SELECT id, server_id, name, permission, risk_level FROM mcp_tools ORDER BY name');
      const runtimeDbTools = dbTools.filter((row) => row.server_id === 'djimitflo-runtime');
      const externalDbTools = dbTools.filter((row) => row.server_id !== 'djimitflo-runtime');
      const permissions = rows(dbHandle, 'SELECT id, tool_id, decision, risk_level FROM mcp_tool_permissions ORDER BY tool_id');
      const servers = rows(dbHandle, `
        SELECT id, name, status, command, args, url, error_message, last_ping_at, metadata
        FROM mcp_servers
        ORDER BY updated_at DESC
      `);

      const dbToolNames = runtimeDbTools.map((row) => String(row.name)).sort();
      const permissionToolIds = new Set(permissions.map((row) => String(row.tool_id)));
      const dbToolNameSet = new Set(dbToolNames);
      const runtimeToolNameSet = new Set(runtimeToolNames);
      const dbToolsWithoutPermission = dbTools
        .filter((row) => !permissionToolIds.has(String(row.id)))
        .map((row) => ({ id: row.id, name: row.name, server_id: row.server_id, risk_level: row.risk_level }));
      const catalogOnlyServers = servers.filter((row) => {
        const value = metadata(row).catalog_only;
        return value === true || value === 1;
      });
      const catalogOnlyIds = new Set(catalogOnlyServers.map((row) => row.id));
      const probeableServers = servers.filter((row) => row.url);
      const serversWithErrors = probeableServers.filter((row) => row.error_message);
      const serversWithoutPing = probeableServers.filter((row) => !row.last_ping_at);
      const serversWithoutProbeUrl = servers.filter((row) => row.id !== 'djimitflo-runtime' && !row.url && !catalogOnlyIds.has(row.id));
      const serversWithOpenApiWithoutTools = servers
        .filter((row) => openApiUrl(row))
        .filter((serverRow) => !externalDbTools.some((toolRow) => toolRow.server_id === serverRow.id));
      const currentToolsMissingRegistryRows = runtimeToolNames.filter((name) => !dbToolNameSet.has(name));
      const registryToolsNotInCurrentServer = dbToolNames.filter((name) => !runtimeToolNameSet.has(name));

      const recommendedActions: string[] = [];
      if (currentToolsMissingRegistryRows.length > 0) {
        recommendedActions.push('sync current Djimitflo MCP tool catalog into mcp_tools with risk metadata');
      }
      if (dbToolsWithoutPermission.length > 0) {
        recommendedActions.push('create explicit mcp_tool_permissions rows for registered tools');
      }
      if (serversWithoutPing.length > 0) {
        recommendedActions.push('run djimitflo_probe_mcp_sidecars with apply=true for stale sidecar servers');
      }
      if (serversWithErrors.length > 0) {
        recommendedActions.push('inspect failed sidecar endpoints or mark unavailable servers stopped');
      }
      if (serversWithoutProbeUrl.length > 0) {
        recommendedActions.push('add probe URLs or command probes for sidecar server records without URLs');
      }
      if (serversWithOpenApiWithoutTools.length > 0) {
        recommendedActions.push('run djimitflo_sync_http_sidecar_catalog with apply=true for OpenAPI sidecar tool inventory');
      }
      if (registryToolsNotInCurrentServer.length > 0) {
        recommendedActions.push('classify Djimitflo runtime DB-only tools as stale rows or missing registrations');
      }
      if (recommendedActions.length === 0) {
        recommendedActions.push('no registry drift detected in read-only doctor checks');
      }

      return text({
        status: recommendedActions.length === 1 && recommendedActions[0].startsWith('no ') ? 'ok' : 'needs_attention',
        summary: {
          current_server_tools: runtimeToolNames.length,
          db_mcp_servers: servers.length,
          db_mcp_tools: dbTools.length,
          db_runtime_tools: runtimeDbTools.length,
          db_sidecar_tools: externalDbTools.length,
          db_mcp_permissions: permissions.length,
          execution_evidence: tableCount(dbHandle, 'execution_evidence'),
          swarm_evidence_edges: tableCount(dbHandle, 'swarm_evidence_edges'),
          token_usage_rows: tableCount(dbHandle, 'token_usage_log'),
          skill_outcomes: tableCount(dbHandle, 'skill_outcomes'),
          openmythos_eval_runs: tableCount(dbHandle, 'openmythos_eval_runs'),
        },
        drift: {
          current_tools_missing_registry_rows: currentToolsMissingRegistryRows,
          registry_tools_not_in_current_server: registryToolsNotInCurrentServer,
          sidecar_registry_tools: externalDbTools.map((row) => ({ id: row.id, server_id: row.server_id, name: row.name, risk_level: row.risk_level })),
          db_tools_without_permission: dbToolsWithoutPermission,
          servers_with_errors: serversWithErrors,
          servers_without_last_ping: serversWithoutPing,
          servers_without_probe_url: serversWithoutProbeUrl,
          servers_with_openapi_without_tools: serversWithOpenApiWithoutTools,
          catalog_only_servers: catalogOnlyServers,
        },
        live_sidecar_handshakes: {
          checked: false,
          tool: 'djimitflo_probe_mcp_sidecars',
          reason: 'doctor is read-only against Djimitflo state; sidecar probes run only when explicitly requested',
        },
        recommended_actions: recommendedActions,
        ...(includeToolNames ? { current_server_tool_names: runtimeToolNames, db_tool_names: dbToolNames } : {}),
      });
    }
  );

  server.registerTool(
    'djimitflo_sync_mcp_catalog',
    {
      description: 'Preview or apply synchronization of the live Djimitflo MCP runtime tools into the DB catalog',
      inputSchema: {
        apply: z.boolean().default(false).optional(),
      },
    },
    async ({ apply = false }) => {
      const toolRows = getRegisteredToolRows(server);
      const existingTools = new Set(rows(dbHandle, 'SELECT name FROM mcp_tools WHERE server_id = ?', 'djimitflo-runtime').map((row) => String(row.name)));
      const toCreate = toolRows.filter((row) => !existingTools.has(row.name));
      const toUpdate = toolRows.filter((row) => existingTools.has(row.name));

      if (!apply) {
        return text({
          apply: false,
          server: 'djimitflo-runtime',
          would_create_tools: toCreate.length,
          would_update_tools: toUpdate.length,
          tool_names: toolRows.map((row) => row.name),
          next: 'rerun with apply=true to write mcp_servers, mcp_tools, and mcp_tool_permissions rows',
        });
      }

      const write = dbHandle.db.transaction(() => {
        dbHandle.db.prepare(`
          INSERT INTO mcp_servers (id, name, description, status, command, args, env, version, last_ping_at, metadata, created_at, updated_at)
          VALUES (
            'djimitflo-runtime',
            'Djimitflo Runtime MCP',
            'Local Djimitflo MCP server runtime catalog',
            'running',
            'node',
            ?,
            '{}',
            '0.1.0',
            datetime('now'),
            ?,
            datetime('now'),
            datetime('now')
          )
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            command = excluded.command,
            args = excluded.args,
            version = excluded.version,
            last_ping_at = excluded.last_ping_at,
            metadata = excluded.metadata,
            updated_at = datetime('now')
        `).run(
          JSON.stringify(['./packages/mcp-server/dist/index.js', '--transport', 'stdio']),
          JSON.stringify({ synced_from: 'djimitflo_sync_mcp_catalog' })
        );

        const upsertTool = dbHandle.db.prepare(`
          INSERT INTO mcp_tools (
            id, server_id, name, description, permission, risk_level, input_schema, metadata, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            description = excluded.description,
            permission = excluded.permission,
            risk_level = excluded.risk_level,
            input_schema = excluded.input_schema,
            metadata = excluded.metadata,
            updated_at = datetime('now')
        `);
        const upsertPermission = dbHandle.db.prepare(`
          INSERT INTO mcp_tool_permissions (
            id, tool_id, decision, risk_level, reason, last_seen_at, metadata, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'), datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            decision = excluded.decision,
            risk_level = excluded.risk_level,
            reason = excluded.reason,
            last_seen_at = excluded.last_seen_at,
            metadata = excluded.metadata,
            updated_at = datetime('now')
        `);

        for (const row of toolRows) {
          upsertTool.run(row.id, row.server_id, row.name, row.description, row.permission, row.risk_level, row.input_schema, row.metadata);
          upsertPermission.run(
            `djimitflo-runtime:${row.name}:permission`,
            row.id,
            row.permission,
            row.risk_level,
            `synced ${row.permission}/${row.risk_level} from runtime tool classification`,
            JSON.stringify({ synced_from: 'djimitflo_sync_mcp_catalog' })
          );
        }
      });

      write();

      return text({
        apply: true,
        server: 'djimitflo-runtime',
        created_tools: toCreate.length,
        updated_tools: toUpdate.length,
        synced_tools: toolRows.length,
      });
    }
  );

  server.registerTool(
    'djimitflo_sync_http_sidecar_catalog',
    {
      description: 'Preview or apply OpenAPI operation inventory sync for registered HTTP sidecar servers',
      inputSchema: {
        apply: z.boolean().default(false).optional(),
        serverId: z.string().optional(),
        timeoutMs: z.number().int().min(100).max(10_000).default(2_500).optional(),
      },
    },
    async ({ apply = false, serverId, timeoutMs = 2_500 }) => {
      const targets = openApiServers(dbHandle, serverId);
      const discovered: OpenApiDiscovery[] = [];

      for (const target of targets) {
        const url = openApiUrl(target);
        let spec: { paths?: Record<string, Record<string, { operationId?: string; summary?: string; parameters?: unknown[]; requestBody?: unknown }>> };
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
          if (!response.ok) {
            discovered.push({ server_id: target.id, server_name: target.name, openapi_url: url, operations: [], error: `HTTP ${response.status}` });
            continue;
          }
          spec = await response.json() as typeof spec;
        } catch (error) {
          discovered.push({ server_id: target.id, server_name: target.name, openapi_url: url, operations: [], error: error instanceof Error ? error.message : 'OpenAPI fetch failed' });
          continue;
        }

        const operations: OpenApiToolRow[] = [];
        for (const [path, methods] of Object.entries(spec.paths || {})) {
          for (const [method, operation] of Object.entries(methods || {})) {
            if (!/^(get|post|put|patch|delete|head|options)$/i.test(method)) continue;
            const classification = classifyHttpTool(method);
            const name = toolName(method, path);
            operations.push({
              id: `${target.id}:${name}`,
              server_id: String(target.id),
              name,
              description: `${method.toUpperCase()} ${path}${operation.summary ? ` - ${operation.summary}` : ''}`,
              permission: classification.permission,
              risk_level: classification.risk_level,
              input_schema: JSON.stringify({ method: method.toUpperCase(), path, parameters: operation.parameters || [], has_request_body: Boolean(operation.requestBody) }),
              metadata: JSON.stringify({ synced_from: 'djimitflo_sync_http_sidecar_catalog', openapi_url: url, operation_id: operation.operationId || null }),
            });
          }
        }
        discovered.push({ server_id: target.id, server_name: target.name, openapi_url: url, operations });
      }

      const operations = discovered.flatMap((entry) => entry.operations);
      const operationIds = new Set(operations.map((row) => row.id));
      const staleTools = discovered.filter((entry) => !entry.error).flatMap((entry) => rows(dbHandle, 'SELECT id, metadata FROM mcp_tools WHERE server_id = ?', entry.server_id)
        .filter((row) => metadata(row).synced_from === 'djimitflo_sync_http_sidecar_catalog')
        .filter((row) => !operationIds.has(String(row.id)))
        .map((row) => String(row.id)));
      if (!apply) {
        return text({
          apply: false,
          servers: discovered.map((entry) => ({
            server_id: entry.server_id,
            server_name: entry.server_name,
            openapi_url: entry.openapi_url,
            operation_count: entry.operations.length,
            error: entry.error,
          })),
          would_sync_tools: operations.length,
          would_delete_stale_tools: staleTools.length,
          next: 'rerun with apply=true to write OpenAPI operations into mcp_tools and mcp_tool_permissions',
        });
      }

      const write = dbHandle.db.transaction(() => {
        const upsertTool = dbHandle.db.prepare(`
          INSERT INTO mcp_tools (
            id, server_id, name, description, permission, risk_level, input_schema, metadata, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            description = excluded.description,
            permission = excluded.permission,
            risk_level = excluded.risk_level,
            input_schema = excluded.input_schema,
            metadata = excluded.metadata,
            updated_at = datetime('now')
        `);
        const upsertPermission = dbHandle.db.prepare(`
          INSERT INTO mcp_tool_permissions (
            id, tool_id, decision, risk_level, reason, last_seen_at, metadata, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'), datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            decision = excluded.decision,
            risk_level = excluded.risk_level,
            reason = excluded.reason,
            last_seen_at = excluded.last_seen_at,
            metadata = excluded.metadata,
            updated_at = datetime('now')
        `);

        for (const row of operations) {
          upsertTool.run(row.id, row.server_id, row.name, row.description, row.permission, row.risk_level, row.input_schema, row.metadata);
          upsertPermission.run(
            `${row.id}:permission`,
            row.id,
            row.permission,
            row.risk_level,
            `synced ${row.permission}/${row.risk_level} from OpenAPI operation ${row.name}`,
            JSON.stringify({ synced_from: 'djimitflo_sync_http_sidecar_catalog' })
          );
        }

        const deletePermission = dbHandle.db.prepare('DELETE FROM mcp_tool_permissions WHERE tool_id = ?');
        const deleteTool = dbHandle.db.prepare('DELETE FROM mcp_tools WHERE id = ?');
        for (const id of staleTools) {
          deletePermission.run(id);
          deleteTool.run(id);
        }
      });

      write();

      return text({
        apply: true,
        synced_tools: operations.length,
        deleted_stale_tools: staleTools.length,
        servers: discovered.map((entry) => ({
          server_id: entry.server_id,
          server_name: entry.server_name,
          openapi_url: entry.openapi_url,
          operation_count: entry.operations.length,
          error: entry.error,
        })),
      });
    }
  );

  server.registerTool(
    'djimitflo_probe_mcp_sidecars',
    {
      description: 'Preview or apply HTTP health probes for registered sidecar MCP servers with URLs',
      inputSchema: {
        apply: z.boolean().default(false).optional(),
        serverId: z.string().optional(),
        timeoutMs: z.number().int().min(100).max(10_000).default(1_500).optional(),
      },
    },
    async ({ apply = false, serverId, timeoutMs = 1_500 }) => {
      const targets = sidecarServers(dbHandle, serverId);

      if (!apply) {
        return text({
          apply: false,
          checked: false,
          targets: targets.map((target) => ({
            id: target.id,
            name: target.name,
            url: target.url,
            status: target.status,
            last_ping_at: target.last_ping_at,
            error_message: target.error_message,
          })),
          next: 'rerun with apply=true to update status, last_ping_at, and error_message',
        });
      }

      const results = [];
      for (const target of targets) {
        const now = new Date().toISOString();
        const probe = probeSpec(target);
        try {
          const response = await fetch(probe.url, { signal: AbortSignal.timeout(timeoutMs) });
          const running = probe.accepts(response.status);
          const errorMessage = running ? null : `HTTP ${response.status} from ${probe.url}`;
          dbHandle.db.prepare('UPDATE mcp_servers SET status = ?, last_ping_at = ?, error_message = ?, updated_at = ? WHERE id = ?')
            .run(running ? 'running' : 'error', now, errorMessage, now, target.id);
          results.push({ id: target.id, name: target.name, url: target.url, probe_url: probe.url, status: running ? 'running' : 'error', http_status: response.status, error_message: errorMessage });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Health probe failed';
          dbHandle.db.prepare('UPDATE mcp_servers SET status = ?, last_ping_at = ?, error_message = ?, updated_at = ? WHERE id = ?')
            .run('error', now, errorMessage, now, target.id);
          results.push({ id: target.id, name: target.name, url: target.url, probe_url: probe.url, status: 'error', error_message: errorMessage });
        }
      }

      return text({
        apply: true,
        checked: true,
        probed_servers: results.length,
        running: results.filter((result) => result.status === 'running').length,
        error: results.filter((result) => result.status === 'error').length,
        results,
      });
    }
  );

  server.registerTool(
    'djimitflo_list_mcp_servers',
    {
      description: 'List registered MCP servers from Djimitflo governance state',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).optional(),
        status: z.string().optional(),
      },
    },
    async ({ limit = 20, status }) => {
      const where = status ? ' WHERE status = ?' : '';
      const params = status ? [status, limit] : [limit];
      return text(rows(dbHandle, `
        SELECT id, name, description, status, command, args, version, last_ping_at, error_message
        FROM mcp_servers${where}
        ORDER BY updated_at DESC
        LIMIT ?
      `, ...params));
    }
  );

  server.registerTool(
    'djimitflo_list_mcp_tools',
    {
      description: 'List registered MCP tools with permission and risk metadata',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50).optional(),
        serverId: z.string().optional(),
        riskLevel: z.string().optional(),
      },
    },
    async ({ limit = 50, serverId, riskLevel }) => {
      const filters: string[] = [];
      const params: unknown[] = [];
      if (serverId) { filters.push('t.server_id = ?'); params.push(serverId); }
      if (riskLevel) { filters.push('t.risk_level = ?'); params.push(riskLevel); }
      const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
      params.push(limit);
      return text(rows(dbHandle, `
        SELECT t.id, t.server_id, s.name AS server_name, t.name, t.permission, t.risk_level,
               t.total_calls, t.successful_calls, t.failed_calls, t.last_called_at
        FROM mcp_tools t
        LEFT JOIN mcp_servers s ON s.id = t.server_id
        ${where}
        ORDER BY t.updated_at DESC
        LIMIT ?
      `, ...params));
    }
  );

  server.registerTool(
    'djimitflo_get_mcp_permissions',
    {
      description: 'List effective MCP tool permission decisions',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50).optional(),
        decision: z.string().optional(),
      },
    },
    async ({ limit = 50, decision }) => {
      const where = decision ? ' WHERE p.decision = ?' : '';
      const params = decision ? [decision, limit] : [limit];
      return text(rows(dbHandle, `
        SELECT p.id, p.tool_id, t.name AS tool_name, p.policy_id, p.decision,
               p.risk_level, p.reason, p.last_seen_at
        FROM mcp_tool_permissions p
        LEFT JOIN mcp_tools t ON t.id = p.tool_id
        ${where}
        ORDER BY p.updated_at DESC
        LIMIT ?
      `, ...params));
    }
  );

  server.registerTool(
    'djimitflo_get_cost_summary',
    {
      description: 'Summarize token usage and skill outcome cost signals',
      inputSchema: {
        taskId: z.string().optional(),
        provider: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20).optional(),
      },
    },
    async ({ taskId, provider, limit = 20 }) => {
      const filters: string[] = [];
      const params: unknown[] = [];
      if (taskId) { filters.push('task_id = ?'); params.push(taskId); }
      if (provider) { filters.push('provider = ?'); params.push(provider); }
      const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
      const totals = one(dbHandle, `
        SELECT COUNT(*) AS rows, COALESCE(SUM(total_tokens), 0) AS total_tokens,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
               COALESCE(SUM(cost), 0) AS cost
        FROM token_usage_log${where}
      `, ...params);
      return text({
        totals,
        by_model: rows(dbHandle, `
          SELECT provider, model, COUNT(*) AS rows, COALESCE(SUM(total_tokens), 0) AS total_tokens,
                 COALESCE(SUM(cost), 0) AS cost
          FROM token_usage_log${where}
          GROUP BY provider, model
          ORDER BY total_tokens DESC
          LIMIT ?
        `, ...params, limit),
        skill_outcomes: rows(dbHandle, `
          SELECT skill_id, domain, COUNT(*) AS runs, COALESCE(SUM(success), 0) AS successes,
                 COALESCE(SUM(tokens_used), 0) AS tokens_used
          FROM skill_outcomes
          GROUP BY skill_id, domain
          ORDER BY tokens_used DESC
          LIMIT ?
        `, limit),
      });
    }
  );

  server.registerTool(
    'djimitflo_get_evidence_chain',
    {
      description: 'Return task, execution evidence, events, approvals, and graph edges for one task',
      inputSchema: {
        taskId: z.string().describe('Task ID to inspect'),
      },
    },
    async ({ taskId }) => {
      const task = one(dbHandle, 'SELECT * FROM tasks WHERE id = ?', taskId);
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Task not found: ${taskId}` }], isError: true };
      }
      return text({
        task,
        evidence: rows(dbHandle, 'SELECT * FROM execution_evidence WHERE task_id = ? ORDER BY created_at DESC', taskId),
        events: rows(dbHandle, 'SELECT * FROM execution_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 50', taskId),
        approvals: rows(dbHandle, 'SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at DESC', taskId),
        graph_edges: rows(dbHandle, `
          SELECT * FROM swarm_evidence_edges
          WHERE from_ref LIKE ? OR to_ref LIKE ?
          ORDER BY created_at DESC
          LIMIT 50
        `, `%${taskId}%`, `%${taskId}%`),
      });
    }
  );

  server.registerTool(
    'djimitflo_list_openmythos_runs',
    {
      description: 'List OpenMythos evaluation runs and persisted case-result counts',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).optional(),
        status: z.string().optional(),
      },
    },
    async ({ limit = 20, status }) => {
      const where = status ? ' WHERE r.status = ?' : '';
      const params = status ? [status, limit] : [limit];
      return text(rows(dbHandle, `
        SELECT r.id, r.agent_id, r.status, r.total_cases, r.completed_cases, r.overall_score,
               r.judge_model, r.started_at, r.finished_at, COUNT(c.id) AS result_rows
        FROM openmythos_eval_runs r
        LEFT JOIN openmythos_case_results c ON c.run_id = r.id
        ${where}
        GROUP BY r.id
        ORDER BY r.created_at DESC
        LIMIT ?
      `, ...params));
    }
  );

  server.registerTool(
    'djimitflo_list_skill_outcomes',
    {
      description: 'List recent skill outcomes with token usage and evidence references',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).optional(),
        skillId: z.string().optional(),
      },
    },
    async ({ limit = 20, skillId }) => {
      const where = skillId ? ' WHERE skill_id = ?' : '';
      const params = skillId ? [skillId, limit] : [limit];
      return text(rows(dbHandle, `
        SELECT id, skill_id, success, tokens_used, duration_ms, domain, task_id,
               agent_id, skill_version, skill_content_hash, model, evidence_refs_json, created_at
        FROM skill_outcomes${where}
        ORDER BY created_at DESC
        LIMIT ?
      `, ...params));
    }
  );
}
