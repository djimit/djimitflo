import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { SelfImprovementService } from './self-improvement-service';
import { enqueueEvent } from './event-outbox-service';
import { markRun } from './scheduler-registry';
import { extraRepoBySlug, primaryRepo, registeredExtraRepos } from './repo-registry';
import { deniedHosts, isDenied } from '../utils/outbound-guard';

/**
 * Advisory exposure lane (Track A, 30-10). EVE-V emits `work.action.required` events (source eve-action-processor) that
 * name GHSA / CVE ids; nothing consumed them. ADVISORY_EXPOSURE_MODE=off|shadow|on (default off):
 *   off    — nothing runs, no table is created (behaviour unchanged);
 *   shadow — intake: advisory ids by regex from title / original_text / source_excerpt (deduped by id); resolve: OSV
 *            `GET /v1/vulns/<id>` (a CVE record without package ranges follows its GHSA alias), cached in advisory_osv_cache,
 *            ≤ 20 fetches per tick, 5 s timeout, OUTBOUND_DENY_HOSTS respected; exposure: npm ranges against the lockfile of
 *            every repo Djimitflo knows (the primary checkout + GITHUB_REPOSITORY_PATHS). One `advisory_exposure` judgments
 *            row per advisory whenever its verdict changes (yes = affected, no = not_affected, uncertain = unknown) and one
 *            outbox event `djimitflo.feedback.advisory` per such row (aggregate = the source event's dedupe_key);
 *   on     — additionally one `security` proposal per affected (repo, package): bump to >= the first fixed version, change
 *            only package.json / package-lock.json; ≤ 2 per 24 h; at most one open per (repo, package). Each run gets the
 *            in-code check `test:advisory-exposure` (the exposure check re-run on the worktree lockfile, must be not_affected,
 *            plus the file scope). The panel, the maker approval and the merge stay human; a lockfile change is never in the
 *            test-only auto-merge class.
 * unknown (OSV miss/error, non-npm ecosystem, no range, a repo without an inventory) is never not_affected.
 * All event text is untrusted: it is only matched against the id regex. No LLM is used; nothing from the event text is
 * stored, published or written into a proposal (only regex-validated ids, OSV package names and semver versions).
 */
export type AdvisoryExposureMode = 'off' | 'shadow' | 'on';
export const advisoryExposureMode = (env: NodeJS.ProcessEnv = process.env): AdvisoryExposureMode =>
  env.ADVISORY_EXPOSURE_MODE === 'on' ? 'on' : env.ADVISORY_EXPOSURE_MODE === 'shadow' ? 'shadow' : 'off';
export const ADVISORY_EXPOSURE_CHECK = 'test:advisory-exposure';
/** Maker diff cap: a lockfile bump rewrites resolved/integrity lines of the package and its dependencies. */
export const ADVISORY_DIFF_MAX = 1_000;
const MAX_PER_DAY = 2;
const FETCHES_PER_TICK = 20;
const TIMEOUT_MS = 5_000;
const OSV = 'https://api.osv.dev/v1/vulns/';
const TTL_OK_MS = 7 * 86_400_000;
const TTL_ERROR_MS = 6 * 3_600_000;
const OPEN = ['proposed', 'scheduled', 'executing', 'evaluating', 'needs_grounding', 'needs_more_evidence'];
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

// ── intake ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const ID = /\b(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,7})\b/gi;

export function extractAdvisoryIds(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  const out = new Set<string>();
  for (const m of text.replace(DASHES, '-').matchAll(ID)) out.add(/^ghsa/i.test(m[1]) ? `GHSA${m[1].slice(4).toLowerCase()}` : m[1].toUpperCase());
  return [...out];
}

const obj = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== 'string') return {};
  try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
};

export interface AdvisoryIntake { id: string; source_dedupe_key: string; source_dedupe_keys: string[] }

/** Advisory ids named by EVE-V action events, oldest event first; the first event naming an id is its source. */
export function intakeAdvisories(db: Database): AdvisoryIntake[] {
  let rows: Array<{ id: string; dedupe_key: string | null; payload: string }>;
  try {
    rows = db.prepare(`SELECT id, dedupe_key, payload FROM external_events WHERE event_type = 'work.action.required' AND source = 'eve-action-processor'
      ORDER BY occurred_at ASC, id ASC`).all() as typeof rows;
  } catch { return []; }
  const byId = new Map<string, AdvisoryIntake>();
  for (const r of rows) {
    const outer = obj(r.payload);
    const p = { ...outer, ...obj(outer.payload) }; // some producers wrap the event as a JSON string in `payload`
    const ev = obj(p.evidence_json);
    const key = (typeof p.dedupe_key === 'string' && p.dedupe_key) || r.dedupe_key || r.id;
    for (const id of new Set([p.title, ev.original_text, ev.source_excerpt].flatMap(extractAdvisoryIds))) {
      const cur = byId.get(id);
      if (!cur) byId.set(id, { id, source_dedupe_key: key, source_dedupe_keys: [key] });
      else if (!cur.source_dedupe_keys.includes(key)) cur.source_dedupe_keys.push(key);
    }
  }
  return [...byId.values()];
}

