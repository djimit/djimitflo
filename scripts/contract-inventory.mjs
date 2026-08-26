#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const routeContractsOnly = process.argv.includes('--route-contracts-only');

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
const specFiles = [...files(join(root, 'specs'), '.md'), ...files(join(root, 'openspec'), '.md')]
  .map(path => ({ path, content: readFileSync(path, 'utf8').toLowerCase() }));
const dashboardFiles = [...files(join(root, 'packages/dashboard/src'), '.ts'), ...files(join(root, 'packages/dashboard/src'), '.tsx')]
  .map(path => ({ path, content: readFileSync(path, 'utf8').toLowerCase() }));
const critical = /^(auth|approvals|backup|exports|council|openmythos|mcp|runtime-governance|swarms|spawns)$/;
const routes = [];
const routeIndex = readFileSync(join(root, 'packages/server/src/routes/index.ts'), 'utf8');
const factoryModules = new Map([...routeIndex.matchAll(/import\s+\{[^}]*?(create\w+Routes)[^}]*?\}\s+from\s+['"]\.\/([^'"]+)['"]/g)].map(match => [match[1], match[2]]));
const mountPrefixes = new Map([...routeIndex.matchAll(/\{\s*prefix:\s*['"]([^'"]*)['"][\s\S]{0,180}?router:\s*(create\w+Routes)\(/g)].flatMap(match => {
  const module = factoryModules.get(match[2]);
  return module ? [[module, match[1]]] : [];
}));
mountPrefixes.set('swarms', '/swarms');

const routeSources = new Map(routeFiles.map(path => [basename(path, '.ts'), readFileSync(path, 'utf8')]));
const reachableModules = new Set(factoryModules.values());
reachableModules.add('metrics');
for (const module of reachableModules) {
  const source = routeSources.get(module) || '';
  for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
    if (routeSources.has(match[1])) reachableModules.add(match[1]);
  }
}

function contractEvidence(module) {
  const term = module.replaceAll('-', ' ');
  const prefix = mountPrefixes.get(module);
  const spec = specFiles.filter(file => file.content.includes(term) || file.content.includes(module));
  const uiNeedle = prefix && prefix !== '/' ? prefix.toLowerCase() : null;
  const ui = uiNeedle ? dashboardFiles.filter(file => file.content.includes(uiNeedle)) : [];
  return {
    reachable: reachableModules.has(module),
    spec: spec.map(file => relative(root, file.path)),
    dashboard: ui.map(file => relative(root, file.path)),
  };
}

function endpointPattern(module, routePath) {
  const prefix = mountPrefixes.get(module) ?? '';
  const endpoint = `${prefix}${routePath === '/' ? '' : routePath}` || '/';
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/:([A-Za-z0-9_]+)/g, '(?:\\$\\{[^}]+\\}|[^/\\s\"\'`?]+)'));
}

if (!endpointPattern('spawns', '/:id/status').test('/swarms/spawns/${created.id}/status')) throw new Error('contract inventory endpoint matcher self-check failed');

for (const path of routeFiles) {
  const source = readFileSync(path, 'utf8');
  const module = basename(path, '.ts');
  const contract = contractEvidence(module);
  const matcher = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  for (const match of source.matchAll(matcher)) {
    const endpoint = endpointPattern(module, match[3]);
    const evidence = tests
      .filter(test => /\b(request|fetch|supertest)\s*\(/.test(test.content) && endpoint.test(test.content))
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
      contract,
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
      .filter(test => test.path.includes('mcp-server') && test.content.includes(match[2]))
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
  schema_version: 2,
  generated_at: new Date().toISOString(),
  routes: {
    total: routes.length,
    tested: routes.filter(item => item.status === 'exercised').length,
    module_covered: routes.filter(item => item.status === 'module_covered').length,
    unclassified: routes.filter(item => item.status === 'unclassified').length,
    critical_unclassified: routes.filter(item => item.critical && item.status === 'unclassified').map(item => item.id),
    unreachable_modules: [...new Set(routes.filter(item => !item.contract.reachable).map(item => item.module))],
    functional_drift: ['council', 'openmythos', 'meta-orchestration'].flatMap(module => {
      const item = routes.find(route => route.module === module);
      if (!item) return [`${module}:implementation_missing`];
      return [
        ...(!item.contract.reachable ? [`${module}:unreachable`] : []),
        ...(item.contract.spec.length === 0 ? [`${module}:spec_missing`] : []),
        ...(item.contract.dashboard.length === 0 ? [`${module}:dashboard_missing`] : []),
      ];
    }),
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

const output = process.env.CONTRACT_INVENTORY_PATH
  ? resolve(root, process.env.CONTRACT_INVENTORY_PATH)
  : routeContractsOnly
    ? join(tmpdir(), 'djimitflo-route-contracts.json')
    : resolve(root, 'openspec/changes/assurance-truth-closure/contract-inventory.json');
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  routes: {
    total: report.routes.total,
    tested: report.routes.tested,
    critical_unclassified: report.routes.critical_unclassified.length,
    unreachable_modules: report.routes.unreachable_modules.length,
    functional_drift: report.routes.functional_drift.length,
  },
  mcp_tools: { total: report.mcp_tools.total, tested: report.mcp_tools.tested, critical_unclassified: report.mcp_tools.critical_unclassified.length },
}, null, 2));
const routeContractFailures = report.routes.unreachable_modules.length + report.routes.functional_drift.length;
process.exitCode = routeContractsOnly
  ? routeContractFailures ? 1 : 0
  : report.routes.critical_unclassified.length || report.mcp_tools.critical_unclassified.length || routeContractFailures ? 1 : 0;
