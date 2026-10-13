import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService } from './self-improvement-service';
import { markRun } from './scheduler-registry';

/**
 * Dead-code lane (operator 2026-10-07): Djimitflo proposes removing its own unused code. Prod: 649 route handlers, ~121
 * endpoints ever hit since usage telemetry started (2026-09-28). Two candidate kinds, both conservative:
 *   (a) a server source file no production file imports and no code/config file names by string;
 *   (b) a route module whose mounts are all authenticated, got 0 hits in `usage_counts` (>= 14 days of telemetry) and
 *       whose path no other package (dashboard, mcp-server, ...) or script mentions — plus the services only it uses.
 * The oracle is `npm run test:dead-code:grounded` (scripts/dead-code-gate.mjs): only the named files/registrations change,
 * adds <= 10 % of removed lines, then the full test suite of every touched package. Proposals are normal risk: never
 * auto-approved, the maker approval and the merge stay human. DEAD_CODE_LANE_ENABLED=true (default off),
 * DEAD_CODE_MAX_PER_DAY (default 2, also the in-flight cap).
 */
export const deadCodeLaneEnabled = (): boolean => process.env.DEAD_CODE_LANE_ENABLED === 'true';

const SRC = 'packages/server/src';
const ROUTES_INDEX = `${SRC}/routes/index.ts`;
/** The maker diff cap is 2 000 lines (loop-worker-executor); diff headers need some room. */
export const MAX_UNIT_LINES = 1_500;
export const MIN_TELEMETRY_DAYS = 14;
/** Shared infrastructure (and the auth/audit services every route test needs for a token) a test may import next to
 *  the dead code and still count as "only for the removed code". */
const INFRA = /^packages\/server\/src\/(database|middleware|utils|config)\/|^packages\/server\/src\/services\/(auth|audit)-service\.ts$/;
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|sh|py|toml)$|(^|\/)Dockerfile[^/]*$/;
/** Not code: generated reports, specs and docs mention file names without loading them. `knowledge` is an external symlink. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.djimitflo', 'docs', 'reports', 'openspec', 'knowledge']);
const isTest = (rel: string) => /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
/** Entry points and loaders: run by name (package.json, Dockerfile, tsx) or read from disk, never imported. */
const isEntry = (rel: string) => /\/(index|main|server)\.ts$/.test(rel) || /\/(scripts|bin|migrations)\//.test(rel) || rel.endsWith('.d.ts');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface DeadCodeUnit {
  id: string; kind: 'file' | 'route-group';
  /** Files the maker must delete. */
  remove: string[];
  /** Files the maker may edit (route registration) or delete (tests only for the removed code). */
  allow: string[];
  lines: number;
  evidence: string[];
}

interface Repo {
  files: Map<string, string>;
  imports: Map<string, Set<string>>;
  importers: Map<string, Set<string>>;
  lines: (rel: string) => number;
}

function loadRepo(repoPath: string): Repo {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(repoPath, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel); continue; }
      if (!e.isFile() || !CODE_FILE.test(e.name) || e.name === 'package-lock.json') continue;
      const full = path.join(repoPath, rel);
      if (fs.statSync(full).size <= 2_000_000) files.set(rel, fs.readFileSync(full, 'utf8'));
    }
  };
  walk('');
  const imports = new Map<string, Set<string>>(); const importers = new Map<string, Set<string>>();
  const resolve = (from: string, spec: string): string | undefined => {
    const base = path.posix.join(path.posix.dirname(from), spec);
    return [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => files.has(c));
  };
  for (const [rel, text] of files) {
    if (!rel.startsWith(`${SRC}/`) || !/\.tsx?$/.test(rel)) continue;
    // static, side-effect, re-export, dynamic import() and require() — every form counts as an importer
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(rel, m[1]);
      if (!target || target === rel) continue;
      if (!imports.has(rel)) imports.set(rel, new Set());
      imports.get(rel)!.add(target);
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target)!.add(rel);
    }
  }
  return { files, imports, importers, lines: (rel) => (files.get(rel) ?? '').split('\n').length };
}

const productionImporters = (repo: Repo, rel: string) => [...(repo.importers.get(rel) ?? [])].filter((f) => !isTest(f));

/** Code/config files outside `allowed` that name `rel` in a string ('x', "./x.js", `dir/x`) — dynamic loaders, scripts, configs. */
function stringReferences(repo: Repo, rel: string, allowed: Set<string>): string[] {
  const name = path.posix.basename(rel).replace(/\.[cm]?[jt]sx?$/, '');
  const re = new RegExp(`['"\`/]${esc(name)}(?:\\.[cm]?[jt]sx?)?['"\`\\s)]`);
  return [...repo.files].filter(([f, text]) => f !== rel && !allowed.has(f) && re.test(text)).map(([f]) => f);
}

