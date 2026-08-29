#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

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
const routeFiles = files(join(root, 'packages/server/src/routes'), '.ts').filter(path => basename(path) !== 'index.ts');
const critical = /^(auth|approvals|backup|exports|council|openmythos|mcp|runtime-governance|swarms|spawns)$/;
const routes = [];
const routeIndex = readFileSync(join(root, 'packages/server/src/routes/index.ts'), 'utf8');
const factoryModules = new Map();
for (const match of routeIndex.matchAll(/import\s+\{([^}]+)\}\s+from\s+['"]\.\/([^'"]+)['"]/g)) {
  for (const factory of match[1].matchAll(/\b(create\w+Routes)\b/g)) factoryModules.set(factory[1], match[2]);
}
const mountPrefixes = new Map([...routeIndex.matchAll(/\{\s*prefix:\s*(['"])([^'"]*)\1[\s\S]{0,500}?router:\s*(create\w+Routes)\(/g)].map(match => [match[3], match[2]]));

function endpointPattern(factory, routePath) {
  const prefix = mountPrefixes.get(factory) ?? '';
  const endpoint = `${prefix}${routePath === '/' ? '' : routePath}` || '/';
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const path = escaped.replace(/:([A-Za-z0-9_]+)/g, '(?:\\$\\{[^}]+\\}|[^/\\s\"\'`?]+)');
  return new RegExp(`(?<![A-Za-z0-9_/-])(?:https?:\\/\\/[^/\\s\"'\\x60]+)?(?:\\/api)?${path}(?=[?&\\s\"'\\x60),}]|$)`);
}

function routeExecuted(content, method, endpoint) {
  for (const match of content.matchAll(new RegExp(endpoint.source, 'g'))) {
    const before = content.slice(Math.max(0, match.index - 180), match.index);
    const after = content.slice(match.index + match[0].length, match.index + match[0].length + 800);
    if (new RegExp(`request\\([^\\n]{0,140}['"]${method}['"][^\\n]{0,140}$`).test(before)) return true;
    if (new RegExp(`\\.${method.toLowerCase()}\\s*\\([^\\n]{0,140}$`).test(before)) return true;
    if (/fetch\s*\([^\n]{0,180}$/.test(before)) {
      const explicitMethod = after.match(/\bmethod\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)?.[1]?.toUpperCase();
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

if (mountPrefixes.get('createApprovalRoutes') !== '/approvals') throw new Error('contract inventory mount parser self-check failed');
if (!endpointPattern('createSpawnRoutes', '/:id/status').test('/swarms/spawns/${created.id}/status')) throw new Error('contract inventory endpoint matcher self-check failed');
if (!routeExecuted('await fetch(`${baseUrl}/approvals`, { method: \'POST\' });', 'POST', endpointPattern('createApprovalRoutes', '/'))) throw new Error('contract inventory route execution self-check failed');
if (routeExecuted('await fetch(`${baseUrl}/approvals`);', 'POST', endpointPattern('createApprovalRoutes', '/'))) throw new Error('contract inventory route method self-check failed');
if (routeExecuted('await fetch(`${baseUrl}/approvals/id`);', 'GET', endpointPattern('createApprovalRoutes', '/'))) throw new Error('contract inventory route boundary self-check failed');
if (toolExecuted("expect(names).toContain('example_tool')", 'example_tool')) throw new Error('contract inventory MCP registration self-check failed');
if (!toolExecuted("const tool = getTool('example_tool'); await tool({});", 'example_tool')) throw new Error('contract inventory MCP execution self-check failed');

for (const path of routeFiles) {
  const source = readFileSync(path, 'utf8');
  const module = basename(path, '.ts');
  const matcher = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  for (const match of source.matchAll(matcher)) {
    const factories = [...source.slice(0, match.index).matchAll(/(?:export\s+)?function\s+(create\w+Routes)\s*\(/g)];
    const factory = factories.at(-1)?.[1];
    const endpoint = endpointPattern(factory, match[3]);
    const evidence = tests
      .filter(test => routeExecuted(test.content, match[1].toUpperCase(), endpoint))
      .map(test => relative(root, test.path));
    const moduleEvidence = tests
      .filter(test => test.content.includes(`../routes/${module}`))
      .map(test => relative(root, test.path));
    routes.push({
      id: `${module}:${match[1].toUpperCase()}:${match[3]}`,
      module,
      method: match[1].toUpperCase(),
      path: match[3],
      critical: critical.test(module),
      status: evidence.length ? 'exercised' : moduleEvidence.length ? 'module_covered' : 'unclassified',
      evidence,
      module_evidence: moduleEvidence,
    });
  }
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
      status: evidence.length ? 'tested' : 'unclassified',
      evidence,
    });
  }
}

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  routes: {
    total: routes.length,
    tested: routes.filter(item => item.status === 'exercised').length,
    module_covered: routes.filter(item => item.status === 'module_covered').length,
    unclassified: routes.filter(item => item.status === 'unclassified').length,
    critical_unclassified: routes.filter(item => item.critical && item.status === 'unclassified').map(item => item.id),
    items: routes,
  },
  mcp_tools: {
    total: tools.length,
    tested: tools.filter(item => item.status === 'tested').length,
    unclassified: tools.filter(item => item.status === 'unclassified').length,
    critical_unclassified: tools.filter(item => item.critical && item.status === 'unclassified').map(item => item.id),
    items: tools,
  },
};

const output = resolve(root, process.env.CONTRACT_INVENTORY_PATH || 'openspec/changes/assurance-truth-closure/contract-inventory.json');
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  routes: { total: report.routes.total, tested: report.routes.tested, critical_unclassified: report.routes.critical_unclassified.length },
  mcp_tools: { total: report.mcp_tools.total, tested: report.mcp_tools.tested, critical_unclassified: report.mcp_tools.critical_unclassified.length },
}, null, 2));
process.exitCode = report.routes.critical_unclassified.length || report.mcp_tools.critical_unclassified.length ? 1 : 0;