// ── semver (OSV SEMVER / npm ECOSYSTEM ranges) ──────────────────────────────────────────────────────────────────────────
export interface Semver { main: [number, number, number]; pre: string[] }
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(v: unknown): Semver | null {
  const m = typeof v === 'string' ? SEMVER.exec(v.trim()) : null;
  return m ? { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
}

export function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a.main[i] !== b.main[i]) return a.main[i] < b.main[i] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1; // a prerelease sorts below its release
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]; const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

type OsvEvent = { introduced?: unknown; fixed?: unknown; last_affected?: unknown; limit?: unknown };

/**
 * OSV range evaluation (the spec's pseudo-code over version-sorted events): introduced ≤ v sets affected, fixed ≤ v or
 * last_affected < v clears it. `fixed` is the first fix above v. null when an event is not semver: unknown, never "outside".
 */
export function rangeAffects(events: OsvEvent[], version: Semver): { affected: boolean; fixed: string | null } | null {
  const list: Array<{ kind: 'introduced' | 'fixed' | 'last_affected' | 'limit'; v: Semver | null; raw: string }> = [];
  for (const e of events) {
    for (const kind of ['introduced', 'fixed', 'last_affected', 'limit'] as const) {
      const raw = e[kind];
      if (raw === undefined) continue;
      if (typeof raw !== 'string') return null;
      if ((kind === 'introduced' && raw === '0') || (kind === 'limit' && raw === '*')) { if (kind === 'introduced') list.push({ kind, v: null, raw }); continue; }
      const v = parseSemver(raw);
      if (!v) return null;
      list.push({ kind, v, raw });
    }
  }
  list.sort((a, b) => (a.v && b.v ? compareSemver(a.v, b.v) : a.v ? 1 : b.v ? -1 : 0));
  let affected = false;
  for (const e of list) {
    const c = e.v ? compareSemver(version, e.v) : 1;
    if (e.kind === 'introduced' && c >= 0) affected = true;
    else if (e.kind === 'fixed' && c >= 0) affected = false;
    else if (e.kind === 'last_affected' && c > 0) affected = false;
    else if (e.kind === 'limit' && c >= 0) affected = false;
  }
  const fixed = affected ? list.find((e) => e.kind === 'fixed' && compareSemver(version, e.v!) < 0)?.raw ?? null : null;
  return { affected, fixed };
}

// ── inventory ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface RepoInventory {
  repo: string; status: 'ok' | 'no_npm_manifest' | 'no_lockfile' | 'unreadable'; lockfile: string | null; lockfile_sha: string | null;
  packages: Map<string, string[]>;
}

/** Installed npm versions per package from the repo root's lockfile (v1 dependencies tree or v2/v3 packages map). */
export function readInventory(repo: string, dir: string): RepoInventory {
  const none = (status: RepoInventory['status'], lockfile: string | null = null, sha: string | null = null): RepoInventory =>
    ({ repo, status, lockfile, lockfile_sha: sha, packages: new Map() });
  try { if (!fs.statSync(dir).isDirectory()) return none('unreadable'); } catch { return none('unreadable'); }
  const lockfile = ['npm-shrinkwrap.json', 'package-lock.json'].find((f) => fs.existsSync(path.join(dir, f)));
  if (!lockfile) return none(['package.json', 'yarn.lock', 'pnpm-lock.yaml'].some((f) => fs.existsSync(path.join(dir, f))) ? 'no_lockfile' : 'no_npm_manifest');
  let text: string; let json: Record<string, unknown>;
  try { text = fs.readFileSync(path.join(dir, lockfile), 'utf8'); json = obj(text); } catch { return none('unreadable', lockfile); }
  const sha = createHash('sha256').update(text).digest('hex');
  const packages = new Map<string, string[]>();
  const add = (name: unknown, version: unknown) => {
    if (typeof name !== 'string' || typeof version !== 'string') return;
    const list = packages.get(name) ?? [];
    if (!list.includes(version)) list.push(version);
    packages.set(name, list);
  };
  const map = obj(json.packages);
  if (Object.keys(map).length) {
    for (const [key, raw] of Object.entries(map)) {
      const i = key.lastIndexOf('node_modules/');
      const e = obj(raw);
      if (i < 0 || e.link === true) continue; // the root, workspace folders and workspace links are not installed packages
      add(typeof e.name === 'string' ? e.name : key.slice(i + 'node_modules/'.length), e.version);
    }
  } else {
    const walk = (deps: Record<string, unknown>, depth: number) => {
      if (depth > 64) return;
      for (const [name, raw] of Object.entries(deps)) { const e = obj(raw); add(name, e.version); walk(obj(e.dependencies), depth + 1); }
    };
    walk(obj(json.dependencies), 0);
  }
  if (!Object.keys(map).length && !Object.keys(obj(json.dependencies)).length && !('lockfileVersion' in json)) return none('unreadable', lockfile, sha);
  return { repo, status: 'ok', lockfile, lockfile_sha: sha, packages };
}

