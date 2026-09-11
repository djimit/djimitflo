// Run from the audit checkout; generates source reachability, never operational certification.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { routeSourceFingerprint } from '../../scripts/route-source-inventory.mjs';

const root = resolve(import.meta.dirname, '../..');
const out = import.meta.dirname;
const read = path => readFileSync(resolve(root, path), 'utf8');
const save = (name, value) => writeFileSync(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`);
const inventoryFile = '../../openspec/changes/assurance-truth-closure/contract-inventory.json';
const inventory = JSON.parse(readFileSync(resolve(out, inventoryFile), 'utf8'));
const runtimeInventoryFile = 'reports/autonomous-audit-20260909/evidence/route-inventory-runtime-g289.json';
const runtimeInventory = JSON.parse(read(runtimeInventoryFile));
const runtimeEvidenceFile = resolve(root, runtimeInventoryFile).slice(`${out}/`.length);
const mountedDeclarations = inventory.source_registration.mounted;
const routeKey = route => `${route.method} ${route.mounted_path ?? route.path}`;
const authProbes = new Map(runtimeInventory.auth_http_probes.map(probe => [routeKey(probe), probe]));
const registeredRoutes = runtimeInventory.routes.map(route => ({
  ...route,
  registration_evidence: { kind: 'instantiated-api-registration', evidence_file: runtimeEvidenceFile, status: 'REGISTERED' },
  anonymous_auth_evidence: route.authenticated
    ? { ...authProbes.get(routeKey(route)), evidence_file: runtimeEvidenceFile, http_status: authProbes.get(routeKey(route))?.status, status: 'EXECUTED', scope: 'Anonymous admission only; no role/permission or domain semantics inferred' }
    : { status: 'NOT_EXECUTED', reason: 'Not auth-marked; may have a different credential/guard boundary' },
  semantic_execution: { status: 'NOT_EXECUTED', scope: 'Registration/auth sweep did not execute authorized domain behavior; other capability evidence remains separate' },
}));
const registeredByKey = new Map(registeredRoutes.map(route => [routeKey(route), route]));
function mountPrefix(declaration) {
  const endpoint = declaration.mounted_path;
  assert(endpoint.startsWith('/api/'), `Unexpected API mount ${endpoint}`);
  if (declaration.path === '/') return endpoint.slice('/api'.length) || '/';
  assert(endpoint.endsWith(declaration.path), `Route suffix drift ${endpoint}`);
  return endpoint.slice('/api'.length, -declaration.path.length) || '/';
}
assert.equal(runtimeInventory.scope, 'instantiated_api_router');
assert.equal(runtimeInventory.source_sha256, routeSourceFingerprint(root), 'Runtime registration evidence is stale for the current route/auth source');
assert.deepEqual(inventory.runtime_registration.declared_not_registered || [], []);
assert.deepEqual(inventory.runtime_registration.registered_not_declared || [], []);
assert.deepEqual(inventory.source_registration.unsupported || [], []);
assert.deepEqual([...new Set(mountedDeclarations.map(routeKey))].sort(), [...registeredByKey.keys()].sort());
assert.equal(authProbes.size, registeredRoutes.filter(route => route.authenticated).length);
for (const route of registeredRoutes.filter(route => route.authenticated)) assert.equal(authProbes.get(routeKey(route))?.status, 401, `Missing successful anonymous auth probe ${routeKey(route)}`);
for (const declaration of mountedDeclarations) {
  assert(inventory.routes.items.some(route => route.module === declaration.module && route.factory === declaration.factory && route.method === declaration.method && route.path === declaration.path && route.mounted_paths.includes(declaration.mounted_path)), `Missing source endpoint mapping ${routeKey(declaration)}`);
  mountPrefix(declaration);
}
if (process.argv.includes('--check-route-registration')) {
  assert(registeredRoutes.every(route => route.semantic_execution.status === 'NOT_EXECUTED'));
  assert.deepEqual([...new Set(mountedDeclarations.filter(route => route.module === 'swarm-orchestration').map(mountPrefix))].sort(), ['/swarm', '/swarm-v2', '/swarm-v2/social-runtime']);
  assert(mountedDeclarations.some(route => route.module === 'swarm-workers' && mountPrefix(route) === '/swarms'));
  assert(!mountedDeclarations.some(route => route.module === 'github-webhooks'));
  console.log(JSON.stringify({ status: 'PASS', scope: 'Read-only graph registration schema assertions; no artifacts regenerated', registered: registeredRoutes.length, anonymous_auth_probes: authProbes.size, semantic_execution: 'NOT_EXECUTED' }));
  process.exit(0);
}
const trancheCheckpoint = 'G72–G92 integrated server suite:2431passed/20skipped; build/type/lint pass;71/71configured scoped mutants killed with no survivors or errors.614 actual API registrations;608/608 marked-auth anonymous HTTP denials;581 source routes/251 contract-tested. [G92 maker/checker route evidence](evidence/loops-maker-checker-route-g92.md), [G91 loops HTTP evidence](evidence/loops-http-proof-g91.md), [G90 assurance recheck](evidence/assurance-truth-g89.md), [G89 SEGML Level 5 HTTP evidence](evidence/segml-level5-http-g89.md), [G88 intermittent workspace evidence](evidence/workspace-intermittent-integration-spine-g88.md), [G87 OIDC test-harness evidence](evidence/oidc-assertion-await-g87.md), [G86 SEGML Level 5 proof-boundary evidence](evidence/segml-level5-no-false-proof-g86.md), [G85 evolution re-check](evidence/evolution-loop-recheck-g85.md), [G84 proof-run isolation evidence](evidence/proof-run-cwd-isolation-g84.md), [G83 required ToolBroker principal evidence](evidence/tool-broker-principal-required-g83.md), [G82 production/local differential evidence](evidence/live-local-differential-g82.md), [G81 live boundary](evidence/live-public-boundary-g81.json), [G79 Astra dispatch evidence](evidence/astra-runtime-dispatch-continuation.md), [G78 OpenMythos/WorldLab intake evidence](evidence/openmythos-worldlab-attestation-continuation.md), [G80 bounded evolution evidence](evidence/meta-tuning-chain-g80.md), [actual evolution checkpoint](evidence/evolution-continuation.md), [context/governance continuation](evidence/context-governance-continuation.md) and [ToolBroker boundary continuation](evidence/tool-broker-principal-boundary.md) prove concurrent repository identity isolation, local draft persistence versus deployed Save drift, public availability/auth boundary, persisted runtime dispatch, guarded attestation/retest intake, confidence-gated durable loop-parameter tuning, corrected measurement, advisory context propagation, guarded intake, required principal-bound tokens, Level 5 service and HTTP non-false proof boundaries, a sound awaited rejection assertion, loop planning/review persistence, controlled maker/checker route execution and an explicitly retained intermittent workspace result, not live provider quality or improved unseen-task outcomes. Assurance remains BLOCKED by external evidence prerequisites; mission incomplete; no deployment or active background monitor.';
const trancheWithLatestEvidence = trancheCheckpoint.replace('[G92 maker/checker route evidence]', '[G114 SEGML history validation](evidence/segml-history-validation-g114.md), [G113 assurance recheck](evidence/assurance-recheck-g113.md), [G112 governance-feedback pagination](evidence/governance-feedback-pagination-g112.md), [G111 audit pagination validation](evidence/audit-pagination-validation-g111.md), [G110 assurance recheck](evidence/assurance-recheck-g110.md), [G109 workspace regression recheck](evidence/workspace-recheck-g109.md), [G108 server regression recheck](evidence/server-recheck-g108.md), [G107 advanced limit validation](evidence/advanced-limit-validation-g107.md), [G106 server regression recheck](evidence/server-recheck-g106.md), [G105 research threshold validation](evidence/research-limit-validation-g105.md), [G104 server regression recheck](evidence/server-recheck-g104.md), [G103 OpenMythos limit validation](evidence/openmythos-limit-validation-g103.md), [G102 workspace regression recheck](evidence/workspace-recheck-g102.md), [G101 workspace regression recheck](evidence/workspace-recheck-g101.md), [G100 SEGML Level 3 route validation](evidence/segml-l3-route-validation-g100.md), [G99 `/loops` evolution recheck](evidence/loops-recheck-g99.md), [G98 contracts and tables recheck](evidence/contracts-tables-recheck-g98.md), [G97 live production differential recheck](evidence/live-differential-recheck-g97.md), [G96 external assurance prerequisite recheck](evidence/external-prerequisite-recheck-g96.md), [G95 build and assurance recheck](evidence/build-assurance-recheck-g95.md), [G94 workspace regression recheck](evidence/workspace-recheck-g94.md), [G93 controlled product-source self-improvement](evidence/controlled-product-improvement-g93.md), [G92 maker/checker route evidence](evidence/loops-maker-checker-route-g92.md)');
const currentCheckpoint = trancheWithLatestEvidence
  .replace('[G114 SEGML history validation]', '[G121 work-item pagination validation](evidence/work-item-pagination-validation-g121.md), [G120 proactive-memory pagination validation](evidence/proactive-memory-pagination-validation-g120.md), [G119 Apex memory pagination validation](evidence/apex-memory-pagination-validation-g119.md), [G118 swarm message pagination validation](evidence/swarm-message-pagination-validation-g118.md), [G117 authority pagination validation](evidence/authority-pagination-validation-g117.md), [G116 gym history validation](evidence/gym-history-validation-g116.md), [G115 memory-evolution validation](evidence/memory-evolution-validation-g115.md), [G114 SEGML history validation]')
  .replace('[G92 maker/checker route evidence](evidence/loops-maker-checker-route-g92.md)', '[G92 maker/checker route evidence retained]')
  .replace('G72–G92', 'G72–G97')
  .replace('G72–G97', 'G72–G98')
  .replace('G72–G98', 'G72–G99')
  .replace('G72–G99', 'G72–G100')
  .replace('G72–G100', 'G72–G101')
  .replace('G72–G101', 'G72–G102')
  .replace('G72–G102', 'G72–G103')
  .replace('G72–G103', 'G72–G104')
  .replace('G72–G104', 'G72–G105')
  .replace('G72–G105', 'G72–G106')
  .replace('G72–G106', 'G72–G107')
  .replace('G72–G107', 'G72–G108')
  .replace('G72–G108', 'G72–G109')
  .replace('G72–G109', 'G72–G110')
  .replace('G72–G110', 'G72–G111')
  .replace('G72–G111', 'G72–G112')
  .replace('G72–G112', 'G72–G113')
  .replace('G72–G113', 'G72–G114')
  .replace('G72–G114', 'G72–G115')
  .replace('G72–G115', 'G72–G116')
  .replace('G72–G116', 'G72–G117')
  .replace('G72–G117', 'G72–G118')
  .replace('G72–G118', 'G72–G119')
  .replace('G72–G119', 'G72–G120')
  .replace('G72–G120', 'G72–G121')
  .replace('G72–G121', 'G72–G122')
  .replace('G72–G122', 'G72–G123')
  .replace('G72–G123', 'G72–G124')
  .replace('G72–G124', 'G72–G125')
  .replace('G72–G125', 'G72–G126')
  .replace('G72–G126', 'G72–G127')
  .replace('G72–G127', 'G72–G128')
  .replace('G72–G128', 'G72–G129')
  .replace('G72–G129', 'G72–G130')
  .replace('G72–G130', 'G72–G131')
  .replace('G72–G131', 'G72–G132')
  .replace('G72–G132', 'G72–G133')
  .replace('G72–G133', 'G72–G134')
  .replace('G72–G134', 'G72–G135')
  .replace('G72–G135', 'G72–G136')
  .replace('G72–G136', 'G72–G137')
  .replace('G72–G137', 'G72–G138')
  .replace('G72–G138', 'G72–G139')
  .replace('G72–G139', 'G72–G140')
  .replace('G72–G140', 'G72–G141')
  .replace('G72–G141', 'G72–G142')
  .replace('G72–G142', 'G72–G143')
  .replace('G72–G143', 'G72–G144')
  .replace('G72–G144', 'G72–G145')
  .replace('G72–G145', 'G72–G146')
  .replace('G72–G146', 'G72–G147')
  .replace('G72–G147', 'G72–G148')
  .replace('G72–G148', 'G72–G149')
  .replace('G72–G149', 'G72–G150')
  .replace('G72–G150', 'G72–G151')
  .replace('G72–G151', 'G72–G152')
  .replace('G72–G152', 'G72–G153')
  .replace('2431passed/20skipped', '2443passed/20skipped')
  .replace('2443passed/20skipped', '2444passed/20skipped')
  .replace('2444passed/20skipped', '2445passed/20skipped')
  .replace('2445passed/20skipped', '2446passed/20skipped')
  .replace('2446passed/20skipped', '2447passed/20skipped')
  .replace('2447passed/20skipped', '2448passed/20skipped')
  .replace('2448passed/20skipped', '2449passed/20skipped')
  .replace('2449passed/20skipped', '2450passed/20skipped')
  .replace('2450passed/20skipped', '2451passed/20skipped')
  .replace('2451passed/20skipped', '2452passed/20skipped')
  .replace('2452passed/20skipped', '2453passed/20skipped')
  .replace('2453passed/20skipped', '2454passed/20skipped')
  .replace('2454passed/20skipped', '2455passed/20skipped')
  .replace('2455passed/20skipped', '2459passed/20skipped')
  .replace('2459passed/20skipped', '2465passed/20skipped')
  .replace('2465passed/20skipped', '2467passed/20skipped')
  .replace('2467passed/20skipped', '2469passed/20skipped')
  .replace('2469passed/20skipped', '2470passed/20skipped')
  .replace('2470passed/20skipped', '2471passed/20skipped')
  .replace('2471passed/20skipped', '2473passed/20skipped')
  .replace('2473passed/20skipped', '2475passed/20skipped')
  .replace('2475passed/20skipped', '2477passed/20skipped')
  .replace('[G121 work-item pagination validation]', '[G122 swarm-intel pagination validation](evidence/swarm-intel-pagination-validation-g122.md), [G121 work-item pagination validation]')
  .replace('[G122 swarm-intel pagination validation]', '[G123 swarm-governance pagination validation](evidence/swarm-governance-pagination-validation-g123.md), [G122 swarm-intel pagination validation]')
  .replace('[G123 swarm-governance pagination validation]', '[G124 swarms pagination validation](evidence/swarms-pagination-validation-g124.md), [G123 swarm-governance pagination validation]')
  .replace('[G124 swarms pagination validation]', '[G125 self-improvement pagination validation](evidence/self-improvement-pagination-validation-g125.md), [G124 swarms pagination validation]')
  .replace('[G125 self-improvement pagination validation]', '[G126 runtime pagination validation](evidence/runtime-pagination-validation-g126.md), [G125 self-improvement pagination validation]')
  .replace('[G126 runtime pagination validation]', '[G127 compliance-usage pagination validation](evidence/compliance-usage-pagination-validation-g127.md), [G126 runtime pagination validation]')
  .replace('[G127 compliance-usage pagination validation]', '[G128 knowledge-multimodel pagination validation](evidence/knowledge-multimodel-pagination-validation-g128.md), [G127 compliance-usage pagination validation]')
  .replace('[G128 knowledge-multimodel pagination validation]', '[G129 council-redteam pagination validation](evidence/council-redteam-pagination-validation-g129.md), [G128 knowledge-multimodel pagination validation]')
  .replace('[G129 council-redteam pagination validation]', '[G130 explainer pagination validation](evidence/explainer-pagination-validation-g130.md), [G129 council-redteam pagination validation]')
  .replace('[G130 explainer pagination validation]', '[G131 observability window validation](evidence/observability-window-validation-g131.md), [G130 explainer pagination validation]')
  .replace('[G131 observability window validation]', '[G132 assurance recheck](evidence/assurance-recheck-g132.md), [G131 observability window validation]')
  .replace('[G132 assurance recheck]', '[G133 swarm confidence validation](evidence/swarm-confidence-validation-g133.md), [G132 assurance recheck]')
  .replace('[G133 swarm confidence validation]', '[G134 catalog search validation](evidence/catalog-search-validation-g134.md), [G133 swarm confidence validation]')
  .replace('[G134 catalog search validation]', '[G135 live reference UI recheck](evidence/live-reference-ui-recheck-g135.md), [G134 catalog search validation]')
  .replace('[G135 live reference UI recheck]', '[G136 authenticated local health evidence](evidence/live-authenticated-health-g136.md), [G135 live reference UI recheck]')
  .replace('[G136 authenticated local health evidence]', '[G137 mutation recheck](evidence/mutation-recheck-g137.md), [G136 authenticated local health evidence]')
  .replace('[G137 mutation recheck]', '[G138 upstream identity recheck](evidence/upstream-identity-recheck-g138.md), [G137 mutation recheck]')
  .replace('[G138 upstream identity recheck]', '[G139 proof-run detail UI](evidence/proof-run-detail-ui-g139.md), [G138 upstream identity recheck]')
  .replace('[G139 proof-run detail UI]', '[G140 dashboard route evidence closure](evidence/dashboard-route-evidence-closure-g140.md), [G139 proof-run detail UI]')
  .replace('[G140 dashboard route evidence closure]', '[G141 OIDC signature validation](evidence/oidc-signature-validation-g141.md), [G140 dashboard route evidence closure]')
  .replace('[G141 OIDC signature validation]', '[G142 governed loop regression](evidence/loops-regression-g142.md), [G141 OIDC signature validation]')
  .replace('[G142 governed loop regression]', '[G143 live identity auth boundary](evidence/live-identity-auth-boundary-g143.md), [G142 governed loop regression]')
  .replace('[G143 live identity auth boundary]', '[G144 production/local differential](evidence/live-differential-recheck-g144.md), [G143 live identity auth boundary]')
  .replace('[G144 production/local differential]', '[G145 dependency audit](evidence/dependency-audit-g145.md), [G144 production/local differential]')
  .replace('[G145 dependency audit]', '[G146 public explore leaderboard parity](evidence/explore-leaderboard-upstream-parity-g146.md), [G145 dependency audit]')
  .replace('[G146 public explore leaderboard parity]', '[G147 live Explore leaderboard](evidence/live-explore-leaderboard-g147.md), [G146 public explore leaderboard parity]')
  .replace('[G147 live Explore leaderboard]', '[G148 live Explore public sweep](evidence/live-explore-public-sweep-g148.md), [G147 live Explore leaderboard]')
  .replace('[G148 live Explore public sweep]', '[G149 Pipeline Builder drift](evidence/live-pipeline-builder-drift-g149.md), [G148 live Explore public sweep]')
  .replace('[G149 Pipeline Builder drift]', '[G150 OpenMythos executed evaluation](evidence/openmythos-executed-evaluation-g150.md), [G149 Pipeline Builder drift]')
  .replace('[G150 OpenMythos executed evaluation]', '[G151 loops self-validation](evidence/loops-regression-g151.md), [G150 OpenMythos executed evaluation]')
  .replace('[G151 loops self-validation]', '[G152 R46 reproducibility](evidence/openmythos-r46-reproducibility-g152.md), [G151 loops self-validation]')
  .replace('[G152 R46 reproducibility]', '[G153 live Astra runtime](evidence/astra-live-runtime-probe-g153.md), [G152 R46 reproducibility]')
  .replace('[G153 live Astra runtime]', '[G156 expert dispatch validation](evidence/expert-dispatch-parallel-validation-g156.md), [G155 loops self-check](evidence/loops-self-check-g155.md), [G154 browser authenticated crawl](evidence/browser-authenticated-crawl-g154.md), [G153 live Astra runtime]')
  .replace('G72–G153', 'G72–G156')
  .replace('[G156 expert dispatch validation]', '[G157 message-audit pagination validation](evidence/message-audit-pagination-validation-g157.md), [G156 expert dispatch validation]')
  .replace('G72–G156', 'G72–G157')
  .replace('581 source routes/251 contract-tested', '581 source routes/261 contract-tested')
  .replace('581 source routes/261 contract-tested', '581 source routes/264 contract-tested')
  .replace('581 source routes/264 contract-tested', '581 source routes/265 contract-tested')
  .replace('581 source routes/265 contract-tested', '581 source routes/266 contract-tested')
  .replace('581 source routes/266 contract-tested', '581 source routes/267 contract-tested')
  .replace('581 source routes/267 contract-tested', '581 source routes/275 contract-tested')
  .replace('581 source routes/275 contract-tested', '581 source routes/277 contract-tested')
  .replace('581 source routes/277 contract-tested', '581 source routes/279 contract-tested')
  .replace('581 source routes/284 contract-tested', '581 source routes/285 contract-tested')
  .replace('[G178 route-inventory recheck]', '[G180 route-inventory recheck](evidence/route-inventory-recheck-g180.md), [G178 route-inventory recheck]')
  .replace('[G178 broad mutation validation]', '[G180 broad mutation validation](evidence/mutation-validation-sweep-g180.md), [G178 broad mutation validation]')
  .replace('G72–G178', 'G72–G180')
  .replace('[G157 message-audit pagination validation]', '[G159 task-discussions pagination](evidence/tasks-discussions-pagination-g159.md), [G158 loops self-check](evidence/loops-self-check-g158.md), [G157 message-audit pagination validation]')
  .replace('G72–G157', 'G72–G158')
  .replace('G72–G158', 'G72–G159')
  .replace('[G159 task-discussions pagination]', '[G160 assurance recheck](evidence/assurance-truth-g160.md), [G159 task-discussions pagination]')
  .replace('G72–G159', 'G72–G160')
  .replace('[G160 assurance recheck]', '[G162 browser proof-run detail](evidence/browser-proof-run-detail-g162.md), [G160 assurance recheck]')
  .replace('G72–G160', 'G72–G162')
  .replace('[G162 browser proof-run detail]', '[G163 live public sweep](evidence/live-public-sweep-g163.md), [G162 browser proof-run detail]')
  .replace('G72–G162', 'G72–G163')
  .replace('[G163 live public sweep]', '[G164 browser crash recheck](evidence/browser-crash-recheck-g164.log), [G163 live public sweep]')
  .replace('G72–G163', 'G72–G164')
  .replace('[G164 browser crash recheck]', '[G164 loops self-check](evidence/loops-self-check-g164.md), [G164 browser crash recheck]')
  .replace('[G164 browser crash recheck]', '[G165 swarm-resources actions](evidence/browser-swarm-resources-actions-g165.log), [G164 browser crash recheck]')
  .replace('G72–G164', 'G72–G165')
  .replace('[G165 swarm-resources actions]', '[G165 loops self-check](evidence/loops-self-check-g165.md), [G165 swarm-resources actions]')
  .replace('[G165 swarm-resources actions]', '[G166 authenticated GET semantic recheck](evidence/route-read-sweep-g166.md), [G165 swarm-resources actions]')
  .replace('G72–G165', 'G72–G166')
  .replace('[G166 authenticated GET semantic recheck]', '[G167 broad authenticated GET sweep](evidence/route-read-sweep-g167.md), [G166 authenticated GET semantic recheck]')
  .replace('G72–G166', 'G72–G167')
  .replace('[G167 broad authenticated GET sweep]', '[G168 bounded mutation validation sweep](evidence/mutation-validation-sweep-g168.md), [G167 broad authenticated GET sweep]')
  .replace('G72–G167', 'G72–G168')
  .replace('[G168 bounded mutation validation sweep]', '[G169 bounded mutation validation sweep](evidence/mutation-validation-sweep-g169.md), [G168 bounded mutation validation sweep]')
  .replace('G72–G168', 'G72–G169')
  .replace('[G169 bounded mutation validation sweep]', '[G169 loops self-check](evidence/loops-self-check-g169.md), [G169 bounded mutation validation sweep]')
  .replace('[G169 bounded mutation validation sweep]', '[G170 safe mutation validation sweep](evidence/mutation-validation-sweep-g170.md), [G170 loops self-check](evidence/loops-self-check-g170.md), [G169 bounded mutation validation sweep]')
  .replace('G72–G169', 'G72–G170')
  .replace('[G170 safe mutation validation sweep]', '[G171 safe mutating-route sweep](evidence/mutation-validation-sweep-g171.md), [G170 safe mutation validation sweep]')
  .replace('G72–G170', 'G72–G171')
  .replace('[G171 safe mutating-route sweep]', '[G172 workflow resource-boundary replay](evidence/mutation-validation-sweep-g172.md), [G172 loops self-check](evidence/loops-self-check-g172.md), [G171 safe mutating-route sweep]')
  .replace('G72–G171', 'G72–G172')
  .replace('[G172 workflow resource-boundary replay]', '[G174 broad mutation validation](evidence/mutation-validation-sweep-g174.md), [G173 mutation recheck](evidence/mutation-recheck-g173.md), [G173 route-inventory recheck](evidence/route-inventory-recheck-g173.md), [G172 workflow resource-boundary replay]')
  .replace('G72–G173', 'G72–G174')
  .replace('G72–G172', 'G72–G173')
  .replace('581 source routes/279 contract-tested', '581 source routes/280 contract-tested')
  .replace('581 source routes/280 contract-tested', '581 source routes/284 contract-tested')
  .replace('581 source routes/284 contract-tested', '581 source routes/285 contract-tested')
  .replace('[G174 broad mutation validation]', '[G175 route-inventory recheck](evidence/route-inventory-recheck-g175.md), [G174 broad mutation validation]')
  .replace('G72–G173', 'G72–G175')
  .replace('[G175 route-inventory recheck]', '[G176 route-inventory recheck](evidence/route-inventory-recheck-g176.md), [G175 route-inventory recheck]')
  .replace('G72–G175', 'G72–G176')
  .replace('[G176 route-inventory recheck]', '[G177 route-inventory recheck](evidence/route-inventory-recheck-g177.md), [G176 route-inventory recheck]')
  .replace('G72–G176', 'G72–G177')
  .replace('[G177 route-inventory recheck]', '[G178 broad mutation validation](evidence/mutation-validation-sweep-g178.md), [G177 route-inventory recheck]')
  .replace('G72–G177', 'G72–G178')
  .replace('[G178 broad mutation validation]', '[G178 route-inventory recheck](evidence/route-inventory-recheck-g178.md), [G178 broad mutation validation]')
  .replace('[G178 route-inventory recheck]', '[G180 broad mutation validation](evidence/mutation-validation-sweep-g180.md), [G180 route-inventory recheck](evidence/route-inventory-recheck-g180.md), [G178 route-inventory recheck]')
  .replace('G72–G178', 'G72–G180')
  .replace('[G180 broad mutation validation]', '[G181 loops self-check](evidence/loops-self-check-g181.md), [G180 broad mutation validation]')
  .replace('G72–G180', 'G72–G181')
  .replace('[G181 loops self-check]', '[G182 `/loops` self-check](evidence/loops-self-check-g182.md), [G182 skills assignment boundary](evidence/mutation-validation-sweep-g182.md), [G182 route-inventory recheck](evidence/route-inventory-recheck-g182.md), [G181 loops self-check]')
  .replace('G72–G181', 'G72–G182')
  .replace('[G182 `/loops` self-check]', '[G183 live/GitHub differential](evidence/live-github-differential-g183.md), [G182 `/loops` self-check]')
  .replace('G72–G182', 'G72–G183')
  .replace('[G183 live/GitHub differential]', '[G184 core execution spine](evidence/core-spine-recheck-g184.md), [G183 live/GitHub differential]')
  .replace('G72–G183', 'G72–G184')
  .replace('[G184 core execution spine]', '[G185 targeted fix pipeline](evidence/fix-pipeline-validation-g185.md), [G184 core execution spine]')
  .replace('G72–G184', 'G72–G185')
  .replace('G72–G185 integrated server suite:2477passed/20skipped', 'G72–G185 integrated server suite:2479passed/20skipped')
  .replace('581 source routes/285 contract-tested', '581 source routes/286 contract-tested')
  .replace('581 source routes/286 contract-tested', '581 source routes/299 contract-tested')
  .replace('[G185 targeted fix pipeline]', '[G186 targeted fix pipeline](evidence/fix-pipeline-validation-g186.md), [G185 targeted fix pipeline]')
  .replace('G72–G185', 'G72–G186')
  .replace('[G186 targeted fix pipeline]', '[G187 security-fix loop recheck](evidence/fix-pipeline-validation-g187.md), [G186 targeted fix pipeline]')
  .replace('G72–G186', 'G72–G187')
  .replace('[G187 security-fix loop recheck](evidence/fix-pipeline-validation-g187.md), [G186 targeted fix pipeline]', '[G189 full server regression](evidence/full-server-regression-g189.md), [G187 security-fix loop recheck](evidence/fix-pipeline-validation-g187.md), [G186 targeted fix pipeline]')
  .replace('G72–G187', 'G72–G189')
  .replace('G72–G189 integrated server suite:2479passed/20skipped', 'G72–G189 integrated server suite:2481passed/20skipped')
  .replace('G72–G189 integrated server suite:2481passed/20skipped', 'G72–G201 integrated workspace suite:2774passed/20skipped')
  .replace('G72–G201 integrated workspace suite:2774passed/20skipped', 'G72–G202 integrated workspace suite:2775passed/20skipped')
  .replace('G72–G202 integrated workspace suite:2775passed/20skipped', 'G72–G203 integrated workspace suite:2776passed/20skipped')
  .replace('G72–G203 integrated workspace suite:2776passed/20skipped', 'G72–G204 integrated workspace suite:2777passed/20skipped')
  .replace('G72–G204 integrated workspace suite:2777passed/20skipped', 'G72–G205 integrated workspace suite:2777passed/20skipped')
  .replace('G72–G205 integrated workspace suite:2777passed/20skipped', 'G72–G206 integrated workspace suite:2777passed/20skipped')
  .replace('G72–G206 integrated workspace suite:2777passed/20skipped', 'G72–G207 integrated workspace suite:2777passed/20skipped')
  .replace('G72–G207 integrated workspace suite:2777passed/20skipped', 'G72–G208 integrated workspace suite:2777passed/20skipped')
  .replace('G72–G208 integrated workspace suite:2777passed/20skipped', 'G72–G209 integrated workspace suite:2778passed/20skipped')
  .replace('G72–G209 integrated workspace suite:2778passed/20skipped', 'G72–G210 integrated workspace suite:2778passed/20skipped')
  .replace('G72–G210 integrated workspace suite:2778passed/20skipped', 'G72–G211 integrated workspace suite:2780passed/20skipped')
  .replace('G72–G211 integrated workspace suite:2780passed/20skipped', 'G72–G213 integrated workspace suite:2780passed/20skipped')
  .replace('G72–G213 integrated workspace suite:2780passed/20skipped', 'G72–G214 integrated workspace suite:2780passed/20skipped')
  .replace('G72–G214 integrated workspace suite:2780passed/20skipped', 'G72–G215 integrated workspace suite:2780passed/20skipped')
  .replace('G72–G215 integrated workspace suite:2780passed/20skipped', 'G72–G216 integrated workspace suite:2782passed/20skipped')
  .replace('G72–G216 integrated workspace suite:2782passed/20skipped', 'G72–G220 integrated workspace suite:2783passed/20skipped')
  .replace('G72–G220 integrated workspace suite:2783passed/20skipped', 'G72–G221 integrated workspace suite:2783passed/20skipped')
  .replace('G72–G221 integrated workspace suite:2783passed/20skipped', 'G72–G222 integrated workspace suite:2785passed/20skipped')
  .replace('G72–G222 integrated workspace suite:2785passed/20skipped', 'G72–G223 integrated workspace suite:2786passed/20skipped')
  .replace('G72–G223 integrated workspace suite:2786passed/20skipped', 'G72–G224 integrated workspace suite:2786passed/20skipped')
  .replace('G72–G224 integrated workspace suite:2786passed/20skipped', 'G72–G225 integrated workspace suite:2786passed/20skipped')
  .replace('G72–G225 integrated workspace suite:2786passed/20skipped', 'G72–G226 integrated workspace suite:2788passed/20skipped')
  .replace('G72–G226 integrated workspace suite:2788passed/20skipped', 'G72–G227 integrated workspace suite:2790passed/20skipped')
  .replace('G72–G227 integrated workspace suite:2790passed/20skipped', 'G72–G228 integrated workspace suite:2791passed/20skipped')
  .replace('G72–G228 integrated workspace suite:2791passed/20skipped', 'G72–G229 integrated workspace suite:2793passed/20skipped')
  .replace('G72–G229 integrated workspace suite:2793passed/20skipped', 'G72–G230 integrated workspace suite:2795passed/20skipped')
  .replace('G72–G230 integrated workspace suite:2795passed/20skipped', 'G72–G232 integrated workspace suite:2796passed/20skipped')
  .replace('G72–G232 integrated workspace suite:2796passed/20skipped', 'G72–G233 integrated workspace suite:2797passed/20skipped')
  .replace('581 source routes/299 contract-tested', '581 source routes/303 contract-tested')
  .replace('581 source routes/300 contract-tested', '581 source routes/303 contract-tested')
  .replace('581 source routes/303 contract-tested', '581 source routes/305 contract-tested')
  .replace('581 source routes/305 contract-tested', '581 source routes/321 contract-tested')
  .replace('581 source routes/321 contract-tested', '581 source routes/327 contract-tested')
  .replace('581 source routes/327 contract-tested', '581 source routes/338 contract-tested')
  .replace('581 source routes/338 contract-tested', '581 source routes/339 contract-tested')
  .replace('581 source routes/339 contract-tested', '581 source routes/340 contract-tested')
  .replace('581 source routes/340 contract-tested', '581 source routes/346 contract-tested')
  .replace('[G189 full server regression]', '[G212 live/GitHub sweep](evidence/live-github-sweep-g212.md), [G212 assurance truth](evidence/assurance-truth-g212.md), [G211 catalog root-resolution](evidence/catalog-root-resolution-g211.md), [G211 workspace regression](evidence/workspace-regression-g211.md), [G211 server regression](evidence/full-server-regression-g211.md), [G211 `/loops` self-check](evidence/loops-self-check-g211.md), [G210 OIDC tamper hardening](evidence/oidc-tamper-test-g210.md), [G209 catalog compilation](evidence/catalog-compilation-g209.md), [G209 workspace regression](evidence/workspace-regression-g209.md), [G209 server regression](evidence/full-server-regression-g209.md), [G209 `/loops` self-check](evidence/loops-self-check-g209.md), [G208 `/loops` self-check](evidence/loops-self-check-g208.md), [G208 assurance truth](evidence/assurance-truth-g208.md), [G207 `/loops` self-check](evidence/loops-self-check-g207.md), [G207 workspace regression](evidence/workspace-regression-g207.md), [G207 SEGML training-root repair](evidence/full-server-regression-g207.md), [G206 live/GitHub sweep](evidence/live-github-sweep-g206.md), [G205 route inventory recheck](evidence/route-inventory-recheck-g205.md), [G204 `/loops` self-check](evidence/loops-self-check-g204.md), [G204 workspace regression](evidence/workspace-regression-g204.md), [G204 federation root-resolution repair](evidence/full-server-regression-g204.md), [G203 `/loops` self-check](evidence/loops-self-check-g203.md), [G203 workspace regression](evidence/workspace-regression-g203.md), [G203 OpenCode root-resolution repair](evidence/full-server-regression-g203.md), [G202 `/loops` self-check](evidence/loops-self-check-g202.md), [G202 workspace regression](evidence/workspace-regression-g202.md), [G202 goal-batch root-resolution repair](evidence/full-server-regression-g202.md), [G201 workspace regression](evidence/workspace-regression-g201.md), [G200 documentation-scan workspace-root repair](evidence/self-improvement-docs-g200.md), [G199 documentation route/server regression](evidence/full-server-regression-g199.md), [G198 workspace regression](evidence/workspace-regression-g198.md), [G197 full server regression](evidence/full-server-regression-g197.md), [G196 SBOM root-resolution repair](evidence/sbom-root-resolution-g196.md), [G195 workspace regression](evidence/workspace-regression-g195.md), [G194 repository-index semantic regression](evidence/full-server-regression-g194.md), [G193 workspace regression](evidence/workspace-regression-g193.md), [G192 full server regression](evidence/full-server-regression-g192.md), [G191 self-modification/SBOM route semantics](evidence/self-modification-sbom-g191.md), [G190 workspace regression](evidence/workspace-regression-g190.md), [G189 full server regression]')
  .replace('[G92 maker/checker route evidence]', '[G113 assurance recheck](evidence/assurance-recheck-g113.md), [G112 governance-feedback pagination](evidence/governance-feedback-pagination-g112.md), [G111 audit pagination validation](evidence/audit-pagination-validation-g111.md), [G110 assurance recheck](evidence/assurance-recheck-g110.md), [G109 workspace regression recheck](evidence/workspace-recheck-g109.md), [G108 server regression recheck](evidence/server-recheck-g108.md), [G107 advanced limit validation](evidence/advanced-limit-validation-g107.md), [G106 server regression recheck](evidence/server-recheck-g106.md), [G105 research threshold validation](evidence/research-limit-validation-g105.md), [G104 server regression recheck](evidence/server-recheck-g104.md), [G103 OpenMythos limit validation](evidence/openmythos-limit-validation-g103.md), [G102 workspace regression recheck](evidence/workspace-recheck-g102.md), [G101 workspace regression recheck](evidence/workspace-recheck-g101.md), [G100 SEGML Level 3 route validation](evidence/segml-l3-route-validation-g100.md), [G99 `/loops` evolution recheck](evidence/loops-recheck-g99.md), [G98 contracts and tables recheck](evidence/contracts-tables-recheck-g98.md), [G97 live production differential recheck](evidence/live-differential-recheck-g97.md), [G96 external assurance prerequisite recheck](evidence/external-prerequisite-recheck-g96.md), [G95 build and assurance recheck](evidence/build-assurance-recheck-g95.md), [G94 workspace regression recheck](evidence/workspace-recheck-g94.md), [G93 controlled product-source self-improvement](evidence/controlled-product-improvement-g93.md), [G92 maker/checker route evidence]');
// Keep the newest loop self-check visible in the generated human-readable checkpoint.
const latestCheckpoint = currentCheckpoint.replace('[G212 live/GitHub sweep]', '[G228 console route execution](evidence/console-route-validation-g228.md), [G228 server regression](evidence/full-server-regression-g228.md), [G228 workspace regression](evidence/workspace-regression-g228.md), [G228 `/loops` self-check](evidence/loops-self-check-g228.md), [G227 Fleet Mesh route-boundary repair](evidence/fleet-route-validation-g227.md), [G227 server regression](evidence/full-server-regression-g227.md), [G227 workspace regression](evidence/workspace-regression-g227.md), [G227 `/loops` self-check](evidence/loops-self-check-g227.md), [G226 Legal RuleOps route-boundary repair](evidence/legal-ruleops-validation-g226.md), [G226 server regression](evidence/full-server-regression-g226.md), [G226 workspace regression](evidence/workspace-regression-g226.md), [G226 `/loops` self-check](evidence/loops-self-check-g226.md), [G225 live public recheck](evidence/live-public-recheck-g225.md), [G224 assurance/reachability recheck](evidence/assurance-recheck-g224.md), [G224 `/loops` self-check](evidence/loops-self-check-g224.md), [G223 multi-model route-boundary repair](evidence/multi-model-validation-g223.md), [G223 server regression](evidence/full-server-regression-g223.md), [G223 workspace regression](evidence/workspace-regression-g223.md), [G223 `/loops` self-check](evidence/loops-self-check-g223.md), [G222 SEGML Level-4 auth-boundary repair](evidence/segml-l4-auth-boundary-g222.md), [G222 server regression](evidence/full-server-regression-g222.md), [G222 workspace regression](evidence/workspace-regression-g222.md), [G222 `/loops` self-check](evidence/loops-self-check-g222.md), [G221 assurance/reachability recheck](evidence/assurance-recheck-g221.md), [G221 `/loops` self-check](evidence/loops-self-check-g221.md), [G220 SEGML fine-tuning false-green repair](evidence/segml-finetuning-false-green-g220.md), [G220 server regression](evidence/full-server-regression-g220.md), [G220 workspace regression](evidence/workspace-regression-g220.md), [G220 `/loops` self-check](evidence/loops-self-check-g220.md), [G219 live public recheck](evidence/live-public-recheck-g219.md), [G218 SEGML tool-synthesis repair](evidence/segml-tool-synthesis-g218.md), [G218 workspace regression](evidence/workspace-regression-g218.md), [G218 `/loops` self-check](evidence/loops-self-check-g218.md), [G217 assurance/reachability recheck](evidence/assurance-recheck-g217.md), [G217 `/loops` self-check](evidence/loops-self-check-g217.md), [G216 workspace regression](evidence/workspace-regression-g216.md), [G215 `/loops` self-check](evidence/loops-self-check-g215.md), [G214 route/MCP proof](evidence/mcp-route-proof-g214.md), [G213 `/loops` self-check](evidence/loops-self-check-g213.md), [G212 live/GitHub sweep]');
const latestCheckpointWithG229 = latestCheckpoint.replace('[G228 console route execution]', '[G229 SEGML Level-4 and traceability route execution](evidence/segml-l4-traceability-validation-g229.md), [G229 server regression](evidence/full-server-regression-g229.md), [G229 workspace regression](evidence/workspace-regression-g229.md), [G229 `/loops` self-check](evidence/loops-self-check-g229.md), [G228 console route execution]');
const latestCheckpointWithG230 = latestCheckpointWithG229.replace('[G229 SEGML Level-4 and traceability route execution]', '[G230 remaining route execution](evidence/segml-platform-production-validation-g230.md), [G230 assurance recheck](evidence/assurance-recheck-g230.md), [G230 server regression](evidence/full-server-regression-g230.md), [G230 workspace regression](evidence/workspace-regression-g230.md), [G230 `/loops` self-check](evidence/loops-self-check-g230.md), [G229 SEGML Level-4 and traceability route execution]');
const latestCheckpointWithG232 = latestCheckpointWithG230.replace('[G230 remaining route execution]', '[G232 agent NL route execution](evidence/agent-nl-route-validation-g232.md), [G232 assurance recheck](evidence/assurance-recheck-g232.md), [G232 server regression](evidence/full-server-regression-g232.md), [G232 workspace regression](evidence/workspace-regression-g232.md), [G232 `/loops` self-check](evidence/loops-self-check-g232.md), [G230 remaining route execution]');
const latestCheckpointWithG233 = latestCheckpointWithG232.replace('[G232 agent NL route execution]', '[G233 AGI reasoning route execution](evidence/agi-reasoning-route-validation-g233.md), [G233 assurance recheck](evidence/assurance-recheck-g233.md), [G233 server regression](evidence/full-server-regression-g233.md), [G233 workspace regression](evidence/workspace-regression-g233.md), [G233 `/loops` self-check](evidence/loops-self-check-g233.md), [G232 agent NL route execution]');
const latestCheckpointWithG234 = latestCheckpointWithG233.replace('G72–G233 integrated workspace suite:2797passed/20skipped', 'G72–G234 integrated workspace suite:2797passed/20skipped').replace('[G233 AGI reasoning route execution]', '[G234 assurance recheck](evidence/assurance-recheck-g234.md), [G234 route-inventory recheck](evidence/route-inventory-recheck-g234.md), [G234 workspace regression](evidence/workspace-regression-g234.md), [G234 `/loops` self-check](evidence/loops-self-check-g234.md), [G233 AGI reasoning route execution]');
const latestCheckpointWithG235 = latestCheckpointWithG234.replace('G72–G234 integrated workspace suite:2797passed/20skipped', 'G72–G235 integrated workspace suite:2797passed/20skipped').replace('[G234 assurance recheck]', '[G235 real-server task-chain proof](evidence/e2e-task-chain-g235.md), [G234 assurance recheck]');
const latestCheckpointWithG236 = latestCheckpointWithG235.replace('[G235 real-server task-chain proof]', '[G236 `/loops` self-check](evidence/loops-self-check-g236.md), [G235 real-server task-chain proof]');
const latestCheckpointWithG237 = latestCheckpointWithG236.replace('G72–G235 integrated workspace suite:2797passed/20skipped', 'G72–G237 integrated workspace suite:2798passed/20skipped').replace('[G233 AGI reasoning route execution]', '[G237 AGI consensus route validation](evidence/agi-consensus-route-validation-g237.md), [G237 server regression](evidence/full-server-regression-g237.md), [G237 workspace regression](evidence/workspace-regression-g237.md), [G233 AGI reasoning route execution]');
const latestCheckpointWithG238 = latestCheckpointWithG237.replace('G72–G237 integrated workspace suite:2798passed/20skipped', 'G72–G238 integrated workspace suite:2798passed/20skipped').replace('[G237 AGI consensus route validation]', '[G238 `/loops` self-check](evidence/loops-self-check-g238.md), [G237 AGI consensus route validation]');
const latestCheckpointWithG239 = latestCheckpointWithG238.replace('[G238 `/loops` self-check]', '[G239 mutation regression](evidence/mutation-regression-g239.md), [G239 workspace regression](evidence/workspace-regression-g239.md), [G238 `/loops` self-check]').replace('G72–G238 integrated workspace suite:2798passed/20skipped', 'G72–G239 integrated workspace suite:2798passed/20skipped');
const latestCheckpointWithG240 = latestCheckpointWithG239.replace('[G239 mutation regression]', '[G240 `/loops` self-check](evidence/loops-self-check-g240.md), [G239 mutation regression]').replace('G72–G239 integrated workspace suite:2798passed/20skipped', 'G72–G240 integrated workspace suite:2798passed/20skipped');
const latestCheckpointWithG241 = latestCheckpointWithG240.replace('[G240 `/loops` self-check]', '[G241 assurance recheck](evidence/assurance-recheck-g241.md), [G240 `/loops` self-check]').replace('G72–G240 integrated workspace suite:2798passed/20skipped', 'G72–G241 integrated workspace suite:2798passed/20skipped');
const latestCheckpointWithG242 = latestCheckpointWithG241.replace('[G241 assurance recheck]', '[G242 live/GitHub recheck](evidence/live-github-recheck-g242.md), [G241 assurance recheck]').replace('G72–G241 integrated workspace suite:2798passed/20skipped', 'G72–G242 integrated workspace suite:2798passed/20skipped');
const latestCheckpointWithG243 = latestCheckpointWithG242.replace('[G242 live/GitHub recheck]', '[G243 contract/table/loop recheck](evidence/contract-table-loop-recheck-g243.md), [G243 `/loops` self-check](evidence/loops-self-check-g243.md), [G243 database-scope reconciliation](evidence/database-scope-reconciliation-g243.md), [G242 live/GitHub recheck]').replace('G72–G242 integrated workspace suite:2798passed/20skipped', 'G72–G243 integrated workspace suite:2798passed/20skipped');
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'packages'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(path => /\.[cm]?tsx?$/.test(path));
const sources = new Map(sourceFiles.map(path => [path, read(path)]));

const api = read('packages/dashboard/src/lib/api.ts');
const starts = [...api.matchAll(/^  async (\w+)\(/gm)];
const clients = starts.map((match, i) => {
  const body = api.slice(match.index, starts[i + 1]?.index ?? api.length);
  return { handler: match[1], requests: [...body.matchAll(/this\.request(?:<[^;]*?>)?\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]), source: 'packages/dashboard/src/lib/api.ts' };
});
const app = read('packages/dashboard/src/App.tsx');
const pages = [...app.matchAll(/<Route (?:path="([^"]+)"|index) element=\{<(\w+)/g)].map(m => {
  const file = [...sources.keys()].find(path => path.startsWith('packages/dashboard/src/pages/') && path.endsWith(`/${m[2]}.tsx`));
  const components = [...dependencies(file)].filter(path => /\/pages\/|\/components\/|\/hooks\//.test(path));
  const text = components.map(path => sources.get(path) ?? '').join('\n');
  const handlers = [...new Set([...text.matchAll(/api\.(\w+)(?:<[^;]*?>)?\(/g)].map(m => m[1]))];
  const direct = [...text.matchAll(/api\.(request|fetch|get|post)(?:<[^;]*?>)?\(\s*['"`]([^'"`]+)['"`]/g)].map(m => ({ handler: m[1], requests: [m[2]], source: file }));
  return { route: m[1] ? `/${m[1].replace(/^\//, '')}` : '/', component: m[2], file, components, handlers, requests: [...clients.filter(client => handlers.includes(client.handler)), ...direct], state: 'PARTIAL', actual_execution_evidence: [] };
});