/**
 * Seeds plus every file only the unit uses (fixpoint), the tests that exist only for it, and the reason it is not
 * proposable (string-referenced, a test that also covers live code, too large), if any.
 */
function buildUnit(repo: Repo, seeds: string[], edit: string[]): { remove: string[]; tests: string[]; blocked?: string } {
  const unit = new Set(seeds);
  const testsOf = (files: Set<string>) => [...new Set([...files].flatMap((f) => [...(repo.importers.get(f) ?? [])].filter(isTest)))];
  for (let grew = true; grew;) {
    grew = false;
    for (const f of [...unit]) for (const t of repo.imports.get(f) ?? []) {
      if (unit.has(t) || isTest(t) || isEntry(t) || INFRA.test(t)) continue;
      if (!productionImporters(repo, t).every((i) => unit.has(i))) continue;
      const allowed = new Set([...unit, ...edit, ...testsOf(new Set([t]))]);
      if (stringReferences(repo, t, allowed).length) continue;
      unit.add(t); grew = true;
    }
  }
  const tests = testsOf(unit);
  for (const t of tests) {
    const other = [...(repo.imports.get(t) ?? [])].filter((i) => !unit.has(i) && !isTest(i) && !INFRA.test(i));
    if (other.length) return { remove: [...unit], tests, blocked: `${t} also tests live code (${other.slice(0, 3).join(', ')})` };
  }
  const allowed = new Set([...unit, ...edit, ...tests]);
  for (const s of seeds) {
    const refs = stringReferences(repo, s, allowed);
    if (refs.length) return { remove: [...unit], tests, blocked: `named by string in ${refs.slice(0, 3).join(', ')}` };
  }
  const lines = [...unit, ...tests].reduce((n, f) => n + repo.lines(f), 0);
  if (lines > MAX_UNIT_LINES) return { remove: [...unit], tests, blocked: `${lines} lines > ${MAX_UNIT_LINES}` };
  return { remove: [...unit].sort(), tests: tests.sort() };
}

function unitFrom(repo: Repo, id: string, kind: DeadCodeUnit['kind'], built: { remove: string[]; tests: string[] }, edit: string[], evidence: string[]): DeadCodeUnit {
  const lines = [...built.remove, ...built.tests].reduce((n, f) => n + repo.lines(f), 0);
  const importGraph = built.remove.map((f) => `${f}: ${productionImporters(repo, f).filter((i) => !built.remove.includes(i)).join(', ') || 'no'} production importer(s)`).join('; ');
  return {
    id, kind, remove: built.remove, allow: [...edit, ...built.tests], lines,
    evidence: [`dead-code-evidence:import graph — ${importGraph}`, ...(built.tests.length ? [`dead-code-evidence:tests only for this code — ${built.tests.join(', ')}`] : []), ...evidence],
  };
}

/** (a) server source files no production file imports and nothing names by string. */
export function discoverUnimportedFiles(repoPath: string, repo = loadRepo(repoPath)): { units: DeadCodeUnit[]; skipped: Array<{ id: string; reason: string }> } {
  const units: DeadCodeUnit[] = []; const skipped: Array<{ id: string; reason: string }> = [];
  for (const rel of [...repo.files.keys()].filter((f) => f.startsWith(`${SRC}/`) && /\.tsx?$/.test(f)).sort()) {
    if (isTest(rel) || isEntry(rel) || productionImporters(repo, rel).length) continue;
    const built = buildUnit(repo, [rel], []);
    if (built.blocked) { skipped.push({ id: rel, reason: built.blocked }); continue; }
    units.push(unitFrom(repo, rel, 'file', built, [], ['dead-code-evidence:no code or config file names it by string (docs/reports/openspec excluded)']));
  }
  return { units, skipped };
}

