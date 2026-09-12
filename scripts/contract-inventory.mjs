#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { inventoryRouteSource, compareRuntimeRoutes, routeSourceFingerprint, inventoryDashboardClient } from './route-source-inventory.mjs';

const root = resolve(import.meta.dirname, '..');

function files(dir, suffix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.djimitflo-loop-worktrees'))) return [];
    return entry.isDirectory() ? files(path, suffix) : entry.name.endsWith(suffix) ? [path] : [];
  });
}

const testFiles = files(join(root, 'packages'), '.test.ts');
const tests = testFiles.map(path => ({ path, content: readFileSync(path, 'utf8') }));
const sourceInventory = inventoryRouteSource(root);
const critical = /^(auth|approvals|backup|exports|council|openmythos|mcp|runtime-governance|swarms|spawns)$/;
const routeExemptions = new Map([
  ['swarms:POST:/expert/dispatch', 'Dispatches external research providers; requires an isolated network-controlled contract canary.'],
  ['swarms:POST:/fix', 'Can modify a repository and invoke an agent runtime; requires an isolated disposable-worktree canary.'],
]);
const routes = [];
function endpointPattern(prefix = '', routePath) {
  const endpoint = `${prefix}${routePath === '/' ? '' : routePath}` || '/';
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const path = escaped.replace(/:([A-Za-z0-9_]+)/g, '(?:\\$\\{[^}]+\\}|[^/\\s\"\'`?]+)');
  return new RegExp(`(?<![A-Za-z0-9_/-])(?:https?:\\/\\/[^/\\s\"'\\x60]+)?(?:\\/api)?${path}(?=[?&\\s\"'\\x60),}]|$)`);
}