export interface KnownRepo { slug: string; path: string; primary: boolean }
/** The primary checkout (TEST_GAP_REPO_PATH / LOOP_DAEMON_REPOSITORY_PATH / its GITHUB_REPOSITORY_PATHS entry) + registered extras. */
export function knownRepos(env: NodeJS.ProcessEnv = process.env): KnownRepo[] {
  const primary = primaryRepo(env);
  const map = obj(env.GITHUB_REPOSITORY_PATHS || '{}');
  const own = env.TEST_GAP_REPO_PATH || env.LOOP_DAEMON_REPOSITORY_PATH || (typeof map[primary] === 'string' ? map[primary] as string : '');
  return [...(own ? [{ slug: primary, path: own, primary: true }] : []), ...registeredExtraRepos(env).map((r) => ({ ...r, primary: false }))];
}

// ── exposure ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Verdict = 'affected' | 'not_affected' | 'unknown';
export interface OsvCacheRow { id: string; status: string; fetched_at: string; affected_json: string | null; error: string | null }
interface NpmAffected { name: string; ranges: OsvEvent[][]; versions: string[]; unusable: boolean }
export interface PackageEvidence { name: string; status: 'absent' | 'outside_range' | 'affected' | 'unknown'; installed: string[]; first_fixed: string | null; affected_versions?: string[]; reason?: string }
export interface AffectedHit { repo: string; package: string; installed_version: string; first_fixed_version: string | null }
export interface ExposureResult {
  advisory_id: string; verdict: Verdict; reason: string;
  repos: Array<{ repo: string; status: RepoInventory['status']; lockfile: string | null; lockfile_sha: string | null; packages: PackageEvidence[] }>;
  affected: AffectedHit[];
}

function npmAffected(affectedJson: string | null): { npm: NpmAffected[]; other: string[] } {
  let list: unknown;
  try { list = JSON.parse(affectedJson || '[]'); } catch { list = []; }
  const npm: NpmAffected[] = []; const other = new Set<string>();
  for (const a of Array.isArray(list) ? list : []) {
    const e = obj(a); const pkg = obj(e.package);
    if (typeof pkg.ecosystem !== 'string') continue; // a GIT-only entry names no package
    if (pkg.ecosystem !== 'npm') { other.add(pkg.ecosystem.slice(0, 40)); continue; }
    const name = typeof pkg.name === 'string' && pkg.name.length <= 214 && NPM_NAME.test(pkg.name) ? pkg.name : null;
    if (!name) { other.add('npm:invalid-name'); continue; }
    const ranges = (Array.isArray(e.ranges) ? e.ranges : []).map(obj).filter((r) => r.type === 'SEMVER' || r.type === 'ECOSYSTEM')
      .map((r) => (Array.isArray(r.events) ? r.events.map(obj) : []) as OsvEvent[]);
    const versions = (Array.isArray(e.versions) ? e.versions : []).filter((v): v is string => typeof v === 'string');
    npm.push({ name, ranges, versions, unusable: !ranges.some((r) => r.length) && !versions.length });
  }
  return { npm, other: [...other] };
}

/** One package's exposure for the given installed versions (affected wins; any unparsable piece makes it unknown). */
function packageExposure(entries: NpmAffected[], name: string, installed: string[]): PackageEvidence {
  if (!installed.length) return { name, status: 'absent', installed: [], first_fixed: null };
  const hits: string[] = []; const fixes: Semver[] = []; let unknown: string | null = null;
  for (const raw of installed) {
    const v = parseSemver(raw);
    if (!v) { unknown = `unparsable_version:${raw.slice(0, 40)}`; continue; }
    let hit = false;
    for (const e of entries) {
      if (e.unusable) unknown = 'no_range';
      if (e.versions.includes(raw)) hit = true;
      for (const events of e.ranges) {
        const r = rangeAffects(events, v);
        if (!r) { unknown = 'unparsable_range'; continue; }
        if (r.affected) { hit = true; if (r.fixed) fixes.push(parseSemver(r.fixed)!); }
      }
    }
    if (hit) hits.push(raw);
  }
  if (hits.length) {
    const top = fixes.sort(compareSemver).pop();
    return { name, status: 'affected', installed, first_fixed: top ? `${top.main.join('.')}${top.pre.length ? `-${top.pre.join('.')}` : ''}` : null, affected_versions: hits };
  }
  return unknown ? { name, status: 'unknown', installed, first_fixed: null, reason: unknown } : { name, status: 'outside_range', installed, first_fixed: null };
}