/** (b) route modules with 0 hits over >= 14 days of telemetry and no caller outside the server. */
export function discoverDormantRouteGroups(repoPath: string, db: Database, now = new Date(), repo = loadRepo(repoPath)): { units: DeadCodeUnit[]; skipped: Array<{ id: string; reason: string }> } {
  const skipped: Array<{ id: string; reason: string }> = [];
  let firstDay: string | null = null;
  try { firstDay = (db.prepare("SELECT MIN(day) AS d FROM usage_counts WHERE kind = 'api'").get() as { d: string | null }).d; } catch { /* no table yet */ }
  const days = firstDay ? Math.floor((now.getTime() - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000) : 0;
  if (days < MIN_TELEMETRY_DAYS) return { units: [], skipped: [{ id: 'route-groups', reason: `usage telemetry covers ${days} day(s) < ${MIN_TELEMETRY_DAYS}` }] };
  const index = repo.files.get(ROUTES_INDEX);
  if (!index) return { units: [], skipped: [{ id: 'route-groups', reason: `${ROUTES_INDEX} not found` }] };

  const moduleOf = new Map<string, string>();
  for (const m of index.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w-]+)'/g)) for (const name of m[1].split(',')) moduleOf.set(name.replace(/^\s*type\s+/, '').trim(), m[2]);
  const mounts = new Map<string, Array<{ prefix: string; authed: boolean }>>();
  for (const m of index.matchAll(/\{\s*prefix:\s*'([^']*)',\s*middleware:\s*\[([^\]]*)\],\s*router:\s*(\w+)\(/g)) {
    const mod = moduleOf.get(m[3]); if (!mod) continue;
    if (!mounts.has(mod)) mounts.set(mod, []);
    mounts.get(mod)!.push({ prefix: m[1], authed: /\brequireAuth\b/.test(m[2]) });
  }
  const hitsOf = db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM usage_counts WHERE kind = 'api' AND (name = ? OR name LIKE ?)");
  const outside = [...repo.files].filter(([f]) => (f.startsWith('packages/') && !f.startsWith('packages/server/')) || f.startsWith('scripts/'));

  const units: DeadCodeUnit[] = [];
  for (const [mod, list] of [...mounts].sort(([a], [b]) => a.localeCompare(b))) {
    const id = `routes:${mod}`; const routeFile = `${SRC}/routes/${mod}.ts`;
    if (list.some((m) => !m.authed || m.prefix === '/')) { skipped.push({ id, reason: 'public mount (machine callers, webhooks)' }); continue; }
    const hits = list.reduce((n, m) => n + (hitsOf.get(`/api${m.prefix}`, `/api${m.prefix}/%`) as { n: number }).n, 0);
    if (hits > 0) { skipped.push({ id, reason: `${hits} hit(s) since ${firstDay}` }); continue; }
    const callers = outside.filter(([, text]) => list.some((m) => new RegExp(`${esc(m.prefix)}(?![\\w-])`).test(text))).map(([f]) => f);
    if (callers.length) { skipped.push({ id, reason: `called from ${callers.slice(0, 3).join(', ')}` }); continue; }
    const otherImporters = productionImporters(repo, routeFile).filter((f) => f !== ROUTES_INDEX);
    if (otherImporters.length) { skipped.push({ id, reason: `also imported by ${otherImporters.join(', ')}` }); continue; }
    const built = buildUnit(repo, [routeFile], [ROUTES_INDEX]);
    if (built.blocked) { skipped.push({ id, reason: built.blocked }); continue; }
    // the server calling its own API (or listing the path) is a caller the import graph cannot see
    const unitFiles = new Set([...built.remove, ...built.tests]);
    const selfCallers = [...repo.files].filter(([f, text]) => f.startsWith(`${SRC}/`) && !isTest(f) && !unitFiles.has(f)
      && list.some((m) => new RegExp(`/api${esc(m.prefix)}(?![\\w-])`).test(text))).map(([f]) => f);
    if (selfCallers.length) { skipped.push({ id, reason: `path named in ${selfCallers.slice(0, 3).join(', ')}` }); continue; }
    const endpoints = [...(repo.files.get(routeFile) ?? '').matchAll(/\brouter\.(get|post|put|patch|delete)\(/g)].length;
    const prefixes = list.map((m) => `/api${m.prefix}`).join(', ');
    units.push(unitFrom(repo, id, 'route-group', built, [ROUTES_INDEX], [
      `dead-code-evidence:usage_counts 0 api hits on ${prefixes} (and below) since ${firstDay} (${days} days), ${endpoints} endpoint(s)`,
      `dead-code-evidence:0 callers of ${list.map((m) => m.prefix).join(', ')} in packages/dashboard, packages/mcp-server, other packages or scripts`,
    ]));
  }
  return { units, skipped };
}

export function discoverDeadCode(repoPath: string, db?: Database, now = new Date()) {
  const repo = loadRepo(repoPath);
  const files = discoverUnimportedFiles(repoPath, repo);
  const routes = db ? discoverDormantRouteGroups(repoPath, db, now, repo) : { units: [], skipped: [{ id: 'route-groups', reason: 'no database' }] };
  return { units: [...files.units, ...routes.units].sort((a, b) => a.lines - b.lines || a.id.localeCompare(b.id)), skipped: [...files.skipped, ...routes.skipped] };
}

/** DEAD_CODE_REMOVE/DEAD_CODE_ALLOW for the `test:dead-code:grounded` check of a dead-code run, else {}. */
export function deadCodeCheckEnv(db: Database, goalId: string | null | undefined): Record<string, string> {
  if (!goalId) return {};
  const row = db.prepare('SELECT s.evidence_refs_json AS refs FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as { refs: string | null } | undefined;
  let refs: string[] = [];
  try { refs = JSON.parse(row?.refs || '[]'); } catch { return {}; }
  const remove = refs.find((r) => r.startsWith('dead-code-remove:'))?.slice('dead-code-remove:'.length);
  if (!remove) return {};
  return { DEAD_CODE_REMOVE: remove, DEAD_CODE_ALLOW: refs.find((r) => r.startsWith('dead-code-allow:'))?.slice('dead-code-allow:'.length) ?? '' };
}

export class DeadCodeSourceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly db: Database) {}

  start(intervalMs = 12 * 3600_000): void {
    if (this.timer || !deadCodeLaneEnabled()) return;
    const run = () => { markRun('dead_code_lane'); try { const r = this.run(); if (r.created) console.log(`🧹 dead-code lane: ${r.created} proposal(s) created`); } catch (err) { console.warn('Dead-code lane failed:', err instanceof Error ? err.message : String(err)); } };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    setTimeout(run, 120_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  run(now = new Date()): { created: number; skipped: string } {
    if (!deadCodeLaneEnabled()) return { created: 0, skipped: 'disabled' };
    const repo = process.env.TEST_GAP_REPO_PATH || process.env.LOOP_DAEMON_REPOSITORY_PATH;
    if (!repo) return { created: 0, skipped: 'no repository path' };
    const max = Number(process.env.DEAD_CODE_MAX_PER_DAY) || 2;
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const createdToday = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%\"dead-code:%' AND created_at >= ?").get(day) as { n: number }).n;
    const inFlight = (this.db.prepare("SELECT COUNT(*) n FROM self_improvements WHERE evidence_refs_json LIKE '%\"dead-code:%' AND status IN ('proposed', 'scheduled', 'executing')").get() as { n: number }).n;
    if (createdToday >= max) return { created: 0, skipped: 'daily cap reached' };
    if (inFlight >= max) return { created: 0, skipped: 'enough proposals in flight' };
    const improvements = new SelfImprovementService(this.db);
    let created = 0;
    for (const unit of discoverDeadCode(repo, this.db, now).units) {
      if (createdToday + created >= max || inFlight + created >= max) break;
      const ref = `dead-code:${unit.id}`;
      // a unit that ever had a proposal (any outcome, also a human rejection) is never proposed again automatically
      if (this.db.prepare('SELECT 1 FROM self_improvements WHERE evidence_refs_json LIKE ? LIMIT 1').get(`%"${ref}"%`)) continue;
      const command = `DEAD_CODE_REMOVE=${unit.remove.join(',')} DEAD_CODE_ALLOW=${unit.allow.join(',')} npm run test:dead-code:grounded`;
      const budget = 'one maker lease, <= 10 minutes, one checker lease; deletion only';
      const what = unit.kind === 'route-group' ? `the dormant route group ${unit.id.slice('routes:'.length)} (its registration in ${ROUTES_INDEX} and the files only it uses)` : `the unused file ${unit.remove[0]}`;
      const description = `Remove ${what}. Delete exactly: ${unit.remove.join(', ')}.`
        + (unit.allow.length ? ` You may also edit or delete only: ${unit.allow.join(', ')} (remove the import and the mount line; delete tests that exist only for the removed code).` : '')
        + ' No other edits, no replacement code. '
        + `RUNTIME COMMAND: from the repository root run \`${command}\` — it fails on any change outside these files, when the diff adds more than 10 % of the lines it removes, `
        + 'or when the full test suite of a touched package fails; `lint` and `type-check` run as the usual checks. '
        + `ARTIFACT: the command output plus the deletion diff (~${unit.lines} lines removed). BUDGET: ${budget}.`;
      const proposal = improvements.generateFromGroundedGap({
        type: 'refactor',
        title: unit.kind === 'route-group' ? `Remove dormant route group /${unit.id.slice('routes:'.length)}` : `Remove unused ${unit.remove[0].replace(/^packages\/server\/src\//, '')}`,
        description,
        rationale: `${unit.evidence.map((e) => e.replace(/^dead-code-evidence:/, '')).join('; ')}. Unused code costs review, build and audit time; a deletion is verified by one command.`,
        evidenceRef: ref,
        extraEvidenceRefs: [`dead-code-remove:${unit.remove.join(',')}`, `dead-code-allow:${unit.allow.join(',')}`, ...unit.evidence],
        grounding: { target: unit.remove[0], acceptanceTest: command, runtimeCommand: command, artifactPath: unit.remove[0], budget },
      });
      if (proposal) created += 1;
    }
    return { created, skipped: created ? '' : 'no dead-code candidate' };
  }
}
