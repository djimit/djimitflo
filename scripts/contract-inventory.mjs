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

for (const path of routeFiles) {
  const source = readFileSync(path, 'utf8');
  const module = basename(path, '.ts');
  const matcher = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  for (const match of source.matchAll(matcher)) {
    const evidence = tests
      .filter(test => test.content.includes(`../routes/${module}`) && /\b(request|fetch|supertest)\s*\(/.test(test.content))
      .map(test => relative(root, test.path));
    routes.push({
      id: `${module}:${match[1].toUpperCase()}:${match[3]}`,
      module,
      method: match[1].toUpperCase(),
      path: match[3],
      critical: critical.test(module),
      status: evidence.length ? 'tested' : 'unclassified',
      evidence,
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
  schema_version: 1,
  generated_at: new Date().toISOString(),
  routes: {
    total: routes.length,
    tested: routes.filter(item => item.status === 'tested').length,
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