export function evaluateAdvisory(id: string, cache: OsvCacheRow, inventories: RepoInventory[]): ExposureResult {
  const base = { advisory_id: id, repos: [] as ExposureResult['repos'], affected: [] as AffectedHit[] };
  if (cache.status !== 'ok') return { ...base, verdict: 'unknown', reason: cache.status === 'not_found' ? 'osv_not_found' : `osv_error:${String(cache.error ?? 'unknown').slice(0, 80)}` };
  const { npm, other } = npmAffected(cache.affected_json);
  if (!npm.length) return { ...base, verdict: 'unknown', reason: other.length ? `non_npm_ecosystem:${other.join(',')}` : 'no_affected_package' };
  const gaps: string[] = [];
  if (other.length) gaps.push(`other_ecosystems_unchecked:${other.join(',')}`);
  const noRange = npm.filter((e) => e.unusable).map((e) => e.name);
  if (noRange.length) gaps.push(`no_range:${noRange.join(',')}`);
  // not_affected needs at least one readable npm lockfile: repos without any npm manifest alone prove nothing
  if (!inventories.some((i) => i.status === 'ok')) gaps.push(inventories.length ? 'no_npm_inventory' : 'no_repos');
  const names = [...new Set(npm.map((e) => e.name))];
  const repos = inventories.map((inv) => {
    if (inv.status !== 'ok') { if (inv.status !== 'no_npm_manifest') gaps.push(`no_inventory:${inv.repo}`); return { repo: inv.repo, status: inv.status, lockfile: inv.lockfile, lockfile_sha: inv.lockfile_sha, packages: [] }; }
    const packages = names.map((name) => packageExposure(npm.filter((e) => e.name === name), name, inv.packages.get(name) ?? []));
    for (const p of packages) {
      if (p.status === 'unknown') gaps.push(`${p.reason}:${inv.repo}/${p.name}`);
      for (const v of p.affected_versions ?? []) {
        const one = packageExposure(npm.filter((e) => e.name === p.name), p.name, [v]);
        base.affected.push({ repo: inv.repo, package: p.name, installed_version: v, first_fixed_version: one.first_fixed });
      }
    }
    return { repo: inv.repo, status: inv.status, lockfile: inv.lockfile, lockfile_sha: inv.lockfile_sha, packages: packages.map(({ affected_versions: _a, ...rest }) => rest) };
  });
  base.repos = repos;
  if (base.affected.length) return { ...base, verdict: 'affected', reason: `${base.affected.length} installed version(s) in range` };
  if (gaps.length) return { ...base, verdict: 'unknown', reason: gaps.slice(0, 5).join('; ') };
  return { ...base, verdict: 'not_affected', reason: `${names.join(',')} absent or outside the affected range in ${inventories.length} repo(s)` };
}