function browserState(observation) {
  const ui = observation.ui ?? '';
  const failures = observation.failed ?? [];
  const errors = observation.errors ?? [];
  if (/Something crashed|Something went wrong|Cannot read properties|Error loading|Failed to load/i.test(ui)) return { state: 'BROKEN', reason: 'Visible error boundary or failed-load state, regardless of pageerror events' };
  if (observation.route === '/authority' && /canonical authority ledger.*not.*provisioned/i.test(ui)
    && failures.length > 0 && failures.every(failure => failure.status === 503 && /\/api\/authority\//.test(failure.url)) && errors.length === 0) {
    return { state: 'INTENTIONAL', reason: 'Explicit unavailability: canonical authority ledger is not provisioned' };
  }
  if (errors.length || failures.length) return { state: 'BROKEN', reason: 'Browser exception or failing request observed; inspect preserved evidence' };
  if (/\bloading\b|scanning workstation ports|request pending/i.test(ui)) return { state: 'PARTIAL', reason: 'Loading/pending observation has no completed outcome' };
  return { state: 'PARTIAL', reason: 'Page rendered; this snapshot does not prove controls were exercised or outcomes persisted' };
}
assert.equal(browserState({ ui: "Something crashed\nCannot read properties of undefined (reading 'toFixed')", errors: [], failed: [] }).state, 'BROKEN');
assert.equal(browserState({ ui: 'Loading...', errors: [], failed: [] }).state, 'PARTIAL');
assert.equal(browserState({ route: '/authority', ui: 'The canonical authority ledger has not been provisioned on this instance.', failed: [{ status: 503, url: 'http://localhost/api/authority/stats' }] }).state, 'INTENTIONAL');
assert.equal(browserState({ ui: 'Tasks\nNew Task', errors: [], failed: [] }).state, 'PARTIAL');
function normalizeBrowserObservation(item) {
  let route = item?.route ?? item?.pathname ?? item?.url;
  if (typeof route === 'string' && /^https?:\/\//.test(route)) route = new URL(route).pathname;
  return { ...item, route, ui: item?.ui ?? item?.text };
}
assert.equal(normalizeBrowserObservation({pathname:'http://127.0.0.1:3187/tasks/fixture/review',text:'Review'}).route, '/tasks/fixture/review');
assert.equal(normalizeBrowserObservation({url:'http://127.0.0.1:3187/'}).route, '/');
const browserArtifacts = [];
for (const file of readdirSync(resolve(out, 'evidence')).filter(name => /^browser.*\.log$/.test(name))
  .sort((a, b) => statSync(resolve(out, 'evidence', a)).mtimeMs - statSync(resolve(out, 'evidence', b)).mtimeMs || a.localeCompare(b))) {
  const evidenceFile = `evidence/${file}`;
  const raw = readFileSync(resolve(out, evidenceFile), 'utf8');
  const blocks = [...raw.matchAll(/### Result\r?\n([\s\S]*?)(?=\r?\n### |$)/g)];
  let parsed = false;
  for (const block of blocks) {
    let observations;
    try { observations = JSON.parse(block[1].trim()); } catch { continue; }
    if (!Array.isArray(observations)) observations = observations.results ?? [observations];
    observations = observations.map(normalizeBrowserObservation);
    for (const observation of observations.filter(item => typeof item?.route === 'string')) {
      const page = pages.find(candidate => new RegExp(`^${candidate.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`).test(observation.route));
      const assessed = browserState(observation);
      const evidence = { kind: 'browser-local', evidence_file: evidenceFile, artifact_modified_at: statSync(resolve(out, evidenceFile)).mtime.toISOString(), ...observation, ...assessed,
        scope: 'Browser route/DOM/network snapshot; controls are inventoried, not assumed exercised', control_execution: 'not established by this snapshot' };
      browserArtifacts.push(evidence);
      if (page) {
        page.actual_execution_evidence.push(evidence);
        page.state = assessed.state;
        page.state_reason = assessed.reason;
        page.latest_browser_evidence = evidenceFile;
      }
      parsed = true;
    }
  }
  if (!parsed) browserArtifacts.push({ kind: 'browser-artifact', evidence_file: evidenceFile, state: 'PARTIAL', reason: 'No parseable route observation; raw failure/artifact retained' });
}

const db = resolve(root, process.env.AUDIT_DB_PATH || '.data/audit.sqlite');
if (existsSync(db)) {
  const tableRun = spawnSync(process.execPath, ['scripts/table-reachability.mjs', db], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (tableRun.status !== 0) throw new Error(tableRun.stderr);
  writeFileSync(resolve(out, 'evidence/table-reachability.json'), tableRun.stdout);
}
const tableReport = JSON.parse(read('reports/autonomous-audit-20260909/evidence/table-reachability.json'));
const runtimeDb = resolve(root, process.env.RUNTIME_AUDIT_DB_PATH || '.data/djimitflo.sqlite');
let runtimeTableReport = null;
if (existsSync(runtimeDb)) {
  const runtimeTableRun = spawnSync(process.execPath, ['scripts/table-reachability.mjs', runtimeDb], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (runtimeTableRun.status !== 0) throw new Error(runtimeTableRun.stderr);
  writeFileSync(resolve(out, 'evidence/table-reachability-runtime.json'), runtimeTableRun.stdout);
  runtimeTableReport = JSON.parse(runtimeTableRun.stdout);
}
const tableScope = {
  graph_database: db,
  graph_database_evidence: 'evidence/table-reachability.json',
  root_gate_database: runtimeDb,
  root_gate_database_evidence: runtimeTableReport ? 'evidence/table-reachability-runtime.json' : null,
  graph_table_count: tableReport.tables,
  root_gate_table_count: runtimeTableReport?.tables ?? null,
  graph_only_tables: runtimeTableReport ? tableReport.report.map(table => table.table).filter(name => !runtimeTableReport.report.some(candidate => candidate.table === name)) : [],
  root_gate_only_tables: runtimeTableReport ? runtimeTableReport.report.map(table => table.table).filter(name => !tableReport.report.some(candidate => candidate.table === name)) : [],
  graph_unreachable_count: tableReport.unreachable.length,
  root_gate_unreachable_count: runtimeTableReport?.unreachable.length ?? null,
  interpretation: 'The capability graph uses the disposable audit fixture for reproducible semantic evidence; the root audit:tables gate uses the runtime-shaped djimitflo database. Both scans are retained so runtime-only schema cannot disappear from the graph silently; the two runtime-only tables have source readers and writers.'
};
const schemaDb = new Database(db, { readonly: true, fileMustExist: true });
const runtimeReference = path => !/\/__tests__\/|\.test\.|\/node_modules\/|\/database\/(?:schema|migrat)/.test(path);
const tables = tableReport.report.map(table => {
  const writers = table.writers.filter(runtimeReference);
  const readers = table.readers.filter(runtimeReference);
  const quoted = table.table.replaceAll('"', '""');
  return { ...table, foreign_keys: schemaDb.prepare(`PRAGMA foreign_key_list("${quoted}")`).all(), columns: schemaDb.prepare(`PRAGMA table_info("${quoted}")`).all(), runtime_writers: writers, runtime_readers: readers, state: writers.length ? readers.length ? 'ACTIVE' : 'WRITE-ONLY' : readers.length ? 'READ-ONLY' : 'UNREACHABLE', classification_evidence: 'SQL source references excluding tests/schema/migrations; ACTIVE is source reachability, not execution proof' };
});
schemaDb.close();

function dependencies(path, visited = new Set()) {
  if (visited.has(path)) return visited;
  visited.add(path);
  for (const match of (sources.get(path) ?? '').matchAll(/(?:from\s+|import\s*\()['"]([.][^'"]+)['"]/g)) {
    const base = resolve(root, dirname(path), match[1]).slice(root.length + 1).replace(/\.js$/, '');
    const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(name => sources.has(name));
    if (target) dependencies(target, visited);
  }
  return visited;
}
const modules = [...new Set(inventory.routes.items.map(r => r.module))].map(module => {
  const file = `packages/server/src/routes/${module}.ts`;
  const closure = [...dependencies(file)];
  const routes = inventory.routes.items.filter(route => route.module === module);
  const moduleDeclarations = mountedDeclarations.filter(route => route.module === module);
  const prefixes = [...new Set(moduleDeclarations.map(mountPrefix))];
  const ui = pages.filter(page => page.requests.some(client => client.requests.some(request => prefixes.some(prefix => prefix !== '/' && (request === prefix || request.startsWith(`${prefix}/`) || request.startsWith(`${prefix}?`))))));
  const handlers = ui.flatMap(page => page.requests).filter(client => client.requests.some(request => prefixes.some(prefix => prefix !== '/' && (request === prefix || request.startsWith(`${prefix}/`) || request.startsWith(`${prefix}?`)))));
  return {
    capability: module, state: 'PARTIAL', ui_screens: ui.map(page => page.route),
    ui_actions: [...new Set(handlers.map(handler => handler.handler))], frontend_handlers: handlers,
    api_mounts: prefixes, routes,
    instantiated_api_routes: moduleDeclarations.map(route => registeredByKey.get(routeKey(route))),
    registration_scope: moduleDeclarations.length ? 'instantiated_api_router' : 'outside_api_mount_graph',
    services: closure.filter(path => path.includes('/services/')),
    domain_logic: closure.filter(path => path.includes('/execution/')),
    storage: tables.filter(table => [...table.runtime_readers, ...table.runtime_writers].some(path => closure.includes(path))).map(table => table.table),
    external_dependencies: closure.flatMap(path => [...(sources.get(path) ?? '').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map(m => m[1])).filter((value, i, all) => all.indexOf(value) === i),
    runtime_effect: null, observability: closure.filter(path => /audit|websocket|evidence|observability/.test(path)),
    tests: [...new Set(routes.flatMap(route => route.evidence))], actual_execution_evidence: [],
    limits: ['Import closure overapproximates reachable behavior; fixture test matching does not prove execution or UI semantics.',
      ...(module === 'github-webhooks' ? ['Mounted at startup outside the /api router; external delivery and deployment identity remain unverified.'] : []),
      ...(module === 'explore-public' ? ['Mounted separately at startup /explore; outside the instantiated API fixture, not classified as missing.'] : [])],
  };
});
const graph = {
  schema_version: 1, generated_at: new Date().toISOString(), source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  evidence_levels: { source: 'References only', tested: 'Executed fixture assertions', live: 'Observed running domain transitions; never inferred from HTTP 200' },
  limitations: ['Dynamic route/client expressions and component-owned actions need browser/manual tracing.', 'OpenAPI is method/path/auth metadata, not request/response schemas.', 'Table classifications show source reachability; production table liveness is unproven.'],
  capabilities: modules, dashboard_routes: pages, mcp_tools: inventory.mcp_tools, tables,
  runtime_only_tables: runtimeTableReport ? runtimeTableReport.report.filter(table => tableScope.root_gate_only_tables.includes(table.table)).map(table => ({ ...table, classification_evidence: 'Runtime-shaped root-gate database only; source reachability is represented by the graph fixture table set' })) : [],
  api_registration: {
    scope: runtimeInventory.scope, source_inventory: inventoryFile, runtime_evidence: runtimeEvidenceFile,
    source_sha256: runtimeInventory.source_sha256, generated_at: runtimeInventory.generated_at,
    comparison: inventory.runtime_registration, entries: registeredRoutes,
    auth_summary: runtimeInventory.auth_http_summary,
    dashboard_client: inventory.dashboard_client,
    source_outside_api_mount_graph: inventory.source_registration.outside_api_mount_graph,
    limits: runtimeInventory.limits,
  },
  semantic_execution_review: {
    status: 'BROAD_READ_SWEEP_PLUS_BOUNDED_MUTATION_VALIDATION',
    evidence_file: 'evidence/fix-pipeline-validation-g187.md',
    scope: 'All 308 registered GET routes plus 285 mounted mutating routes were replayed against fresh disposable runtimes. Streaming/degraded boundaries, unknown-resource errors and malformed-input validation scope are explicit; full valid mutation semantics remain unverified.',
    route_level_semantic_execution: 'NOT_EXECUTED',
  },
  table_analysis: { limitations: tableReport.limitations, regression_evidence: 'evidence/table-reachability-test.log', semantic_review: 'TABLE_REACHABILITY_REVIEW.md', runtime_filter: 'Exclude tests/schema/migrations from source read/write classification; DELETE targets are writes, not reads', database_scope: tableScope },
  database_scope: tableScope,
  browser_artifact_history: browserArtifacts,
  live_public_boundary: { evidence_file: 'evidence/live-public-boundary-g81.json', scope: 'Anonymous public availability/version and auth boundary only; authenticated production semantics and deployment identity remain unverified' },
};
const approvals = modules.find(module => module.capability === 'approvals');
const catalog = modules.find(module => module.capability === 'catalog');
const catalogPath = resolve(root, '.data/agent-catalog.sqlite');
graph.additional_databases = [];
if (existsSync(catalogPath)) {
  const catalogDb = new Database(catalogPath, {readonly:true, fileMustExist:true});
  const catalogTables = ['profiles','evaluations','activations','audit_ledger','overlaps'].map(table => ({
    table, columns: catalogDb.prepare(`PRAGMA table_info("${table}")`).all(),
    foreign_keys: catalogDb.prepare(`PRAGMA foreign_key_list("${table}")`).all(),
    source: 'packages/agent-catalog/src/db.ts',
    scope: 'Separate catalog database; not one of the165 core tables; runtime artifact preparation is not agent dispatch',
  }));
  graph.additional_databases.push({database:'agent-catalog',tables:catalogTables});
  catalog.storage.push(...catalogTables.map(({table}) => `agent-catalog.${table}`));
  catalogDb.close();
}
catalog.runtime_effect = 'Durable compiled artifact preparation/deactivation; explicitly no runtime registration or execution';
catalog.state = 'PARTIAL';
catalog.limits.push('G51 repaired: four emitted instruction surfaces now scanned, unchanged overlap semantics. Regex detection is heuristic, not universal prompt-injection protection; artifacts are not installed runtimes.');
catalog.actual_execution_evidence.push({kind:'historical-failure',evidence_file:'evidence/catalog-gate-coverage-probe.json',observed:'Before repair, known instruction override was accepted from four emitted surfaces',scope:'Actual in-memory catalog/artifacts; no provider exploitation or deployment claimed'});
catalog.actual_execution_evidence.push({kind:'tested',evidence_file:'evidence/catalog-surface-green.log',observed:'Exact governed patch applied locally: all26maintained catalog tests pass, including four previously red instruction-surface regressions',scope:'No installed target or universal injection-defense claim'});
const productImprovement = {kind:'live-runtime-fixture',evidence_file:'evidence/controlled-product-improvement-v2.json',observed:'Actual Astra-low maker, checker and security checker;3programmatic fixture approvals,3completed tasks,76events,15audit records; security HOLD before third review;26immutable tests/lint/type-check pass; proposal applied locally after independent review',scope:'Operator-supplied defect in exact product-source copy; same model/account, distinct worktrees/threads; reviewers inspect check evidence without rerunning tests; no human signoff, merge, deployment or universal ToolBroker mediation'};
catalog.actual_execution_evidence.push(productImprovement);
modules.find(module => module.capability === 'loops').actual_execution_evidence.push(productImprovement,
  {kind:'tested',evidence_file:'evidence/loop-completion-green-tests.log',observed:'107passed/1skipped: runtime review proof, risk retention, approval continuation, retry security leases, incomplete/terminal completion gates and cancelled HTTP409',scope:'Local process/SQLite/HTTP fixtures; regression index side effect stubbed; original ad-hoc probe side-effect limitation in loop-completion-summary.md'});
catalog.actual_execution_evidence.push(
  {kind:'tested',evidence_file:'evidence/catalog-lifecycle-final.log',observed:'Current-version evaluation and invalidation, audit rollback, declared foreign-key enforcement; maintained TypeScript tests only',scope:'Local SQLite/component fixture; compiled target installation not verified'},
  {kind:'tested',evidence_file:'evidence/catalog-http-green.log',observed:'Eight real HTTP/auth/file-SQLite regressions incl reopen, exact score, static-gate bypass rejection, atomic batch rollback and authorization',scope:'Only singleton location substituted; no provider registered or started'});
if (existsSync(resolve(out, 'evidence/catalog-ui-final-db.json'))) catalog.actual_execution_evidence.push({kind:'live-local',evidence_file:'evidence/catalog-ui-final-db.json',observed:'Browser prepares Codex/OpenClaw artifacts, reloads, deactivates; SQLite contains matching audit and artifacts, no matching core agents',scope:'Controls/error recovery in catalog-ui-summary.md; compiled artifact compatibility with installed CLIs not certified'});
for (const [file, corrected] of [['browser-task-first-proof.json',false],['browser-task-second-proof.json',true]]) {
  if (!existsSync(resolve(out, `evidence/${file}`))) continue;
  const observation = JSON.parse(readFileSync(resolve(out, `evidence/${file}`), 'utf8'));
  const evidence = {kind:'live-local',evidence_file:`evidence/${file}`,observation,
    scope: corrected ? 'Actual browser form/execute -> Astra-low -> selected disposable Git fixture -> immutable test -> native streamed events with durable timestamps -> terminal audit. No maker/checker or human approval required in this local low-risk task.' : 'Historical first provider run executed fixture change/test but lacked terminal audit and correct native stream/timestamps; not retrospective success proof.'};
  modules.find(module => module.capability === 'tasks').actual_execution_evidence.push(evidence);
  for (const page of pages.filter(page => ['/tasks','/tasks/:taskId','/tasks/:taskId/review'].includes(page.route))) page.actual_execution_evidence.push(evidence);
}
pages.find(page => page.route === '/login')?.actual_execution_evidence.push({kind:'browser-local',evidence_file:'evidence/browser-postbuild-login-final.log',observed:'Actual form login navigates from /login to protected root',scope:'Disposable local identity; not production authentication or exhaustive auth lifecycle'});
graph.route_permission_contract = { review: 'ROUTE_PERMISSION_REVIEW.md',
  regression_evidence: 'evidence/route-permissions-final.log', historical_failure: 'evidence/route-permissions-red.log',
  scope: 'Existing permissions only; real seven-role JWT/HTTP fixtures and static undefined-literal guard; no role expansion or promotion bypass' };
graph.intentional_route_unavailability = [
  ...['enable', 'disable'].map(action => ({ route: `/api/apex/plugins/:id/${action}`, code: 'PLUGIN_ACTIVATION_UNAVAILABLE', missing_link: 'Shared trusted runtime plugin activation/deactivation' })),
  ...['enable', 'disable'].map(action => ({ route: `/api/skills/:id/${action}`, code: 'SKILL_ACTIVATION_UNAVAILABLE', missing_link: 'Router-local flags do not control the separate execution-engine loader' })),
  { route: '/api/skills/reload', code: 'SKILL_RELOAD_UNAVAILABLE', missing_link: 'Router-local reload does not reload runtime skill admission' },
].map(item => ({ ...item, method: 'POST', state: 'INTENTIONAL', required_permission: 'manage:config', status: 503 }));
for (const module of modules.filter(module => ['apex', 'skills', 'swarm-intel'].includes(module.capability))) {
  module.actual_execution_evidence.push({ kind: 'tested', evidence_file: 'evidence/route-permissions-final.log',
    observed: 'Actual JWT role admission and isolated domain writes; unsupported activation explicitly503; assignment visible to engine loader only for operator-admitted skill',
    scope: 'No provider, scheduler, plugin activation or capability promotion; static spelling guard is separate from role execution proof' });
}
const swarmPlanning = modules.find(module => module.capability === 'swarm-orchestration');
swarmPlanning.runtime_effect = 'Planning-session registration and durable list/progress; execution intentionally rejects SWARM_RUNTIME_EXECUTOR_NOT_CONFIGURED';
swarmPlanning.actual_execution_evidence.push({ kind: 'tested', evidence_file: 'evidence/swarm-session-persistence-final.log', observed: 'Create session, recreate service, preserve list/progress; both instances read current DB; execute remains blocked without state mutation', scope: 'Isolated SQLite fixture; no real swarm executor or external dispatch' });
modules.find(module => module.capability === 'tasks').actual_execution_evidence.push({ kind: 'tested', evidence_file: 'evidence/task-recovery-loop-final.log',
  observed: 'Startup-only reconciliation; genuine in-process mock fails, unknown external attempt pauses with protected hold; metadata/status/delete/dispatch and loop predecessor replay cannot bypass; queued admission and completed loop result reuse preserved',
  scope: 'Isolated SQLite/HTTP fixtures; no external provider exit verification, automatic hold clearance or global duplicate-intent prevention' });
modules.find(module => module.capability === 'console').actual_execution_evidence.push({ kind: 'tested', evidence_file: 'evidence/persistence-final.log',
  observed: 'Audit anchor durable read/reopen, missing delivery configuration rejection and local HTTP retry with immutable identity', scope: 'Local HTTP/SQLite fixture, not external WORM attestation or automatic restart retry' });
modules.find(module => module.capability === 'repositories')?.actual_execution_evidence.push({ kind: 'tested', evidence_file: 'evidence/persistence-final.log',
  observed: 'Repository parent UPSERT, durable chunk search after reopen, removed content removal and transaction rollback', scope: 'Actual disposable files/SQLite; lexical search only' });
modules.find(module => module.capability === 'repositories')?.actual_execution_evidence.push(
  { kind: 'tested', evidence_file: 'evidence/repository-scan-green.log', observed: '28scanner/validator tests: actual Git first-scan identity, durable instruction shape/scope, atomic failed-rescan rollback, latest findings with preserved history, legacy-column migration', scope: 'Disposable filesystem and SQLite; heuristic scanner only' },
  { kind: 'live-local', evidence_file: 'evidence/repository-durable-proof.json', observed: 'Browser rescan detail/reload joined to independent persisted Git identity, instruction scopes and scan-bound finding IDs', scope: 'Local disposable repository; no external repository mutation' },
  { kind: 'live-local', evidence_file: 'evidence/repository-effective-stack-http.json', observed: 'Authenticated effective instruction stack includes nested subtree and excludes similarly prefixed sibling', scope: 'Local actual API with scanned persisted instructions' });
modules.find(module => module.capability === 'approvals')?.actual_execution_evidence.push({ kind: 'live-local', evidence_file: 'evidence/deny-ui-durable-proof.json', observed: 'Two actual UI denials persist distinct decider/reason and one audit event each; tasks stay pending review-only with zero execution events', scope: 'Local synthetic identities; browser fault/retry proof separately documented in deny-ui-summary.md' });
modules.find(module => module.capability === 'messages')?.actual_execution_evidence.push({ kind: 'tested', evidence_file: 'evidence/message-owner-final.log', observed: 'Legacy overlap replay cannot override durable cross-store ownership;74focused tests', scope: 'Separate reproduced legacy/backfill defect; original G34 intermittent cause still unknown' });
graph.mcp_agent_registration = {
  tool: 'djimitflo_spawn_agent', state: 'INTENTIONAL', registration_only: true, execution_started: false,
  source: 'packages/mcp-server/src/tools/orchestration.ts',
  actual_execution_evidence: [{ kind: 'tested', evidence_file: 'evidence/mcp-registration-final.log',
    observed: 'Idle registration persists requested metadata; no task/lease or budget allocation; repeated same-role/runtime registration succeeds; snapshot/anonymous/unauthorized writes rejected',
    scope: 'In-memory SQLite fixture with real unique-name constraint, not real agent execution' }],
  historical_failure: 'evidence/mcp-registration-red.log',
  execution_seam: 'POST /api/tasks/:id/execute or governed loop services; separate task/ownership/permission/policy checks required',
};
modules.find(module => module.capability === 'agents').actual_execution_evidence.push(...graph.mcp_agent_registration.actual_execution_evidence);
graph.runtime_lifecycle_execution = [];
for (const [file, capabilities, routes, scope] of [
  ['server-restart.json', ['tasks', 'workstation'], ['/tasks/:taskId', '/workstation-urls'], 'Local server restart preserved one disposable task and Codex/Astra configuration; native scanner found listener and memory candidates envelope was valid. No in-flight task recovery proved.'],
  ['server-shutdown.json', ['tasks'], ['/tasks/:taskId'], 'Authenticated WebSocket closed with1001 on local server shutdown; bounded process exit. No reconnect or in-flight executor cancellation proved by this artifact.'],
  ['task-crash-probe.json', ['tasks'], ['/tasks/:taskId'], 'Historical failing actual server SIGKILL/restart probe using synthetic in-process mock only; no external provider used.'],
  ['task-crash-recovery-final.json', ['tasks'], ['/tasks/:taskId'], 'Corrected actual server SIGKILL/restart mock task transitions running to failed. Real provider survival/outcome remains unknown; no automatic replay or killing proved.'],
]) {
  const evidenceFile = `evidence/${file}`;
  if (!existsSync(resolve(out, evidenceFile))) continue;
  const evidence = { kind: 'live-local', evidence_file: evidenceFile, observation: JSON.parse(readFileSync(resolve(out, evidenceFile), 'utf8')), scope };
  graph.runtime_lifecycle_execution.push(evidence);
  for (const module of modules.filter(module => capabilities.includes(module.capability))) module.actual_execution_evidence.push(evidence);
  for (const page of pages.filter(page => routes.includes(page.route))) page.actual_execution_evidence.push(evidence);
}
approvals.actual_execution_evidence.push({ kind: 'tested', command: 'npm run test --workspace=@djimitflo/server -- manual-approvals.test.ts approvals-http.test.ts security-invariants.test.ts', evidence_file: 'evidence/audit-approval-final.log', observed: 'Real JWT and HTTP role queue/detail/approval state plus audit and manual-review isolation', scope: 'Isolated fixture, not browser-to-real-agent completion' });
modules.find(module => module.capability === 'exports').actual_execution_evidence.push({ kind: 'tested', command: 'npm run test --workspace=@djimitflo/server -- critical-http-contracts.test.ts manual-approvals.test.ts tasks.test.ts', evidence_file: 'evidence/task-approval-integration.log', observed: 'NDJSON export IDs exactly equal ordered stored audit event IDs', scope: 'Isolated HTTP and SQLite fixture' });
const authority = modules.find(module => module.capability === 'authority');
authority.state = tables.some(table => table.table === 'authority_events') ? 'PARTIAL' : 'INTENTIONAL';
authority.runtime_effect = 'Returns AUTHORITY_LEDGER_UNAVAILABLE with HTTP 503 when the canonical ledger is not provisioned. No schema or approval authority is created by this audit.';
authority.actual_execution_evidence.push({ kind: 'tested', command: 'npm run test --workspace=@djimitflo/server -- approvals-http.test.ts', evidence_file: 'evidence/audit-role-final.log', observed: 'All roles checked: missing ledger produces explicit 503 for audit roles; provisioned fixture is readable; other roles get 403', scope: 'Real JWT/HTTP/SQLite fixture' });
graph.governance_boundaries = [
  { capability: 'tool_broker_mandatory_mediation', state: 'DISCONNECTED', evidence: 'Production source has constructor/getter but no executor effect-boundary evaluation/validation calls; broker unit correctness is a separate property.' },
  { capability: 'mcp_authority_emission', state: 'PARTIAL', evidence: 'authority-tools.test.ts executes HOLD/DENY insertion and rejects anonymous, snapshot, viewer and caller-issued ALLOW events; identity derives from authenticated MCP principal.', external_dependency: 'Canonical authority ledger provisioned by existing authorized producer' },
];
const mcpSmokePath = 'reports/autonomous-audit-20260909/evidence/mcp-live-smoke.json';
if (existsSync(resolve(root, mcpSmokePath))) {
  graph.mcp_transport_execution = JSON.parse(read(mcpSmokePath));
  graph.mcp_transport_execution.evidence_file = mcpSmokePath;
  graph.mcp_transport_execution.scope = 'Auxiliary MCP built from working patch, real SDK SSE client, existing disposable API runtime and persisted local SQLite approval. No external deployment or approval completion.';
  approvals.actual_execution_evidence.push({ kind: 'live-local', evidence_file: 'evidence/mcp-live-smoke.json', state: graph.mcp_transport_execution.state, scope: graph.mcp_transport_execution.scope, observed: graph.mcp_transport_execution.proven });
}
const controlledRuntimeFile = 'evidence/controlled-runtime-improvement.json';
if (existsSync(resolve(out, controlledRuntimeFile))) {
  const observation = JSON.parse(readFileSync(resolve(out, controlledRuntimeFile), 'utf8'));
  const evidence = { kind: observation.evidence_class, evidence_file: controlledRuntimeFile, observation,
    scope: 'Supervised real-runtime disposable-repository maker/checker improvement; fixture approvals; no autonomous proposal discovery, merge, promotion or production deployment' };
  graph.controlled_runtime_improvement = evidence;
  for (const capability of ['tasks', 'loops']) {
    const module = modules.find(item => item.capability === capability);
    if (module) { module.actual_execution_evidence.push(evidence); module.runtime_effect = `${observation.runtime}/${observation.model} supervised maker/checker loop; tasks ${observation.tasks.map(task => task.status).join(', ')}; promoted=${observation.promoted}`; }
  }
  for (const page of pages.filter(page => ['/tasks', '/goals-loops'].includes(page.route))) page.actual_execution_evidence.push(evidence);
}
graph.controlled_product_improvement = productImprovement;
modules.find(module => module.capability === 'loops').runtime_effect = 'Supervised real product-source maker/checker/security-checker proposal; locally applied after independent review; no autonomous discovery, human signoff, merge or deployment';
modules.find(module => module.capability === 'github-webhooks').runtime_effect = 'Signed startup-mounted issue intake creates/updates an untrusted work item only; no implicit goal, loop or worker execution';
pages.find(page => page.route === '/goals-loops')?.actual_execution_evidence.push(productImprovement);
const loopBrowserProof = {kind:'browser-local',evidence_file:'evidence/g54-browser-proof.json',observed:'Actual browser/REST/SQLite/restart: explicit manual runtime, security approval HOLD with refreshed ownership, cancellation sends no completion POST, explicit confirmation persists server operator identity; completed and pending approval states survive restart',scope:'Explicit synthetic mock maker fixtures; no provider approved; in-flight loop labels become interrupted on restart; not exhaustive controls/mobile/production proof'};
modules.find(module => module.capability === 'loops').actual_execution_evidence.push(loopBrowserProof);
pages.find(page => page.route === '/goals-loops')?.actual_execution_evidence.push(loopBrowserProof);
pages.find(page => page.route === '/goals-loops')?.actual_execution_evidence.push({kind:'browser-local',evidence_file:'evidence/g54-layout-proof.json',observed:'Start Loop controls within card and main horizontal overflow absent after native CSS wrapping at1200and1440pixels',scope:'Start form only; not whole-page/mobile certification'});
pages.find(page => page.route === '/goals-loops')?.actual_execution_evidence.push({kind:'browser-local',evidence_file:'evidence/g54-header-proof.json',observed:'Selected run title stays readable on one line; actions and Start controls within cards at1200and1440pixels',scope:'Scoped layout only; no domain mutations'});
const interventionProof = {kind:'browser-local',evidence_file:'evidence/intervention-resumed-db.json',observed:'Actual browser REST SQLite pause/proposal/advice/restart/resume; actual claim ID and authenticated audit; original gates/risk preserved; zero tasks/leases',scope:'Quiescent admission only, no live CLI checkpoint/drain or automatic dispatch'};
for (const capability of ['intervention','goals','loops']) modules.find(module=>module.capability===capability)?.actual_execution_evidence.push(interventionProof);
modules.find(module=>module.capability==='intervention').runtime_effect='Quiescent admission pause/resume, proposed knowledge with real ID, advisory decisions and canonical audit; never forged verifier evidence';
pages.find(page=>page.route==='/goals-loops')?.actual_execution_evidence.push(interventionProof);
for (const capability of ['loops','spawns','tasks']) modules.find(module=>module.capability===capability)?.actual_execution_evidence.push({kind:'tested',evidence_file:'evidence/routing-continuation.md',observed:'Runtime planning advice is persisted without implicit provider/mock choice; nested and engine pause admission including semaphore/fallback and canonical historical task binding',scope:'Local mock/process/service fixtures, no provider recovery or automatic runtime selection'});
modules.find(module=>module.capability==='telegram').actual_execution_evidence.push({kind:'tested',evidence_file:'evidence/telegram-continuation.md',observed:'Actual grammY updates and HTTP/shared API/SQLite/mock engine prove caller mapping, ownership, audit, approval continuation, cancellation and delivery error handling',scope:'Simulated provider transport; real Telegram delivery and durable replay deduplication unverified'});
modules.find(module=>module.capability==='telegram').runtime_effect='Mapped caller uses shared authenticated task/approval API; local transport chain proven, real delivery unavailable';
modules.find(module=>module.capability==='knowledge').actual_execution_evidence.push({kind:'tested',evidence_file:'evidence/knowledge-validator-real-service.log',observed:'Configured existing canonical validator accepts actual data bundle; missing validation blocks apply',scope:'Structural acceptance only;172of174 documents excluded from typed checks'});
modules.find(module=>module.capability==='openmythos').actual_execution_evidence.push({kind:'tested',evidence_file:'evidence/openmythos-admissibility-current.json',observed:'Actual structural checks pass; certification remains blocked on maturity and unexecuted repeatability/heldout, despite corrected false-green predicate',scope:'No external corpus mutation or certification'});
const conversionProof = {kind:'browser-local',evidence_file:'evidence/work-item-browser-after-restart.json',observed:'Actual Goal click and duplicate authenticated API request retain one goal; reload/server restart match file-SQLite; no linked loop execution',scope:'Work-item conversion only; security recurrence and prior orphan cleanup unchanged'};
modules.find(module=>module.capability==='work-items').actual_execution_evidence.push(conversionProof);
pages.find(page=>page.route==='/swarm-resources')?.actual_execution_evidence.push(conversionProof);
modules.find(module=>module.capability==='work-items').runtime_effect='Atomic eligible work-item conversion and idempotent goal linkage; no implicit loop execution';
const organizationProof = {kind:'browser-local',evidence_file:'evidence/organization-browser-db.json',observed:'Assigned/default/assigned browser roundtrip adopts token before reload, retains available options and records correct canonical audit transitions',scope:'Token/context workflow only; not universal tenant row or WebSocket isolation'};
modules.find(module=>module.capability==='organizations').actual_execution_evidence.push(organizationProof);
modules.find(module=>module.capability==='auth').actual_execution_evidence.push({kind:'tested',evidence_file:'evidence/auth-principal-continuation.md',observed:'Current role/email and selected membership across three HTTP admission paths; live sockets reject account changes before delivery; malformed login validated',scope:'Real local HTTP/TCP/SQLite; no idle revoke timer, in-flight cancellation or access-JWT logout revocation'}, organizationProof);
modules.find(module=>module.capability==='auth').actual_execution_evidence.push({kind:'tested',evidence_file:'evidence/refresh-token-continuation.md',observed:'Historical G63 existing refresh service passes22expiry/rotation/rollback/lineage tests',scope:'At G63 disconnected; operational browser connection is separately proven by G66'});
const sessionCapability = modules.find(module=>module.capability==='auth');
sessionCapability.ui_screens = ['/login', 'protected dashboard layout'];
sessionCapability.ui_actions = ['login', 'restoreSession', 'authenticatedFetch', 'logout'];
sessionCapability.frontend_handlers.push({source:'packages/dashboard/src/lib/auth-store.ts',handler:'browser session lifecycle',requests:['/auth/login','/auth/refresh','/auth/me','/auth/logout']});
sessionCapability.runtime_effect = 'Browser session survives access expiry, same-family organization switch, concurrent tabs and server restart; logout revokes all five fixture generations';
sessionCapability.actual_execution_evidence.push({kind:'browser-local',evidence_file:'evidence/browser-session-db-final.json',observed:'Actual browser login, expired-token 401/refresh/retry, organization adoption, two-tab single rotation, server restart and logout; five refresh generations revoked and formerly valid JWT refused',scope:'Local Chromium/SQLite; no production, universal tenant isolation, sidless bearer revocation or retroactive cancellation claim'}, {kind:'tested',evidence_file:'evidence/g66-session-closure.md',observed:'HTTP audit rollback, current membership at WebSocket connection/delivery and MCP live principal/family enforcement',scope:'Local HTTP/TCP/SQLite and SDK tests; snapshot/standalone MCP rejects browser-session JWTs'});
graph.current_continuation = { gaps: ['G72', 'G73', 'G74', 'G75', 'G76', 'G77', 'G78', 'G79', 'G80', 'G82', 'G83', 'G84', 'G86', 'G87', 'G88', 'G89', 'G90', 'G91', 'G92', 'G93', 'G94', 'G95', 'G96', 'G97', 'G99', 'G100', 'G101', 'G102', 'G103', 'G104', 'G105', 'G106', 'G107', 'G108', 'G109', 'G110', 'G111', 'G112', 'G113', 'G114', 'G115', 'G116', 'G117', 'G118', 'G119', 'G120', 'G121'], integration_status: 'SCOPED_PASS', mission_status: 'NOT_COMPLETE', assurance_status: 'BLOCKED', scope: latestCheckpointWithG243, tests: { passed: 2443, skipped: 20 }, scoped_mutation: { killed: 71, survived: 0, uncovered: 0, errors: 0 }, goals: { registered: 6, completed: ['E1'], active_external_audit: ['E2', 'E3', 'E4'], prerequisites_open: ['E5', 'E6'] }, strategy_applied: false, bounded_loop_tuning_applied: true, causal_improvement_proven: false, background_monitor_active: false };
graph.current_continuation.gaps.push('G122');
graph.current_continuation.tests.passed = 2444;
graph.current_continuation.gaps.push('G123');
graph.current_continuation.tests.passed = 2445;
graph.current_continuation.gaps.push('G124');
graph.current_continuation.tests.passed = 2446;
graph.current_continuation.gaps.push('G125');
graph.current_continuation.tests.passed = 2447;
graph.current_continuation.gaps.push('G126');
graph.current_continuation.tests.passed = 2448;
graph.current_continuation.gaps.push('G127');
graph.current_continuation.tests.passed = 2449;
graph.current_continuation.gaps.push('G128');
graph.current_continuation.tests.passed = 2450;
graph.current_continuation.gaps.push('G129');
graph.current_continuation.tests.passed = 2451;
graph.current_continuation.gaps.push('G130');
graph.current_continuation.tests.passed = 2452;
graph.current_continuation.gaps.push('G131');
graph.current_continuation.tests.passed = 2453;
graph.current_continuation.gaps.push('G132');
graph.current_continuation.tests.passed = 2453;
graph.current_continuation.gaps.push('G133');
graph.current_continuation.tests.passed = 2454;
graph.current_continuation.gaps.push('G134');
graph.current_continuation.tests.passed = 2455;
graph.current_continuation.gaps.push('G135');
graph.current_continuation.tests.passed = 2455;
graph.current_continuation.gaps.push('G136');
graph.current_continuation.tests.passed = 2455;
graph.current_continuation.gaps.push('G137');
graph.current_continuation.tests.passed = 2455;
graph.current_continuation.gaps.push('G138');
graph.current_continuation.tests.passed = 2455;
graph.current_continuation.gaps.push('G139');
graph.current_continuation.tests.passed = 2455;
graph.current_continuation.gaps.push('G140');
graph.current_continuation.tests.passed = 2455;
graph.current_continuation.gaps.push('G141');
graph.current_continuation.tests.passed = 2459;
graph.current_continuation.gaps.push('G142');
graph.current_continuation.gaps.push('G143');
graph.current_continuation.gaps.push('G144');
graph.current_continuation.gaps.push('G145');
graph.current_continuation.gaps.push('G146');
graph.current_continuation.tests.passed = 2465;
graph.current_continuation.gaps.push('G147');
graph.current_continuation.gaps.push('G148');
graph.current_continuation.gaps.push('G149');
graph.current_continuation.gaps.push('G150');
graph.current_continuation.gaps.push('G151');
graph.current_continuation.gaps.push('G152');
graph.current_continuation.gaps.push('G153');
graph.current_continuation.gaps.push('G154');
graph.current_continuation.gaps.push('G155');
graph.current_continuation.gaps.push('G156');
graph.current_continuation.gaps.push('G157');
graph.current_continuation.gaps.push('G177');
graph.current_continuation.gaps.push('G178');
graph.current_continuation.tests.passed = 2475;
graph.current_continuation.tests.passed = 2477;
graph.current_continuation.gaps.push('G190', 'G191', 'G192', 'G193', 'G194', 'G195', 'G196', 'G197', 'G198', 'G199', 'G200', 'G201', 'G202', 'G203', 'G204', 'G205', 'G206', 'G207', 'G208', 'G209', 'G210', 'G211', 'G212', 'G213', 'G214', 'G215', 'G217', 'G218', 'G219', 'G220', 'G221', 'G222', 'G223', 'G224', 'G225', 'G226', 'G227', 'G228');
graph.current_continuation.tests.passed = 2780;
graph.current_continuation.tests.passed = 2786;
graph.current_continuation.tests.passed = 2791;
graph.current_continuation.tests.passed = 2793;
graph.current_continuation.tests.passed = 2795;
graph.current_continuation.tests.passed = 2796;
graph.current_continuation.tests.passed = 2798;
graph.current_continuation.gaps.push('G234');
graph.current_continuation.gaps.push('G235');
graph.current_continuation.gaps.push('G236');
graph.current_continuation.gaps.push('G237');
graph.current_continuation.gaps.push('G238');
graph.current_continuation.gaps.push('G239');
graph.current_continuation.gaps.push('G240');
graph.current_continuation.gaps.push('G241');
graph.current_continuation.gaps.push('G242');
graph.current_continuation.gaps.push('G243');
const continuationEvidence = [
  { capabilities: ['assurance', 'contracts', 'verification'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/contract-table-loop-recheck-g243.md',observed:'Fresh route and MCP contract inventories retain 581/346 and 56/56 zero-critical coverage alongside both table scans and the canonical loop self-check',scope:'Local static/fixture evidence only; authorized domain semantics and production identity remain separate'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g243.md',observed:'Canonical governed-loop Vitest self-check passes 23 files, 291 tests and one explicit skip after database-scope reconciliation',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['assurance', 'database', 'tables', 'verification'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/database-scope-reconciliation-g243.md',observed:'Compared the graph audit fixture (.data/audit.sqlite, 165 tables) with the root-gate runtime-shaped database (.data/djimitflo.sqlite, 167 tables); the two runtime-only tables context_cache and github_webhook_deliveries are now reported explicitly and the 11 unreachable tables are identical',scope:'Read-only local SQLite schema/reachability comparison; source SQL reachability remains heuristic and no production liveness or table deletion is inferred'} },
  { capabilities: ['verification', 'security', 'governance'], routes: [], evidence: {kind:'live-public',evidence_file:'evidence/live-github-recheck-g242.md',observed:'Local/GitHub identity and public root/version availability match the expected boundary; protected health denies anonymous access',scope:'Availability/auth boundary only; authenticated production semantics and deployed revision identity remain unverified'} },
  { capabilities: ['verification', 'security', 'governance'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-recheck-g241.md',observed:'Fresh assurance truth, contracts, integrations and table checks preserve local route/MCP parity while external gates remain fail-closed',scope:'Local assurance only; OpenMythos admissibility and live deployment identity remain blocked'} },
  { capabilities: ['verification', 'security', 'governance'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g240.md',observed:'Canonical governed loop suite passes 23 files, 291 tests and one explicit skip after the current mutation/workspace gates',scope:'Local loop/runtime regression only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['verification', 'security', 'governance'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/mutation-regression-g239.md',observed:'Configured Stryker mutation run kills all 71 mutants with zero survivors, uncovered mutants or errors',scope:'Configured approval/tool-broker/docker sandbox regions only; not repository-wide mutation certification'} },
  { capabilities: ['workspace', 'server', 'dashboard', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g239.md',observed:'Fresh root workspace regression passes 2,798 tests with 20 skips and zero failures after current route and mutation checks',scope:'Local package integration only; external providers, authenticated production UI and deployment remain unverified'} },
  { capabilities: ['assurance', 'contracts', 'integrations', 'tables', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-recheck-g230.md',observed:'Fresh route, contract, integration and table checks pass locally; assurance truth remains fail-closed on OpenMythos and live identity prerequisites',scope:'Local assurance/reachability only; external certification and production identity remain unverified'} },
  { capabilities: ['agents', 'governance', 'self-improve'], routes: ['/agents'], route_ids: ['agents:POST:/create-from-description'], evidence: {kind:'tested',evidence_file:'evidence/agent-nl-route-validation-g232.md',observed:'Authenticated NL agent creation rejects blank input, persists an inferred high-risk pending draft, and requires explicit approval before idle status',scope:'Local HTTP/SQLite proof only; no external runtime dispatch or production activation'} },
  { capabilities: ['agi', 'governance', 'reasoning'], routes: ['/agi-reasoning'], route_ids: ['agi:POST:/reason'], evidence: {kind:'tested',evidence_file:'evidence/agi-reasoning-route-validation-g233.md',observed:'Authenticated reasoning route executes Observe→Deduce→Plan, persists reasoning steps and exposes resulting statistics',scope:'Local HTTP/SQLite computation proof only; reasoning quality and external model execution remain unverified'} },
  { capabilities: ['agi', 'governance', 'reasoning'], routes: ['/agi-reasoning'], route_ids: ['agi:GET:/observe', 'agi:POST:/consensus/debates', 'agi:POST:/consensus/debates/:debateId/proposals', 'agi:POST:/consensus/debates/:debateId/vote', 'agi:POST:/consensus/debates/:debateId/resolve', 'agi:GET:/consensus/debates/:debateId', 'agi:GET:/consensus/stats'], evidence: {kind:'tested',evidence_file:'evidence/agi-consensus-route-validation-g237.md',observed:'Authenticated AGI observe and multi-agent consensus routes execute a persisted debate/proposal/vote/resolve lifecycle with malformed-input guards',scope:'Local HTTP/SQLite computation proof only; reasoning quality and external model execution remain unverified'} },
  { capabilities: ['segml', 'learning', 'self-improve', 'platform', 'governance'], routes: ['/goals-loops', '/governance'], route_ids: ['segml-literature:POST:/scan', 'segml-literature:GET:/proposed', 'segml-literature:POST:/approve/:id', 'segml-literature:GET:/status', 'segml-production:POST:/generate', 'segml-production:POST:/train', 'segml-production:POST:/evaluate', 'segml-production:POST:/cycle', 'segml-production:GET:/status', 'platform:GET:/status', 'platform:POST:/cycle'], evidence: {kind:'tested',evidence_file:'evidence/segml-platform-production-validation-g230.md',observed:'Remaining platform, SEGML literature and SEGML production route families execute or reject malformed input through authenticated HTTP/SQLite; contract inventory classifies 581 routes with 338 direct route-test references and zero unclassified entries',scope:'Local route and storage proof only; external Ollama/LiteLLM delivery, production semantics and promotion remain unverified'} },
  { capabilities: ['server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/full-server-regression-g230.md',observed:'Full server regression passes 2,504 tests with 20 skips and no failures; type-check, lint and build pass',scope:'Local server workspace only; external providers and production deployment remain unverified'} },
  { capabilities: ['dashboard', 'mcp', 'server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g230.md',observed:'Full workspace regression passes 2,795 tests with 20 skips and no failures',scope:'Local package integration only; external providers, authenticated production UI and deployment remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g230.md',observed:'Canonical governed-loop regression passes 23 files, 291 tests and one explicit skip after all remaining route proof',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['segml', 'learning', 'self-improve', 'traceability', 'governance'], routes: ['/goals-loops', '/compliance'], route_ids: ['segml-l4:POST:/tournament', 'segml-l4:POST:/evolve', 'segml-l4:POST:/ttsi', 'segml-l4:POST:/coevolution', 'segml-l4:GET:/status', 'traceability:GET:/matrix'], evidence: {kind:'tested',evidence_file:'evidence/segml-l4-traceability-validation-g229.md',observed:'SEGML Level-4 tournament, evolution, TT-SI, co-evolution and status plus traceability matrix execute through authenticated HTTP/SQLite; malformed categories, prompts and rounds fail before bridge work',scope:'Local authenticated route/SQLite proof only; external provider quality, production semantics and promotion remain unverified'} },
  { capabilities: ['dashboard', 'server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g229.md',observed:'Full workspace regression passes 2,793 tests with 20 skips and no failures after SEGML Level-4 and traceability route proof',scope:'Local package integration only; external providers, authenticated production UI and deployment remain unverified'} },
  { capabilities: ['server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/full-server-regression-g229.md',observed:'Full server regression passes 2,502 tests with 20 skips and no failures; type-check, lint and build pass',scope:'Local server workspace only; external providers and production deployment remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g229.md',observed:'Canonical governed-loop regression passes 23 files, 291 tests and one explicit skip after SEGML Level-4 and traceability route proof',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['console', 'observability', 'audit', 'self-improve'], routes: ['/console'], evidence: {kind:'tested',evidence_file:'evidence/console-route-validation-g228.md',observed:'All seven console projections return current JSON state over HTTP/SQLite',scope:'Local observability only; production freshness and tenant isolation remain unverified'} },
  { capabilities: ['fleet', 'swarm-orchestration', 'governance'], routes: ['/fleet'], evidence: {kind:'tested',evidence_file:'evidence/fleet-route-validation-g227.md',observed:'Fleet node, handoff, distribution and capability-sync routes reject malformed payloads and execute a local HTTP/SQLite chain',scope:'Local coordination only; cross-machine delivery and production liveness remain unverified'} },
  { capabilities: ['legal', 'governance', 'privacy'], routes: ['/compliance'], evidence: {kind:'tested',evidence_file:'evidence/legal-ruleops-validation-g226.md',observed:'Legal RuleOps routes reject malformed identifiers, domains, actions, indexes and operator fields before classification or governance-feedback writes; focused and full regressions pass',scope:'Local HTTP/SQLite validation only; legal-domain completeness and production deployment remain unverified'} },
  { capabilities: ['live-edge', 'auth'], routes: [], evidence: {kind:'live-public',evidence_file:'evidence/live-public-recheck-g225.md',observed:'Public root and version are available; protected health denies anonymous access with AUTH_REQUIRED',scope:'Read-only production edge only; authenticated semantics and deployed revision identity remain unverified'} },
  { capabilities: ['assurance', 'contracts', 'integrations', 'tables'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-recheck-g224.md',observed:'Fresh assurance reports 581 source routes, 303 contract-tested routes, 56/56 MCP tools, 167 discovered tables and 11 statically unreachable tables; aggregate truth remains fail-closed on external prerequisites',scope:'Local assurance and reachability only; authenticated production semantics and external certification remain unverified'} },
  { capabilities: ['messages', 'audit', 'traceability'], routes: ['/audit/logs'], evidence: {kind:'tested',evidence_file:'evidence/message-audit-pagination-validation-g157.md',observed:'Message and audit-log list windows reject zero, negative, fractional and non-numeric values before SQLite reads; focused suites pass 12/12',scope:'Local HTTP/SQLite validation only; no production deployment claim'} },
  { capabilities: ['swarm-intel', 'swarm-orchestration'], routes: [], route_ids: ['swarms:POST:/expert/dispatch'], evidence: {kind:'tested',evidence_file:'evidence/expert-dispatch-parallel-validation-g156.md',observed:'Expert swarm max_parallel boundary rejects zero, negative, fractional, non-numeric and above-ceiling values with structured 400 before external dispatch; service repeats the guard',scope:'Local HTTP/service validation only; external expert providers remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'swarm-governance'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g155.md',observed:'Fresh loop-focused Vitest self-check passes 23 files, 291 tests and one explicit skip; negative governance controls remain active',scope:'Local regression only; no external provider, promotion, merge or deployment'} },
  { capabilities: ['dashboard', 'tasks', 'runtime', 'auth'], routes: ['/','/tasks','/tasks/:taskId'], evidence: {kind:'browser-local',evidence_file:'evidence/browser-authenticated-crawl-g154.md',observed:'Authenticated Playwright traversed all 36 navigation routes; UI task create and Execute reached durable pending→running→completed with HTTP 201/200 and timeline evidence',scope:'Isolated local built server with temporary admin; authority ledger and UAMS/Qdrant intentionally unavailable, no production claim'} },
  { capabilities: ['astra', 'codex', 'tasks', 'runtime'], routes: ['/tasks', '/tasks/:taskId'], evidence: {kind:'live-local',evidence_file:'evidence/astra-live-runtime-probe-g153.md',observed:'Real codex exec reaches OpenAI gpt-6-astra with max reasoning in a read-only sandbox and returns ASTRA_RUNTIME_PROBE',scope:'Single local read-only provider call; no computer-use, browser automation, long-running recovery, quality or production promotion'} },
  { capabilities: ['openmythos', 'learning', 'self-improve'], routes: ['/governance', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/openmythos-r46-reproducibility-g152.md',observed:'R46 held-out selector cross-validation reruns from retained R45 data: learned 0.538 vs always-route 0.551, 0/2000 wins; refuted result preserved',scope:'Pure local re-analysis; no model generation, selector promotion or production mutation'} },
  { capabilities: ['loops', 'self-improve', 'goals', 'swarm-governance'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-regression-g151.md',observed:'Fresh loop-focused Vitest run passes 23 files with 291 tests and one explicit skip; expected validation, runtime, budget and security denials remain enforced',scope:'Local server workspace fixtures; no external provider quality, promotion, merge or deployment'} },
  { capabilities: ['openmythos', 'evidence', 'learning'], routes: ['/governance', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/openmythos-executed-evaluation-g150.md',observed:'Exact qwen2.5:14b-instruct-q4_K_M executed R28 repeatability (24/24, 8/8 stable, pass) and R29 full (60 cases per arm, complete, reject on three paired regressions); truth adapter records measured pass/fail gates',scope:'Local Ollama and benchmark reports; corpus maturity, promotion, deployment identity and policy-regression remediation remain blocked'} },
  { capabilities: ['dashboard', 'pipeline-builder'], routes: ['/pipeline-builder'], evidence: {kind:'live-differential',evidence_file:'evidence/live-pipeline-builder-drift-g149.md',observed:'Production Pipeline Builder chunk remains alert-only while the local built chunk contains validated localStorage draft persistence; dashboard shell hash changed but API version remains 0.5.8',scope:'Read-only public asset comparison; deployment and post-deploy proof remain unauthorized/unverified'} },
  { capabilities: ['explore-public'], routes: [], route_ids: ['explore-public:GET:/robots.txt', 'explore-public:GET:/sitemap.xml', 'explore-public:GET:/leaderboard'], evidence: {kind:'live-public',evidence_file:'evidence/live-explore-public-sweep-g148.md',observed:'Production robots, sitemap and leaderboard Explore index routes each return 200 with the expected content type and structural marker; sitemap has no repository URLs to probe',scope:'Read-only public index sweep; repository-specific publication and deployed revision identity remain unverified'} },
  { capabilities: ['explore-public', 'openmythos'], routes: [], route_ids: ['explore-public:GET:/leaderboard'], evidence: {kind:'live-public',evidence_file:'evidence/live-explore-leaderboard-g147.md',observed:'Production Explore leaderboard returns HTTP 200 JSON with seven redacted rows and the expected public schema; no prompt or case content is exposed',scope:'Read-only production endpoint; underlying evaluation truth and deployed revision identity remain unverified'} },
  { capabilities: ['explore-public', 'openmythos'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/explore-leaderboard-upstream-parity-g146.md',observed:'Canonical origin/main public leaderboard tests were applied verbatim and pass locally: feature gating, model-only sorting, content redaction, malformed metadata, corpus pinning and subset exclusion',scope:'Local public explore route and upstream test parity; production flag/deployment identity remain unverified'} },
  { capabilities: ['mcp'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/dependency-audit-g145.md',observed:'Production dependency audit is clean after the Hono 4.13.7 MCP transport lockfile update; root Vitest is explicitly dev-only; npm ci dry-run, build, type-check, lint and full workspace tests pass',scope:'Local package graph and reproducible install checks; the pinned dev-only Vitest advisory remains outside the production audit'} },
  { capabilities: ['dashboard', 'pipeline-builder'], routes: ['/pipeline-builder'], evidence: {kind:'live-differential',evidence_file:'evidence/live-differential-recheck-g144.md',observed:'Production Pipeline Builder still exposes an alert-only Save handler while local source persists and validates drafts; production/API availability and upstream identity were rechecked without mutation',scope:'Public asset inspection plus local source state; no deployment or production mutation authorized'} },
  { capabilities: ['health', 'auth'], routes: [], evidence: {kind:'live-local',evidence_file:'evidence/live-identity-auth-boundary-g143.md',observed:'Temporary built-server probe returned health/version 200 and correctly denied unauthenticated deep provenance with 401 AUTH_REQUIRED; server was stopped afterward',scope:'Local process and HTTP only; authenticated provenance, clean revision and database identity remain unverified'} },
  { capabilities: ['loops', 'self-improve', 'cognitive', 'learning'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-regression-g142.md',observed:'Fresh governed-loop regression covers 41 loop test files with 534 passing and 2 explicit skips, including authenticated /loops HTTP proof, assignment, recovery, runtime stop, security checker and completion invariants',scope:'Local Vitest/SQLite/disposable fixtures; no external provider quality, promotion, merge, deployment or background monitor'} },
  { capabilities: ['auth'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/oidc-signature-validation-g141.md',observed:'OIDC ID tokens require a matching JWKS key id and supported algorithm; jsonwebtoken verifies signature, issuer, audience and expiry, while tampered, wrong-issuer and unknown-key tokens are rejected',scope:'Local generated RSA/JWKS fixture; external IdP discovery, key rotation and production identity remain unverified'} },
  { capabilities: ['tasks', 'astra', 'codex'], routes: ['/tasks', '/tasks/:taskId'], evidence: {kind:'tested',evidence_file:'evidence/astra-runtime-dispatch-continuation.md',observed:'Execute route honors persisted executor when request omits override; persisted gpt-6-astra/max metadata reaches Codex argument construction',scope:'Local HTTP/SQLite/engine fixtures; live provider, computer use, model quality and universal ToolBroker mediation remain unproven'} },
  { capabilities: ['openmythos', 'evidence', 'goals', 'loops'], routes: ['/governance', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/openmythos-worldlab-attestation-continuation.md',observed:'Authenticated attestation import validates schema, canonical hash, completed eval-run/corpus/count binding and persists immutable provenance; WorldLab retest intake validates goal source binding, records evidence graph edges and remains promotion-safe with promoted=false',scope:'Local SQLite/HTTP fixtures with real route authentication; external producer identity, byte-level corpus resolution, held-out/repeatability truth and promotion remain unavailable'} },
  { capabilities: ['github-webhooks', 'work-items', 'tasks', 'loops'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/context-governance-continuation.md',observed:'Task executor input carries a hashed advisory episode snapshot; loop assignment and packet share one persisted snapshot; governance tuning reads canonical episodes; signed GitHub issue intake imports only a work item and preserves operator state on recurrence',scope:'Local SQLite/HTTP/service fixtures; no external delivery, provider execution or deployment identity'} },
  { capabilities: ['tool-broker'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/tool-broker-principal-required-g83.md',observed:'Durable capability-token validation requires and binds the presenting principal, tool and task; mismatched or omitted principal is rejected by the API boundary',scope:'Local SQLite broker invariant only; native provider CLI effect boundaries remain outside universal mediation'} },
  { capabilities: ['cognitive', 'learning', 'goals', 'loops', 'swarm-governance', 'swarm-intel', 'self-improve'], routes: ['/cognitive', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/evolution-continuation.md',observed:'Distinct current/restart projections; all-worker learning guards and completed improvement evaluating binding; actual outcome HTTP/poll/replay/candidate transaction; actual failed npm loop control refuses continuation/learning',scope:'Synthetic observations and explicit mock echo child; no paid provider, applied strategy or measured unseen-task improvement'} },
  { capabilities: ['cognitive', 'learning', 'loops', 'swarm-governance', 'swarm-intel'], routes: ['/cognitive', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/meta-tuning-chain-g80.md',observed:'20 distinct durable episodes produce confidence-gated loop-parameter tuning; active tuning survives a new service instance; exact token/goal overrides and invalid/duplicate evidence guards remain enforced; cognitive and continuous-learning regressions pass',scope:'Local SQLite/service fixtures with audit event; tuning changes loop parameters only and does not prove automatic strategy actions, causal improvement or promotion'} },
  { capabilities: ['segml-l5', 'self-improve', 'goals', 'loops'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/segml-level5-http-g89.md',observed:'Authenticated Level 5 self-improve, status and revert routes execute against SQLite; unproven proposals produce no applied steps or gain, generation persists across bridge instances, and revert updates the linked area/evolution row',scope:'Local HTTP/JWT/SQLite route proof; no real maker/checker implementation, provider quality or production deployment'} },
  { capabilities: ['loops', 'goals', 'swarm-governance'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-http-proof-g91.md',observed:'Authenticated loop start/list/review-bundle/step routes persist a read-only plan, state file and loop event against a disposable repository with zero worker leases',scope:'Local HTTP/JWT/SQLite/disposable repository; maker/checker execution, human approval, merge, deployment and unseen-task improvement remain unproven'} },
  { capabilities: ['loops', 'self-improve', 'tasks', 'swarm-governance'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-maker-checker-route-g92.md',observed:'Disposable HTTP route chain executes isolated maker/checker worktrees, deterministic checks, verification/certification and approval-required then approved completion with durable lease/task/evidence state',scope:'Fake Codex executable and local fixture only; live Astra quality, autonomous merge/deploy and unseen-task improvement remain unproven'} },
  { capabilities: ['loops', 'self-improve', 'astra', 'agent-catalog'], routes: ['/goals-loops', '/agents'], evidence: {kind:'tested',evidence_file:'evidence/controlled-product-improvement-g93.md',observed:'Real Codex maker, independent checker and separate security checker completed a disposable product-source regression repair with immutable source hashes, isolated worktrees, deterministic checks and three approval records; proposal remains REVIEW_REQUIRED and promoted=false',scope:'Supervised disposable product-source proposal; no merge, deployment, human sign-off or causal/unseen-task quality proof'} },
  { capabilities: ['loops', 'goals', 'swarm-governance', 'dashboard'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-recheck-g99.md',observed:'Fresh authenticated /loops route regression passes and contract/table inventories remain consistent; no unapproved worker lease or external mutation',scope:'Local route/evidence recheck only; provider quality, promotion, merge and deployment remain gated'} },
  { capabilities: ['cognitive', 'goals', 'loops'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/segml-l3-route-validation-g100.md',observed:'SEGML Level 3 scenario route rejects invalid counts with structured 400 responses and returns requested scenarios for valid integer counts',scope:'Local Express/SQLite route proof; generated tool execution, provider quality and deployment remain unverified'} },
  { capabilities: ['swarm-orchestration', 'loops', 'tasks'], routes: ['/goals-loops', '/tasks'], evidence: {kind:'tested',evidence_file:'evidence/workspace-recheck-g101.md',observed:'Full server suite passed on immediate rerun after an intermittent scheduler 401; isolated scheduler file also passed',scope:'Retains first full-run failure as UNKNOWN; no auth assertion weakening or causal test-isolation fix claimed'} },
  { capabilities: ['dashboard', 'tasks', 'loops', 'swarm-orchestration'], routes: ['/tasks', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/workspace-recheck-g102.md',observed:'Root workspace suite passes across all packages after SEGML route repair; assurance truth remains fail-closed on external prerequisites',scope:'Package regression proof only; not production UI, provider quality or deployment evidence'} },
  { capabilities: ['openmythos', 'goals', 'evidence'], routes: ['/governance'], evidence: {kind:'tested',evidence_file:'evidence/openmythos-limit-validation-g103.md',observed:'OpenMythos attestation/run/trend list limits reject invalid values with structured 400 responses and retain bounded positive integer windows',scope:'Local HTTP validation only; external corpus/evaluation and promotion remain blocked'} },
  { capabilities: ['openmythos', 'tasks', 'loops'], routes: ['/governance', '/tasks', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/server-recheck-g104.md',observed:'Complete server regression passes after OpenMythos route repair with 2432 tests passed and 20 skipped',scope:'Regression evidence only; known non-Git diagnostic and external assurance limits remain'} },
  { capabilities: ['research', 'evidence'], routes: ['/research'], evidence: {kind:'tested',evidence_file:'evidence/research-limit-validation-g105.md',observed:'Trusted-source threshold route rejects malformed min_trust values and accepts valid bounded thresholds',scope:'Local HTTP/SQLite route proof; external research providers remain unverified'} },
  { capabilities: ['research', 'tasks', 'loops'], routes: ['/research', '/tasks', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/server-recheck-g108.md',observed:'Complete server regression recheck passes with 2434 tests passed and 20 skipped after one isolated transient route-permissions failure',scope:'Regression evidence only; external providers and deployment remain unavailable'} },
  { capabilities: ['audit', 'governance', 'tasks', 'loops'], routes: ['/audit', '/tasks', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/audit-pagination-validation-g111.md',observed:'Audit pagination rejects malformed bounds before SQLite; complete server/workspace and governed loop checks pass',scope:'Local HTTP/SQLite and package regression evidence; external deployment remains unverified'} },
  { capabilities: ['governance-feedback', 'loops', 'evidence'], routes: ['/governance-feedback/history', '/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/governance-feedback-pagination-g112.md',observed:'Governance-feedback history limit validation rejects malformed values; subsequent server/workspace regressions pass',scope:'Local HTTP and package regression evidence; first-run swarm-intelligence mismatch retained as UNKNOWN'} },
  { capabilities: ['advanced', 'governance-feedback'], routes: ['/advanced'], evidence: {kind:'tested',evidence_file:'evidence/advanced-limit-validation-g107.md',observed:'Advanced feedback recent route rejects malformed limits before SQLite and accepts valid bounded limits',scope:'Local HTTP validation only; no external provider or deployment evidence'} },
  { capabilities: ['dashboard', 'pipeline-builder'], routes: ['/pipeline-builder'], evidence: {kind:'live-differential',evidence_file:'evidence/live-local-differential-g82.md',observed:'Production bundle Save handler only alerts; local source persists/validates/restores drafts and package-configured jsdom test passes 3/3',scope:'Public asset inspection plus local component regression; production deployment correction not performed'} },
  { capabilities: ['cognitive'], routes: ['/cognitive'], evidence: {kind:'browser-local',evidence_file:'evidence/browser-evolution-cognitive-restarted.log',observed:'Actual Chromium after process restart renders the same50%/N10 fixture row and advisory-only explanation',scope:'Manual synthetic observations, not native task success or complete cognitive capability'} },
  { capabilities: ['approvals', 'tasks'], routes: ['/approvals', '/tasks/:taskId'], evidence: {kind:'tested',evidence_file:'evidence/approval-atomicity.md',observed:'Approval transition and canonical audit rollback/commit across actual SQLite faults and two connections; notification failure after commit preserves durable success',scope:'Local atomicity; no provider or authority expansion'} },
  { capabilities: ['approvals', 'tasks'], routes: ['/approvals', '/tasks/:taskId'], evidence: {kind:'tested',evidence_file:'evidence/queue-admission-revalidation.md',observed:'Current task-input hash, expiry, latest grant, state/hold and policy/governance after capacity wait; exact semaphore/SQLite denial regressions',scope:'Separate engine tests, not retroactive proof from earlier mock fixture; no continuous post-start enforcement or referenced-file content binding'} },
  { capabilities: ['agents', 'retirement', 'tasks'], routes: ['/agents', '/agents/:agentId'], evidence: {kind:'tested',evidence_file:'evidence/agent-lifecycle-continuation.md',observed:'In-place identity preserves FK children; observational heartbeat cannot activate inactive agents; exact-owned quiescent retirement archive/audit and retained-lineage deletion guards',scope:'Actual local HTTP/SQLite/engine fixtures; not external process drain, knowledge promotion or automatic reassignment'} },
  { capabilities: ['evidence', 'exports', 'agents'], routes: ['/tasks/:taskId/review', '/agents', '/agents/:agentId'], evidence: {kind:'tested',evidence_file:'evidence/evidence-summary-continuation.md',observed:'Actual HTTP/SQLite/export summary refresh retains materialization identity; explicit missing start/policy, configuration versus event attribution, zero values, pending/unknown and factory-created agent render regression',scope:'Synthetic state/events and component fixtures, no new provider execution'} },
  { capabilities: ['evidence', 'exports'], routes: ['/tasks/:taskId/review'], evidence: {kind:'tested',evidence_file:'evidence/evidence-summary-review.md',observed:'Current recorded execution approval separate from manual/history; post-queue actual decision retained; canonical audit stages preferred without duplicate/backdated synthetic decisions;12summary/87adjacent tests',scope:'Summary is not input-hash authorization; historical fallback explicitly synthetic and uses actual recorded timestamps only'} },
  { capabilities: ['openmythos'], routes: ['/governance'], evidence: {kind:'tested',evidence_file:'evidence/openmythos-cache-integrity.md',observed:'Failed corpus/oracle loads remain fail-closed; cached-byte hashes retain exact run/discrimination provenance; consumer cannot mutate validated case cache',scope:'Disposable local fixtures; failed worker fixture remains failed; no real judge, corpus mutation or missing certification evidence manufactured'} },
  { capabilities: ['agents', 'approvals', 'tasks', 'evidence', 'exports'], routes: ['/agents', '/agents/:agentId', '/tasks/:taskId/review'], evidence: {kind:'browser-local',evidence_file:'evidence/lifecycle-browser-proof.json',observed:'Actual local pending/retired agent and held/completed mock review; changed input needs new approval, same requester rejected; distinct fixture approver then completion; summary/archive identity and canonical audit persist after restart',scope:'Explicit mock tool/token messages, zero real file changes; final queue patch separately tested; failed extraction harness preserved in lifecycle-closure.md; local knowledge concept side effect and refused UAMS attempt are not successful integration/provider proof'} },
  { capabilities: ['explainer'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/explainer-pagination-validation-g130.md',observed:'Five explainer list/search endpoints reject malformed limits before service/database reads and preserve structured async validation errors',scope:'Local HTTP/SQLite fixture; external knowledge provider and production deployment remain unverified'} },
  { capabilities: ['observability'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/observability-window-validation-g131.md',observed:'Risk-trends and execution-activity reject malformed/out-of-range time windows before database reads',scope:'Local HTTP/SQLite fixture; external telemetry remains unverified'} },
  { capabilities: ['swarm-intel'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/swarm-confidence-validation-g133.md',observed:'Knowledge query rejects non-finite and out-of-range confidence thresholds before claim reads',scope:'Local HTTP/SQLite fixture; external knowledge providers remain unverified'} },
  { capabilities: ['catalog'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/catalog-search-validation-g134.md',observed:'Authenticated catalog search rejects malformed topK bounds before catalog reads',scope:'Local HTTP/auth/file-SQLite fixture; runtime activation remains artifact-only'} },
  { capabilities: ['health'], routes: [], evidence: {kind:'live-local',evidence_file:'evidence/live-authenticated-health-g136.md',observed:'Actual local server startup, public health/version 200 and authenticated deep-health 503 with explicit missing OKF validator reason',scope:'Temporary local bootstrap identity removed; no production identity or external knowledge validator'} },
  { capabilities: ['explore-public'], routes: [], evidence: {kind:'live-public',evidence_file:'evidence/live-reference-ui-recheck-g135.md',observed:'Reference UI fetch returned HTTP 200 and expected control-plane title',scope:'Availability/title only; no authenticated production feature semantics'} },
  { capabilities: ['swarm-orchestration', 'loops'], routes: ['/swarm-mission-control/proof-runs/:proofRunId'], evidence: {kind:'tested',evidence_file:'evidence/proof-run-detail-ui-g139.md',observed:'Proof-run detail loads persisted state, rolls back through the API and renders lookup failures as an accessible alert',scope:'Dashboard component/API fixture; no external worker execution or production browser session'} },
  { capabilities: ['swarm-orchestration', 'loops', 'dashboard'], routes: ['/swarm-mission-control', '/swarm-mission-control/proof-runs/:proofRunId'], evidence: {kind:'browser-local',evidence_file:'evidence/browser-proof-run-detail-g162.md',observed:'Authenticated browser creates a mock proof run, follows persisted detail, executes governed rollback and observes explicit post-rollback cleanup 404 after reload',scope:'Fresh temporary local server/database and mock runtime; production runtime, external evaluation and deployment remain unverified'} },
  { capabilities: ['self-modification', 'sbom'], routes: [], route_ids: ['self-modification:GET:/status', 'self-modification:POST:/analyze', 'self-modification:POST:/plan', 'self-modification:POST:/execute', 'sbom:GET:/generate', 'sbom:GET:/summary'], evidence: {kind:'tested',evidence_file:'evidence/self-modification-sbom-g191.md',observed:'Workspace-root resolution, self-modification status/analyze/plan/disabled-execute and CycloneDX SBOM generate/summary execute over Express/SQLite; 17 focused tests pass',scope:'Local HTTP/service fixture; execute remains intentionally 451 and no production deployment claim'} },
  { capabilities: ['repository-index'], routes: [], route_ids: ['repository-index:GET:/repositories', 'repository-index:POST:/register', 'repository-index:POST:/:id/index', 'repository-index:GET:/:id/stats', 'repository-index:POST:/search', 'repository-index:DELETE:/:id'], evidence: {kind:'tested',evidence_file:'evidence/full-server-regression-g194.md',observed:'Disposable repository register/index/stats/search/delete chain executes over HTTP/SQLite with typed missing-resource responses; server regression passes 2484/20',scope:'Local disposable repository only; no external repository mutation or production proof'} },
  { capabilities: ['sbom'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/sbom-root-resolution-g196.md',observed:'Red test reproduced zero SBOM components from workspace cwd; shared repository-root resolution repaired the lockfile/workspace lookup and the focused route suite passes',scope:'Local workspace launch context; production package inventory remains environment-dependent'} },
  { capabilities: ['goals', 'loops', 'self-improve'], routes: ['/goals-loops'], route_ids: ['goals:POST:/batch/preview', 'goals:POST:/batch/apply'], evidence: {kind:'tested',evidence_file:'evidence/full-server-regression-g202.md',observed:'Goal-batch preview/apply resolves repository-relative paths from a server launched in packages/server and imports the flywheel batch without worker side effects; full server regression passes 2486/20',scope:'Local HTTP/SQLite fixture; imported goals remain planning records and no worker or external provider is started'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g202.md',observed:'Governed loop-focused regression passes 23 files, 291 tests and one explicit skip after goal-batch root resolution; negative controls remain active',scope:'Local loop/governance regression only; no external provider, merge or deployment'} },
  { capabilities: ['opencode', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/full-server-regression-g203.md',observed:'OpenCode health discovers the repository opencode.jsonc from a packages/server launch while explicit OPENCODE_CONFIG_CONTENT remains highest precedence; server regression passes 2487/20',scope:'Local configuration inspection only; no OpenCode provider execution or production claim'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g203.md',observed:'Governed loop-focused regression passes 23 files, 291 tests and one explicit skip after OpenCode launch-context repair; negative controls remain active',scope:'Local loop/governance regression only; no external provider, merge or deployment'} },
  { capabilities: ['federation', 'loops', 'goals'], routes: [], route_ids: ['federation:POST:/inbox/work'], evidence: {kind:'tested',evidence_file:'evidence/full-server-regression-g204.md',observed:'Federation inbox work creates a persisted loop run using the monorepo root from a packages/server launch; HTTP/SQLite regression and full server suite pass 2488/20',scope:'Local federation fixture; no peer delivery, external provider execution or production claim'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g204.md',observed:'Governed loop-focused regression passes 23 files, 291 tests and one explicit skip after federation root resolution; negative controls remain active',scope:'Local loop/governance regression only; no external provider, merge or deployment'} },
  { capabilities: ['segml', 'learning', 'self-improve'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/full-server-regression-g207.md',observed:'SEGML Level-3 and production training bridges export JSONL under the canonical monorepo .data/segml-training path from a packages/server launch; server regression passes 2488/20',scope:'Local training-data path proof only; no model training, evaluation promotion or deployment'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g207.md',observed:'Governed loop-focused regression passes 23 files, 291 tests and one explicit skip after SEGML training-path repair; negative controls remain active',scope:'Local loop/governance regression only; no external provider, merge or deployment'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g208.md',observed:'Governed loop-focused regression recheck passes 23 files, 291 tests and one explicit skip; negative controls remain active',scope:'Local loop/governance regression only; no external provider, merge or deployment'} },
  { capabilities: ['assurance', 'openmythos', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-truth-g208.md',observed:'Assurance truth recheck passes local dependency, contract and integration gates while retaining BLOCKED OpenMythos and failed live-identity prerequisites',scope:'Fail-closed local assurance evidence; no production identity or external certification'} },
  { capabilities: ['agent-catalog', 'runtime'], routes: ['/agents'], evidence: {kind:'tested',evidence_file:'evidence/catalog-compilation-g209.md',observed:'All six declared catalog compilation targets produce substantive deterministic instruction artifacts; activation remains limited to OpenClaw/Codex and runtime registration is false',scope:'Local authenticated HTTP/catalog proof; no Claude/Cursor/Gemini provider execution'} },
  { capabilities: ['agent-catalog', 'runtime'], routes: ['/agents'], evidence: {kind:'tested',evidence_file:'evidence/catalog-root-resolution-g211.md',observed:'Agent catalog persistence resolves its default SQLite database from the monorepo root when the server starts in packages/server, while AGENT_CATALOG_DB remains an explicit override',scope:'Local service/path regression; catalog activation remains artifact-only and no external runtime is started'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g209.md',observed:'Governed loop-focused regression recheck passes 23 files, 291 tests and one explicit skip after catalog compiler repair',scope:'Local loop/governance regression only; no external provider, merge or deployment'} },
  { capabilities: ['auth', 'oidc'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/oidc-tamper-test-g210.md',observed:'OIDC signature tamper regression always changes the signature and rejects it; isolated OIDC suite and full server regression pass',scope:'Local verification fixture only; external identity-provider behavior remains unverified'} },
  { capabilities: ['health', 'explore-public', 'assurance'], routes: [], evidence: {kind:'live-public',evidence_file:'evidence/live-github-sweep-g212.md',observed:'Production root and API version are reachable, protected health returns AUTH_REQUIRED, and remote main identity is recorded read-only',scope:'Public/GitHub evidence only; authenticated production semantics and deployed parity remain unverified'} },
  { capabilities: ['assurance', 'openmythos', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-truth-g212.md',observed:'Assurance truth recheck retains fail-closed OpenMythos and live-identity prerequisites after local repairs',scope:'Local assurance gate evidence; no external certification'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g213.md',observed:'Fresh governed-loop regression passes 23 files, 291 tests and one explicit skip after the latest catalog/live/assurance checkpoint; negative controls remain active',scope:'Local loop/governance regression only; no external provider, merge or deployment'} },
  { capabilities: ['mcp', 'governance', 'orchestration', 'dashboard'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/mcp-route-proof-g214.md',observed:'Fresh route inventory matches 614 runtime registrations to 581 source declarations with 608 protected 401 probes; all 56 MCP tools execute or return explicit controlled-unavailability responses',scope:'Local Express/SQLite/MCP fixtures and authenticated API forwarding; no external provider delivery or production deployment'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g215.md',observed:'Fresh governed-loop regression passes 23 files, 291 tests and one explicit skip after MCP route-proof changes; negative controls remain active',scope:'Local loop/governance regression only; no external provider, merge or deployment'} },
  { capabilities: ['dashboard', 'mcp', 'server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g216.md',observed:'Full workspace regression passes 2,782 tests with 20 skips and no failures after route/MCP proof coverage',scope:'Local package integration only; external provider, authenticated production UI and deployment remain unverified'} },
  { capabilities: ['assurance', 'contracts', 'database', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-recheck-g217.md',observed:'Assurance truth remains fail-closed with local gates passing; contract inventory reports 581 source routes and 56/56 MCP tools; table reachability reports 167 discovered tables',scope:'Static/reachability and local assurance evidence; OpenMythos certification and live deployment identity remain external blockers'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g217.md',observed:'Broader post-recheck governed suite passes 24 files and 234 tests with one skipped file and one skipped test; prior canonical 23-file/291-test proof remains retained',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['segml', 'learning', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/segml-tool-synthesis-g218.md',observed:'Generated SEGML governance checks now contain explicit bounded keyword-scoring logic and no false TODO placeholder; focused suite passes 10/10 and full server regression remains green',scope:'Deterministic generated artifact only; no external model evaluation or promotion is inferred'} },
  { capabilities: ['dashboard', 'mcp', 'server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g218.md',observed:'Integrated workspace regression remains 2,782 passed, 20 skipped and 0 failures after SEGML tool-synthesis repair',scope:'Local package integration only; external provider, authenticated production UI and deployment remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g218.md',observed:'Broader governed loop/runtime suite remains 24 files and 234 tests passed with two skips and no failures after SEGML tool-synthesis repair',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['health', 'explore-public', 'assurance'], routes: [], evidence: {kind:'live-public',evidence_file:'evidence/live-public-recheck-g219.md',observed:'Production root and API version are reachable while protected health returns AUTH_REQUIRED',scope:'Read-only public edge check; authenticated production semantics, deployed identity and external assurance remain unverified'} },
  { capabilities: ['segml', 'learning', 'self-improve', 'openmythos'], routes: ['/goals-loops', '/governance'], evidence: {kind:'tested',evidence_file:'evidence/segml-finetuning-false-green-g220.md',observed:'Random fine-tuning A/B scores and deployment recommendations are removed; unavailable provider-backed evaluation now returns typed 503 without persisting evidence',scope:'Local service/authenticated HTTP boundary; no external evaluator or model-quality claim'} },
  { capabilities: ['dashboard', 'mcp', 'server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g220.md',observed:'Integrated workspace regression passes 2,783 tests with 20 skips and no failures after fine-tuning false-green repair',scope:'Local package integration only; external provider, authenticated production UI and deployment remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g220.md',observed:'Broader governed loop/runtime suite passes 24 files and 234 tests with two skips and no failures after fine-tuning false-green repair',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['assurance', 'contracts', 'database', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-recheck-g221.md',observed:'Fresh contracts, route-contracts, integration probes and table reachability pass: 581 source routes/300 contract-tested, 56/56 MCP tools, zero critical unclassified and 167 discovered tables with 11 statically unreachable',scope:'Local contract/reachability evidence only; no authenticated production semantics or external-provider certification'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g221.md',observed:'Fresh canonical governed-loop Vitest run passes 23 files and 291 tests with one explicit skip and no failures after G220',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['auth', 'segml', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/segml-l4-auth-boundary-g222.md',observed:'SEGML Level-4 route factory now requires real AuthMiddleware; route-inventory proof passes 7/7 and full server/workspace regressions pass 2494/20 and 2785/20',scope:'Local anonymous auth boundary only; authenticated production behavior remains unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g222.md',observed:'Canonical governed-loop Vitest run passes 23 files and 291 tests with one explicit skip and no failures after the SEGML Level-4 auth-boundary repair',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['assurance', 'contracts', 'integrations', 'tables'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-recheck-g224.md',observed:'Fresh assurance reports 581 source routes, 303 contract-tested routes, 56/56 MCP tools, 167 discovered tables and 11 statically unreachable tables; aggregate truth remains fail-closed on external prerequisites',scope:'Local assurance and reachability only; authenticated production semantics and external certification remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g224.md',observed:'Fresh canonical loop self-check passes 23 files, 291 tests and one explicit skip',scope:'Local regression only; no external provider, promotion, merge or deployment'} },
  { capabilities: ['multi-model', 'runtime', 'governance'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/multi-model-validation-g223.md',observed:'Model registration, routing and outcome boundaries reject malformed payloads before persistence; focused validation and full server/workspace regressions pass',scope:'Local HTTP/SQLite validation only; provider quality and production routing remain unverified'} },
  { capabilities: ['dashboard', 'server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g223.md',observed:'Integrated workspace regression passes 2,786 tests with 20 skips and no failures after multi-model validation',scope:'Local package integration only; external provider, authenticated production UI and deployment remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g223.md',observed:'Canonical governed-loop Vitest run passes 23 files and 291 tests with one explicit skip and no failures after multi-model validation',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['assurance', 'contracts', 'integrations', 'tables', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/assurance-recheck-g234.md',observed:'Assurance truth remains fail-closed only on OpenMythos/live identity; contracts, integrations, route contracts and table reachability checks pass locally',scope:'Local assurance/reachability only; external certification and production identity remain unverified'} },
  { capabilities: ['contracts', 'server', 'governance', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/route-inventory-recheck-g234.md',observed:'Fresh instantiated route inventory matches 581 source declarations with 614 registrations; all 608 auth-marked routes reject anonymous HTTP with 401',scope:'Local registration and anonymous auth boundary only; authorized domain semantics and production remain unverified'} },
  { capabilities: ['dashboard', 'mcp', 'server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g234.md',observed:'Root workspace test command traversed all seven workspaces with green package results after G233; prior complete exit-0 baseline remains 2,797 passed and 20 skipped',scope:'Local package integration only; no external provider, authenticated production UI or deployment proof'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g234.md',observed:'Canonical governed-loop Vitest self-check passes 23 files, 291 tests and one explicit skip after the latest workspace and route rechecks',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['tasks', 'agents', 'runtime', 'websocket', 'governance'], routes: ['/tasks', '/observability'], route_ids: ['tasks:POST:/', 'tasks:POST:/:id/execute', 'tasks:GET:/:id/events'], evidence: {kind:'tested',evidence_file:'evidence/e2e-task-chain-g235.md',observed:'Real src/index.ts subprocess proof completes login, WebSocket handshake, task creation, mock dispatch/approval, completion and persisted execution-event retrieval over HTTP',scope:'Disposable local SQLite and mock executor; external provider execution, production identity and deployment remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g236.md',observed:'Canonical governed-loop Vitest self-check passes 23 files, 291 tests and one explicit skip after the real-server task-chain proof',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
  { capabilities: ['server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/full-server-regression-g237.md',observed:'Full server regression passes 2,507 tests with 20 skips and no assertion failures after AGI consensus route coverage',scope:'Local server workspace only; external providers and production deployment remain unverified'} },
  { capabilities: ['dashboard', 'mcp', 'server', 'runtime'], routes: [], evidence: {kind:'tested',evidence_file:'evidence/workspace-regression-g237.md',observed:'Full workspace regression totals 2,798 passed, 20 skipped and 0 failed after AGI consensus route coverage',scope:'Local package integration only; external providers, authenticated production UI and deployment remain unverified'} },
  { capabilities: ['loops', 'goals', 'self-improve', 'runtime'], routes: ['/goals-loops'], evidence: {kind:'tested',evidence_file:'evidence/loops-self-check-g238.md',observed:'Canonical governed-loop Vitest self-check passes 23 files, 291 tests and one explicit skip after AGI consensus route coverage',scope:'Local loop/runtime governance only; no provider quality, promotion, merge or deployment'} },
];
for (const item of continuationEvidence) {
  assert(existsSync(resolve(out, item.evidence.evidence_file)), `Missing continuation evidence ${item.evidence.evidence_file}`);
  for (const module of modules.filter(module => item.capabilities.includes(module.capability))) module.actual_execution_evidence.push(item.evidence);
  for (const page of pages.filter(page => item.routes.includes(page.route))) page.actual_execution_evidence.push(item.evidence);
  for (const route of inventory.routes.items.filter(route => item.route_ids?.includes(route.id))) {
    route.evidence.push(item.evidence);
    route.evidence_kind = item.evidence.kind;
    route.status = 'exercised';
  }
}
modules.find(module => module.capability === 'self-modification').runtime_effect = 'Workspace-root-resolved analyze/plan persistence with explicit 451 execute gate; no direct source mutation or merge';
modules.find(module => module.capability === 'sbom').runtime_effect = 'CycloneDX 1.6 generation and derived dependency summary over HTTP; production completeness depends on runtime lockfile context';
modules.find(module => module.capability === 'repository-index').runtime_effect = 'Disposable repository register/index/stats/search/delete chain with typed missing-resource handling; no external repository mutation';
modules.find(module=>module.capability==='agents').runtime_effect='Identity-preserving registration, observational heartbeat and quiescent retirement with retained archive/audit; no external drain or implicit activation';
modules.find(module=>module.capability==='evidence').runtime_effect='Current canonical task/event/evidence summary and approval chronology; explicit unknowns, recorded approval scope and executor attribution; not dispatch authorization';
modules.find(module=>module.capability==='exports').runtime_effect='Existing task export includes recalculated current summary; seeded SQLite transition proof, no new worker execution';
for (const module of modules) {
  const relatedPages = pages.filter(page => module.ui_screens.includes(page.route));
  module.browser_evidence = relatedPages.flatMap(page => page.actual_execution_evidence.filter(evidence => evidence.kind === 'browser-local'));
  if (!['INTENTIONAL', 'DISCONNECTED'].includes(module.state) && relatedPages.some(page => page.state === 'BROKEN')) module.state = 'BROKEN';
}
assert(pages.find(page => page.route === '/approvals').handlers.includes('approveRequestExplicit'), 'Nested approval controls must map to their API handlers');
assert(pages.find(page => page.route === '/economy').requests.some(client => client.requests.includes('/swarms/economy')), 'Generic API calls must be included');
save('capability-graph.json', graph);
const brief = values => [...new Set(values)].slice(0, 3).join(', ') || 'Not mapped';
const link = path => `[${path.split('/').at(-1)}](${path})`;
const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const rows = modules.map(m => {
  const evidence = m.actual_execution_evidence.filter(e => e.evidence_file);
  const latestBrowser = [...new Set(pages.filter(page => m.ui_screens.includes(page.route)).map(page => page.latest_browser_evidence).filter(Boolean))];
  const proof = [...latestBrowser.map(path => `Browser: ${link(path)}`), ...evidence.filter(e => e.kind !== 'tested').map(e => `${e.kind}: ${link(e.evidence_file)}`)];
  const fixtureTests = evidence.filter(e => e.kind === 'tested');
  return [m.capability, brief(m.ui_screens), brief(m.frontend_handlers.map(handler => handler.handler)), `${brief(m.api_mounts)}; ${m.routes.length} source routes`,
    brief(m.services.map(path => path.split('/').at(-1))), `${brief(m.storage)}; ${m.storage.length} source-referenced`, m.runtime_effect || 'Operational effect unproven',
    fixtureTests.length ? brief(fixtureTests.map(e => e.evidence_file).map(link)) : `${m.tests.length} source test references; execution not inferred`,
    proof.length ? [...new Set(proof)].join(', ') : 'No live execution artifact attached', m.state].map(cell).join(' | ');
});
const dashboardRows = pages.map(page => `| ${[page.route, page.state, page.state_reason || 'No browser observation attached', page.latest_browser_evidence ? link(page.latest_browser_evidence) : 'Not captured'].map(cell).join(' | ')} |`);
writeFileSync(resolve(out, 'CAPABILITY_MATRIX.md'), `# Capability matrix\n\n${trancheCheckpoint}\n\nSource reachability, browser snapshots and scoped runtime proofs are distinct. Rendered controls are not assumed exercised. No full product capability is VERIFIED merely because a page renders or tests exist. Historical observations, including failures, remain in the graph; latest captured browser state governs the rows below.\n\n| Capability | UI | Frontend | API | Service | DB | Runtime | Test | Live proof | State |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.map(row => `| ${row} |`).join('\n')}\n\n## Dashboard observations\n\n| Route | Latest state | Evidence interpretation | Latest browser proof |\n|---|---|---|---|\n${dashboardRows.join('\n')}\n\nThe supervised real Codex/Astra maker/checker proof is attached to tasks and loops; it does not certify autonomous planning, approval, merging or production promotion.\n\nMachine-readable detail: [capability-graph.json](capability-graph.json). Regenerate with \`node reports/autonomous-audit-20260909/reconstruct-capabilities.mjs\`. New \`evidence/browser*.log\` CLI result artifacts are picked up automatically.\n`);
console.log(JSON.stringify({ capability_groups: modules.length, dashboard_routes: pages.length, routes: inventory.routes.total, mcp_tools: inventory.mcp_tools.total, tables: tables.length, table_states: Object.fromEntries(['ACTIVE', 'READ-ONLY', 'WRITE-ONLY', 'UNREACHABLE'].map(state => [state, tables.filter(t => t.state === state).length])) }));
const matrix = readFileSync(resolve(out, 'CAPABILITY_MATRIX.md'), 'utf8');
writeFileSync(resolve(out, 'CAPABILITY_MATRIX.md'), matrix.replace(trancheCheckpoint, latestCheckpointWithG243));
