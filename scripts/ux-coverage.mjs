// UX-0 (Phase UX): which mounted API routes does the dashboard call at all? Read-only, static: reuses the route-source
// inventory and the dashboard client scan. A route counts as covered when some this.request call in
// packages/dashboard/src/lib/api.ts matches its method + path; dynamic, unresolved calls are reported, never guessed.
// Usage: node scripts/ux-coverage.mjs [--json]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryDashboardClient, inventoryRouteSource } from './route-source-inventory.mjs';

/** Routers that only machines call (workers, host agents, webhooks, signed runtime callbacks) — no UI expected. */
export const MACHINE_FACTORIES = new Set(['createRemoteGymRoutes', 'createHostAgentRoutes', 'createTelegramRoutes', 'createAgentSocialRuntimeRoutes', 'createSpawnRoutes']);

/** Pure: per router factory, how many mounted routes the dashboard calls. */
export function coverageByRouter(mounted, calls) {
  const used = new Set(calls.flatMap((c) => c.matching_routes.map((p) => `${c.method} ${p}`)));
  const rows = new Map();
  for (const r of mounted) {
    const row = rows.get(r.factory) ?? { router: r.factory, machine: MACHINE_FACTORIES.has(r.factory), routes: 0, covered: 0 };
    row.routes += 1; if (used.has(`${r.method} ${r.mounted_path}`)) row.covered += 1;
    rows.set(r.factory, row);
  }
  const list = [...rows.values()].map((row) => ({ ...row, pct: row.routes ? Math.round((100 * row.covered) / row.routes) : 0 }))
    .sort((a, b) => Number(a.machine) - Number(b.machine) || b.routes - a.routes || a.router.localeCompare(b.router));
  const sum = (rs) => rs.reduce((a, r) => ({ routes: a.routes + r.routes, covered: a.covered + r.covered }), { routes: 0, covered: 0 });
  const operator = sum(list.filter((r) => !r.machine)); const machine = sum(list.filter((r) => r.machine));
  return {
    totals: { ...sum(list), operator, machine, operator_pct: operator.routes ? Math.round((100 * operator.covered) / operator.routes) : 0,
      unresolved_calls: calls.filter((c) => c.status === 'DYNAMIC_UNRESOLVED').length, unmatched_calls: calls.filter((c) => c.status === 'NO_REGISTERED_MATCH').length },
    routers: list,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  const { mounted } = inventoryRouteSource(root);
  const report = coverageByRouter(mounted, inventoryDashboardClient(root, mounted).calls);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    const t = report.totals;
    console.log(`routes ${t.routes}, dashboard-called ${t.covered}; operator routers ${t.operator.covered}/${t.operator.routes} (${t.operator_pct} %), machine ${t.machine.covered}/${t.machine.routes}; unresolved calls ${t.unresolved_calls}, unmatched ${t.unmatched_calls}`);
    console.log('| Router | Machine | Routes | UI-called | % |\n|---|---|---|---|---|');
    for (const r of report.routers) console.log(`| ${r.router} | ${r.machine ? 'yes' : ''} | ${r.routes} | ${r.covered} | ${r.pct} |`);
  }
}