// ── OSV resolution ──────────────────────────────────────────────────────────────────────────────────────────────────────
export function ensureAdvisoryTables(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS advisory_osv_cache (id TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, status TEXT NOT NULL,
    affected_json TEXT, records_json TEXT, error TEXT)`);
}

type Fetched = { status: 'ok'; record: Record<string, unknown> } | { status: 'not_found' | 'error'; error?: string };
const trimAffected = (record: Record<string, unknown>) => (Array.isArray(record.affected) ? record.affected : []).map(obj).map((a) => ({
  package: obj(a.package), ranges: Array.isArray(a.ranges) ? a.ranges.map(obj).map((r) => ({ type: r.type, events: r.events })) : [],
  versions: Array.isArray(a.versions) ? a.versions.slice(0, 1000) : [],
}));
const hasPackage = (record: Record<string, unknown>) => trimAffected(record).some((a) => typeof a.package.ecosystem === 'string');

/** Resolve up to FETCHES_PER_TICK uncached / stale ids into advisory_osv_cache; returns the number of HTTP calls made. */
async function resolve(db: Database, ids: string[], env: NodeJS.ProcessEnv, now: Date, fetchImpl: typeof fetch): Promise<number> {
  const denied = deniedHosts(env);
  const cached = new Map((db.prepare('SELECT id, status, fetched_at FROM advisory_osv_cache').all() as Array<{ id: string; status: string; fetched_at: string }>).map((r) => [r.id, r]));
  const due = ids.filter((id) => { const c = cached.get(id); return !c || now.getTime() - Date.parse(c.fetched_at) > (c.status === 'error' ? TTL_ERROR_MS : TTL_OK_MS); })
    .sort((a, b) => Number(cached.has(a)) - Number(cached.has(b))); // never fetched first
  let calls = 0;
  const get = async (id: string): Promise<Fetched> => {
    const url = `${OSV}${encodeURIComponent(id)}`;
    if (isDenied(url, denied)) return { status: 'error', error: 'outbound_denied' };
    calls += 1;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
      if (res.status === 404) return { status: 'not_found' };
      if (!res.ok) return { status: 'error', error: `http_${res.status}` };
      const record = obj(await res.json());
      return Object.keys(record).length ? { status: 'ok', record } : { status: 'error', error: 'unreadable_json' };
    } catch (e) { return { status: 'error', error: (e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : e instanceof Error ? e.message : String(e)).slice(0, 120) }; }
  };
  const save = db.prepare(`INSERT INTO advisory_osv_cache (id, fetched_at, status, affected_json, records_json, error) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, status = excluded.status, affected_json = excluded.affected_json, records_json = excluded.records_json, error = excluded.error`);
  for (const id of due) {
    if (calls >= FETCHES_PER_TICK) break;
    let r = await get(id); const records = [id];
    if (r.status === 'ok' && !hasPackage(r.record)) {
      // a CVE record (NVD import) carries GIT ranges only; the package ranges live in its GHSA alias
      const alias = (Array.isArray(r.record.aliases) ? r.record.aliases : []).find((a): a is string => typeof a === 'string' && /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/.test(a));
      if (alias) {
        if (calls >= FETCHES_PER_TICK) break; // retried next tick
        const via = await get(alias);
        if (via.status === 'ok') { r = via; records.push(alias); }
      }
    }
    save.run(id, now.toISOString(), r.status, r.status === 'ok' ? JSON.stringify(trimAffected(r.record)) : null, JSON.stringify(records), r.status === 'ok' ? null : (r.error ?? null));
    if (r.status === 'error' && r.error === 'outbound_denied') break;
  }
  return calls;
}

// ── tick ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const ADVISORY_FEEDBACK_EVENT = 'djimitflo.feedback.advisory';
const DECISION: Record<Verdict, string> = { affected: 'yes', not_affected: 'no', unknown: 'uncertain' };
export interface AdvisoryTickResult { mode: AdvisoryExposureMode; advisories: number; fetched: number; written: number; proposals: number; by_verdict: Record<Verdict, number> | null }

export async function runAdvisoryExposureTick(db: Database, env: NodeJS.ProcessEnv = process.env,
  opts: { now?: Date; fetchImpl?: typeof fetch } = {}): Promise<AdvisoryTickResult> {
  const mode = advisoryExposureMode(env);
  const result: AdvisoryTickResult = { mode, advisories: 0, fetched: 0, written: 0, proposals: 0, by_verdict: null };
  if (mode === 'off') return result;
  const now = opts.now ?? new Date();
  ensureAdvisoryTables(db);
  const intake = intakeAdvisories(db);
  result.advisories = intake.length;
  // globalThis.fetch at call time: the outbound guard wraps it after this module loads
  result.fetched = await resolve(db, intake.map((i) => i.id), env, now, opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)));
  const cache = new Map((db.prepare('SELECT id, status, fetched_at, affected_json, error FROM advisory_osv_cache').all() as OsvCacheRow[]).map((r) => [r.id, r]));
  const inventories = knownRepos(env).map((r) => readInventory(r.slug, r.path));
  const results: ExposureResult[] = [];
  const counts: Record<Verdict, number> = { affected: 0, not_affected: 0, unknown: 0 };
  const latest = db.prepare("SELECT state_hash FROM judgments WHERE judgment = 'advisory_exposure' AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1");
  const insert = db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
    VALUES (?, 'advisory_exposure', 'advisory', ?, ?, ?, ?, ?, ?, ?)`);
  for (const adv of intake) {
    const c = cache.get(adv.id);
    if (!c) continue; // not fetched yet: pending, not judged
    const r = evaluateAdvisory(adv.id, c, inventories);
    results.push(r); counts[r.verdict] += 1;
    // a new row only when the verdict or its affected set changes (a lockfile sha change alone is not a new judgment)
    const hash = createHash('sha256').update(JSON.stringify([r.verdict, r.reason, r.affected])).digest('hex');
    if ((latest.get(adv.id) as { state_hash: string } | undefined)?.state_hash === hash) continue;
    const judgmentId = randomUUID();
    const answers = { advisory_id: adv.id, verdict: r.verdict, source_dedupe_key: adv.source_dedupe_key, source_dedupe_keys: adv.source_dedupe_keys.slice(0, 20),
      osv: { status: c.status, fetched_at: c.fetched_at }, repos: r.repos, affected: r.affected };
    insert.run(judgmentId, adv.id, hash, mode, DECISION[r.verdict], r.reason, JSON.stringify(answers), now.toISOString());
    result.written += 1;
    enqueueEvent(db, { type: ADVISORY_FEEDBACK_EVENT, aggregateId: adv.source_dedupe_key, correlationId: adv.id, payload: {
      advisory_id: adv.id, source_dedupe_key: adv.source_dedupe_key, verdict: r.verdict, reason: r.reason, judgment_id: judgmentId,
      repos_checked: r.repos.map((x) => ({ repo: x.repo, status: x.status, lockfile_sha: x.lockfile_sha })), affected: r.affected.slice(0, 20) } });
  }
  result.by_verdict = counts;
  if (mode === 'on') result.proposals = proposeBumps(db, results, inventories, env, now);
  return result;
}