function routeExecuted(content, method, endpoint) {
  for (const match of content.matchAll(new RegExp(endpoint.source, 'g'))) {
    const before = content.slice(Math.max(0, match.index - 180), match.index);
    const after = content.slice(match.index + match[0].length, match.index + match[0].length + 800);
    const callAfter = after.split(';', 1)[0];
    const pathLoopStart = content.lastIndexOf('for (const path of [', match.index);
    const pathLoopEnd = pathLoopStart >= 0 ? content.indexOf('request(path)', pathLoopStart) : -1;
    if (method === 'GET' && pathLoopStart >= 0 && match.index < pathLoopEnd) return true;
    if (new RegExp(`request\\([^\\n]{0,140}['"]${method}['"][^\\n]{0,140}$`).test(before)) return true;
    if (/request\s*\([^\n]{0,180}$/.test(before)) {
      const explicitMethod = callAfter.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)?.[1]?.toUpperCase();
      if ((explicitMethod ?? 'GET') === method) return true;
    }
    if (new RegExp(`['"]${method}['"]\\s*[,\\]]?[^\\n]{0,80}$`).test(before) && /request\s*\(\s*path\s*,\s*\{\s*method\s*\}/.test(content)) return true;
    if (new RegExp(`^[^\\n]{0,80}['"]${method}['"]`).test(after) && /request\s*\(\s*path\s*,\s*\{\s*method\s*\}/.test(content)) return true;
    if (new RegExp(`\\.${method.toLowerCase()}\\s*\\([^\\n]{0,140}$`).test(before)) return true;
    if (/fetch\s*\([^\n]{0,180}$/.test(before)) {
      const explicitMethod = callAfter.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)?.[1]?.toUpperCase();
      if ((explicitMethod ?? 'GET') === method) return true;
    }
  }
  return false;
}

function toolExecuted(content, tool) {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(?:_registeredTools|tools)(?:\\?\\.)?\\[['"]${escaped}['"]\\][\\s\\S]{0,180}?\\.handler\\s*\\(`).test(content)) return true;
  if (new RegExp(`tools\\.${escaped}\\.handler\\s*\\(`).test(content)) return true;
  if (new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*_registeredTools(?:\\.${escaped}|\\[['"]${escaped}['"]\\])[^;]*;[\\s\\S]{0,300}?\\1\\.handler\\s*\\(`).test(content)) return true;
  if (new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*getTool\\(['"]${escaped}['"]\\)[\\s\\S]{0,300}?await\\s+\\1\\s*\\(`).test(content)) return true;
  for (const match of content.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[([\s\S]*?)\];[\s\S]{0,800}?for\s*\([^)]*\bof\s+\1\)[\s\S]{0,500}?\.handler\s*\(/g)) {
    if (new RegExp(`['"]${escaped}['"]`).test(match[2])) return true;
  }
  return false;
}

if (!sourceInventory.mounted.some(route => route.factory === 'createApprovalRoutes' && route.mounted_path === '/api/approvals')) throw new Error('contract inventory mount parser self-check failed');
if (!endpointPattern('/swarms/spawns', '/:id/status').test('/swarms/spawns/${created.id}/status')) throw new Error('contract inventory endpoint matcher self-check failed');
if (!routeExecuted('await fetch(`${baseUrl}/approvals`, { method: \'POST\' });', 'POST', endpointPattern('/approvals', '/'))) throw new Error('contract inventory route execution self-check failed');
if (routeExecuted('await fetch(`${baseUrl}/approvals`);', 'POST', endpointPattern('/approvals', '/'))) throw new Error('contract inventory route method self-check failed');
if (routeExecuted('await fetch(`${baseUrl}/approvals/id`);', 'GET', endpointPattern('/approvals', '/'))) throw new Error('contract inventory route boundary self-check failed');
if (toolExecuted("expect(names).toContain('example_tool')", 'example_tool')) throw new Error('contract inventory MCP registration self-check failed');
if (!toolExecuted("const tool = getTool('example_tool'); await tool({});", 'example_tool')) throw new Error('contract inventory MCP execution self-check failed');

for (const declaration of sourceInventory.definitions) {
    const { module, factory, method, path, id } = declaration;
    const mountedPaths = sourceInventory.mounted.filter(item => item.module === module && item.factory === factory && item.method === method && item.path === path).map(item => item.mounted_path);
    const endpoints = mountedPaths.map(path => endpointPattern(undefined, path.replace(/^\/api/, '')));
    const relativeEndpoint = endpointPattern(undefined, path);
    const evidence = tests
      .filter(test => endpoints.some(endpoint => routeExecuted(test.content, method, endpoint))
        || (test.content.includes(`../routes/${module}`)
          && routeExecuted(test.content, method, relativeEndpoint)))
      .map(test => relative(root, test.path));
    const moduleEvidence = tests
      .filter(test => test.content.includes(`../routes/${module}`))
      .map(test => relative(root, test.path));
    const exemption = routeExemptions.get(id);
    routes.push({
      id,
      module,
      factory,
      method,
      path,
      mounted_paths: mountedPaths,
      registration_scope: mountedPaths.length ? 'api_source_declaration' : 'outside_api_mount_graph',
      evidence_kind: 'static_source_reference_not_execution',
      critical: critical.test(module),
      status: evidence.length ? 'source_referenced' : exemption ? 'exempted' : moduleEvidence.length ? 'module_covered' : 'unclassified',
      exemption: exemption || null,
      evidence,
      module_evidence: moduleEvidence,
    });
}

const toolFiles = files(join(root, 'packages/mcp-server/src/tools'), '.ts');
const tools = [];
for (const path of toolFiles) {
  const source = readFileSync(path, 'utf8');
  const module = basename(path, '.ts');
  for (const match of source.matchAll(/server\.registerTool\(\s*(['"`])([^'"`]+)\1/g)) {
    const evidence = tests
      .filter(test => test.path.includes('mcp-server') && toolExecuted(test.content, match[2]))
      .map(test => relative(root, test.path));
    tools.push({
      id: match[2],
      module,
      critical: /^(governance|orchestration)$/.test(module),
      status: evidence.length ? 'source_referenced' : 'unclassified',
      evidence_kind: 'static_source_reference_not_execution',
      evidence,
    });
  }
}

const report = {
  schema_version: 3,
  generated_at: new Date().toISOString(),
  evidence_limits: ['source_referenced means a static source-code match only; it is not proof a test ran, exercised the handler, or validated domain behavior.', 'Runtime comparison covers explicit API method/path registrations; implicit HEAD/OPTIONS and startup /health, /metrics, /explore and static SPA middleware are outside this API fixture.'],
  source_registration: {
    mounted: sourceInventory.mounted,
    outside_api_mount_graph: sourceInventory.outside_api_mount_graph,
    unsupported: sourceInventory.unsupported,
  },
  routes: {
    total: routes.length,
    source_referenced: routes.filter(item => item.status === 'source_referenced').length,
    module_covered: routes.filter(item => item.status === 'module_covered').length,
    unclassified: routes.filter(item => item.status === 'unclassified').length,
    critical_unclassified: routes.filter(item => item.critical && !['source_referenced', 'exempted'].includes(item.status)).map(item => item.id),
    critical_exempted: routes.filter(item => item.critical && item.status === 'exempted').map(item => ({ id: item.id, reason: item.exemption })),
    items: routes,
  },
  mcp_tools: {
    total: tools.length,
    source_referenced: tools.filter(item => item.status === 'source_referenced').length,
    unclassified: tools.filter(item => item.status === 'unclassified').length,
    critical_unclassified: tools.filter(item => item.critical && item.status === 'unclassified').map(item => item.id),
    items: tools,
  },
};

if (process.env.RUNTIME_ROUTE_INVENTORY_PATH) {
  const runtime = JSON.parse(readFileSync(resolve(root, process.env.RUNTIME_ROUTE_INVENTORY_PATH), 'utf8'));
  if (runtime.scope !== 'instantiated_api_router' || !Array.isArray(runtime.routes)) throw new Error('Invalid runtime route inventory');
  if (runtime.source_sha256 !== routeSourceFingerprint(root)) throw new Error('Stale runtime route inventory: route/auth source fingerprint differs');
  report.runtime_registration = { evidence_path: process.env.RUNTIME_ROUTE_INVENTORY_PATH, ...compareRuntimeRoutes(sourceInventory, runtime.routes) };
  report.dashboard_client = inventoryDashboardClient(root, runtime.routes);
} else {
  report.runtime_registration = { status: 'NOT_EXECUTED', reason: 'Supply RUNTIME_ROUTE_INVENTORY_PATH from the route-registration HTTP fixture; source references alone are not runtime proof.' };
}

const output = resolve(root, process.env.CONTRACT_INVENTORY_PATH || 'openspec/changes/assurance-truth-closure/contract-inventory.json');
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  routes: { total: report.routes.total, source_referenced: report.routes.source_referenced, critical_unclassified: report.routes.critical_unclassified.length },
  mcp_tools: { total: report.mcp_tools.total, source_referenced: report.mcp_tools.source_referenced, critical_unclassified: report.mcp_tools.critical_unclassified.length },
}, null, 2));
process.exitCode = report.routes.critical_unclassified.length || report.mcp_tools.critical_unclassified.length
  || sourceInventory.unsupported.length || report.runtime_registration.declared_not_registered?.length
  || report.runtime_registration.registered_not_declared?.length ? 1 : 0;