// ── on: one bump proposal per affected (repo, package) ──────────────────────────────────────────────────────────────────
function proposeBumps(db: Database, results: ExposureResult[], inventories: RepoInventory[], env: NodeJS.ProcessEnv, now: Date): number {
  const groups = new Map<string, { repo: string; pkg: string; ids: Set<string>; installed: Set<string>; fixed: Semver[]; noFix: boolean }>();
  for (const r of results) for (const h of r.affected) {
    const k = `${h.repo}\0${h.package}`;
    const g = groups.get(k) ?? { repo: h.repo, pkg: h.package, ids: new Set<string>(), installed: new Set<string>(), fixed: [], noFix: false };
    g.ids.add(r.advisory_id); g.installed.add(h.installed_version);
    const f = parseSemver(h.first_fixed_version);
    if (f) g.fixed.push(f); else g.noFix = true;
    groups.set(k, g);
  }
  const existing = (db.prepare("SELECT status, evidence_refs_json AS refs, created_at FROM self_improvements WHERE evidence_refs_json LIKE '%\"advisory-exposure:%'").all() as Array<{ status: string; refs: string; created_at: string }>)
    .map((r) => { let refs: string[] = []; try { refs = JSON.parse(r.refs); } catch { /* none */ } return { ...r, ref: refs.find((x) => typeof x === 'string' && x.startsWith('advisory-exposure:')) ?? '' }; });
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  let room = MAX_PER_DAY - existing.filter((e) => e.created_at >= since).length;
  const primary = primaryRepo(env);
  const improvements = new SelfImprovementService(db);
  let created = 0;
  for (const g of [...groups.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.pkg.localeCompare(b.pkg))) {
    if (room <= 0) break;
    if (g.noFix || !g.fixed.length) continue; // no fixed version published: nothing to bump to
    const isPrimary = g.repo.toLowerCase() === primary.toLowerCase();
    if (!isPrimary && !extraRepoBySlug(g.repo, env)) continue; // an extra repo acts only with EXTRA_REPOS_ENABLED=on
    const top = g.fixed.sort(compareSemver)[g.fixed.length - 1];
    const fixed = `${top.main.join('.')}${top.pre.length ? `-${top.pre.join('.')}` : ''}`;
    const ref = `advisory-exposure:${g.repo}/${g.pkg}@${fixed}`;
    if (existing.some((e) => e.ref === ref || (e.ref.startsWith(`advisory-exposure:${g.repo}/${g.pkg}@`) && OPEN.includes(e.status)))) continue;
    const ids = [...g.ids].sort();
    const inv = inventories.find((i) => i.repo === g.repo);
    const command = `npm ls ${g.pkg} --all`;
    const budget = 'one maker lease, <= 15 minutes, one checker lease; package.json / package-lock.json only';
    const description = `Advisory exposure lane: the OSV records ${ids.join(', ')} list ${g.pkg} ${[...g.installed].sort().join(', ')} (installed in ${g.repo}, lockfile sha ${inv?.lockfile_sha?.slice(0, 12) ?? 'unknown'}) as affected. `
      + `Bump ${g.pkg} to >= ${fixed} in ${g.repo}. Change only package.json / package-lock.json files: a direct dependency via its version range, a transitive one via \`npm update ${g.pkg}\` or an \`overrides\` entry in the root package.json. `
      + 'Do not edit source, tests, configs or other files and do not remove unrelated dependencies. '
      + `RUNTIME COMMAND: from the repository root run \`${command}\` — every listed ${g.pkg} version must be >= ${fixed}. `
      + `The in-code check ${ADVISORY_EXPOSURE_CHECK} re-runs the exposure check on the worktree lockfile (must be not_affected for ${ids.join(', ')}) and fails on any changed file other than package.json / package-lock.json; test, lint and type-check run as the usual checks. `
      + `ARTIFACT: the package-lock.json diff. BUDGET: ${budget}.`;
    const p = improvements.generateFromGroundedGap({
      type: 'security',
      title: `Bump ${g.pkg} to >= ${fixed} in ${g.repo}`,
      description,
      rationale: `OSV (${ids.join(', ')}): ${g.pkg} ${[...g.installed].sort().join(', ')} in ${g.repo} is in an affected range; first fixed ${fixed}. Verified by re-running the exposure check on the worktree lockfile.`,
      evidenceRef: ref,
      extraEvidenceRefs: [...ids.map((id) => `advisory-id:${id}`), `advisory-pkg:${g.pkg}`, ...(inv?.lockfile_sha ? [`advisory-lock:${inv.lockfile_sha.slice(0, 12)}`] : []), ...(isPrimary ? [] : [`repo:${g.repo}`])],
      grounding: { target: inv?.lockfile ?? 'package-lock.json', acceptanceTest: `${ADVISORY_EXPOSURE_CHECK} (in-code): not_affected on the worktree lockfile`, runtimeCommand: command, artifactPath: inv?.lockfile ?? 'package-lock.json', budget },
    });
    if (p) { created += 1; room -= 1; }
  }
  return created;
}

// ── the executable check of an advisory run ─────────────────────────────────────────────────────────────────────────────
/** The advisory refs of a goal's proposal, or null for every other goal. */
export function advisoryGoalRefs(db: Database, goalId: string | null | undefined): { pkg: string; fixed: string; ids: string[] } | null {
  if (!goalId) return null;
  let refs: unknown;
  try {
    const row = db.prepare('SELECT s.evidence_refs_json AS refs FROM goals g JOIN self_improvements s ON s.id = g.improvement_id WHERE g.id = ?').get(goalId) as { refs: string | null } | undefined;
    refs = JSON.parse(row?.refs || '[]');
  } catch { return null; }
  if (!Array.isArray(refs)) return null;
  const main = refs.find((r): r is string => typeof r === 'string' && r.startsWith('advisory-exposure:'));
  if (!main) return null;
  const pkg = refs.find((r): r is string => typeof r === 'string' && r.startsWith('advisory-pkg:'))?.slice('advisory-pkg:'.length) ?? '';
  return { pkg, fixed: main.slice(main.lastIndexOf('@') + 1), ids: refs.filter((r): r is string => typeof r === 'string' && r.startsWith('advisory-id:')).map((r) => r.slice('advisory-id:'.length)) };
}

const IN_SCOPE = (f: string) => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(f) && !f.split('/').includes('node_modules');

/** Re-runs the exposure check on the worktree lockfile (null for a non-advisory goal). Missing inputs fail; never skipped. */
export function advisoryExposureCheck(db: Database, goalId: string | null | undefined, worktree: string, outputDir: string, changedFiles?: unknown): Record<string, unknown> | null {
  const refs = advisoryGoalRefs(db, goalId);
  if (!refs) return null;
  const reasons: string[] = [];
  const inv = readInventory('worktree', worktree);
  if (inv.status !== 'ok') reasons.push(`no_lockfile:${inv.status}`);
  if (!refs.pkg || !NPM_NAME.test(refs.pkg) || !refs.ids.length) reasons.push('missing_refs');
  const advisories: Array<Record<string, unknown>> = [];
  let cache: OsvCacheRow[] = [];
  try { cache = db.prepare('SELECT id, status, fetched_at, affected_json, error FROM advisory_osv_cache').all() as OsvCacheRow[]; } catch { /* table absent: every id is missing */ }
  for (const id of refs.ids) {
    const c = cache.find((r) => r.id === id);
    if (!c || c.status !== 'ok') { reasons.push(`osv_cache_missing:${id}`); continue; }
    const entries = npmAffected(c.affected_json).npm.filter((e) => e.name === refs.pkg);
    if (!entries.length) { reasons.push(`no_npm_entry:${id}`); continue; }
    const p = packageExposure(entries, refs.pkg, inv.packages.get(refs.pkg) ?? []);
    advisories.push({ id, status: p.status, installed: p.installed });
    if (p.status === 'affected') reasons.push(`still_affected:${id}:${(p.affected_versions ?? []).join(',')}`);
    else if (p.status === 'unknown') reasons.push(`unknown:${id}:${p.reason}`);
  }
  const git = spawnSync('git', ['-C', worktree, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  const changed = new Set((git.stdout || '').split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '')));
  if (Array.isArray(changedFiles)) for (const f of changedFiles) if (typeof f === 'string') changed.add(f);
  if (git.status !== 0 && !Array.isArray(changedFiles)) reasons.push('changed_files_unreadable');
  const outside = [...changed].filter((f) => !IN_SCOPE(f));
  if (outside.length) reasons.push(`out_of_scope:${outside.slice(0, 5).join(',')}`);
  const pass = reasons.length === 0;
  const stdoutPath = path.join(outputDir, `${ADVISORY_EXPOSURE_CHECK}.stdout.log`);
  const stderrPath = path.join(outputDir, `${ADVISORY_EXPOSURE_CHECK}.stderr.log`);
  fs.writeFileSync(stdoutPath, `${JSON.stringify({ advisory_exposure_check: { pass, package: refs.pkg, target: refs.fixed, lockfile_sha: inv.lockfile_sha, advisories, changed_files: [...changed].slice(0, 50), reasons } })}\n`, 'utf8');
  fs.writeFileSync(stderrPath, reasons.join('\n'), 'utf8');
  return { name: ADVISORY_EXPOSURE_CHECK, status: pass ? 'pass' : 'fail', ...(pass ? {} : { reason: reasons[0].slice(0, 200) }), exit_status: pass ? 0 : 1, stdout_path: stdoutPath, stderr_path: stderrPath };
}

// ── evidence ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Read-only section `advisory_exposure`: latest verdict per advisory; null counts when nothing has been judged (not 0). */
export function advisoryExposureEvidence(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const mode = advisoryExposureMode(env);
  let rows: Array<{ subject_id: string; decision: string; answers_json: string | null; created_at: string }> = [];
  try {
    rows = db.prepare(`SELECT subject_id, decision, answers_json, created_at FROM judgments j WHERE judgment = 'advisory_exposure'
      AND rowid = (SELECT rowid FROM judgments k WHERE k.judgment = 'advisory_exposure' AND k.subject_id = j.subject_id ORDER BY created_at DESC, rowid DESC LIMIT 1)`).all() as typeof rows;
  } catch { /* judgments absent */ }
  let pending: number | null = null;
  try {
    const cached = (db.prepare('SELECT COUNT(*) AS n FROM advisory_osv_cache').get() as { n: number }).n;
    pending = Math.max(0, intakeAdvisories(db).length - cached);
  } catch { /* cache table absent: the lane never ran */ }
  let proposals: Record<string, number> | null = null;
  try {
    proposals = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) AS n FROM self_improvements WHERE evidence_refs_json LIKE '%"advisory-exposure:%' GROUP BY status`).all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
  } catch { /* none */ }
  if (!rows.length) return { mode, advisories: null, by_verdict: null, affected: [] as Array<Record<string, unknown>>, pending, proposals, last_judged_at: null };
  const by: Record<Verdict, number> = { affected: 0, not_affected: 0, unknown: 0 };
  const affected: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const v: Verdict = r.decision === 'yes' ? 'affected' : r.decision === 'no' ? 'not_affected' : 'unknown';
    by[v] += 1;
    if (v === 'affected') for (const h of (obj(r.answers_json).affected as AffectedHit[] | undefined) ?? []) affected.push({ advisory_id: r.subject_id, ...h });
  }
  return { mode, advisories: rows.length, by_verdict: by, affected: affected.slice(0, 50), pending, proposals, last_judged_at: rows.map((r) => r.created_at).sort().pop() ?? null };
}

export class AdvisoryExposureService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  constructor(private readonly db: Database) {}
  start(intervalMs = 3_600_000): void {
    if (this.timer || advisoryExposureMode() === 'off') return;
    const run = () => {
      if (this.running) return;
      this.running = true;
      runAdvisoryExposureTick(this.db).then((r) => {
        markRun('advisory_exposure');
        if (r.written || r.proposals) console.log(`🛡️  advisory exposure (${r.mode}): ${r.written} verdict change(s), ${r.proposals} proposal(s); fetched ${r.fetched}`);
      }).catch((e) => { markRun('advisory_exposure', e); console.warn('advisory exposure failed:', e instanceof Error ? e.message : String(e)); })
        .finally(() => { this.running = false; });
    };
    this.timer = setInterval(run, intervalMs); this.timer.unref?.();
    setTimeout(run, 240_000).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
