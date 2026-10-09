import { createHash } from 'crypto';
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import type { Database } from 'better-sqlite3';
import { checkAdmission } from '../execution/runtime-admission';
import { markRun } from './scheduler-registry';

/**
 * Shipped-code scan (operator 09-10, "option B"): what an installed runtime package actually ships, read from disk and
 * never executed. The runtime-admission `supply_chain` gate used to rest on hand-written notes ("npm registry integrity
 * only", "postinstall downloads a binary"); this produces a deterministic, content-hashed report per package@version —
 * lifecycle scripts, bins, every file's sha256, native binaries, and per-JS-file findings from a real parse — and the
 * release-to-release delta. SHADOW ONLY (SHIPPED_CODE_SCAN_MODE=off|shadow, default off): reports are stored and the
 * hash is recorded as an evidence_refs *candidate* in a `shipped_code_scan` judgment; no admission decision changes.
 *
 * Safety: scanned files are untrusted text. They are hashed and parsed (TypeScript compiler API, ScriptKind.JS), never
 * required, imported or run; symlinks are listed, never followed; file count, parse size and wall time are capped. Nothing
 * here sends scanned text to a model.
 * ponytail: the TS parser is a devDependency (absent from the --omit=dev prod image); without it the report still carries
 * scripts/bins/hashes/binaries and says `js_parser_unavailable`. Upgrade trigger: an operator decision to ship a parser.
 */

export const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const;
const NETWORK_MODULES = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns']);
const PROCESS_MODULES = new Set(['child_process', 'worker_threads', 'cluster']);
const CODE_MODULES = new Set(['vm']);
const TOKEN_ENV = /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|AUTH|SESSION|COOKIE/i;
const FS_WRITES = new Set(['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'copyFile',
  'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'symlink', 'symlinkSync', 'chmod', 'chmodSync', 'rm', 'rmSync', 'unlink', 'unlinkSync', 'outputFile', 'outputFileSync']);
const JS_EXT = /\.(?:js|cjs|mjs)$/;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s'"`<>()\\]+/g;
const MAX_FINDINGS_PER_FILE = 200;

export const SCAN_DEFAULTS = { maxParseBytes: 5 * 1024 * 1024, maxFiles: 20_000, maxHashBytes: 512 * 1024 * 1024, deadlineMs: 120_000 };

export type FindingKind = 'module_import' | 'endpoint' | 'eval' | 'new_function' | 'dynamic_require' | 'dynamic_import' | 'env_token_read' | 'home_write';
export interface Finding { kind: FindingKind; file: string; line: number; detail: string }
export interface ShippedCodeReport {
  schema: 'shipped-code-scan/v1';
  package: { name: string | null; version: string | null };
  parser: { name: 'typescript'; version: string } | null;
  limits: { max_parse_bytes: number; max_files: number; max_hash_bytes: number };
  lifecycle: Array<{ script: string; command: string }>;
  nested_lifecycle: Array<{ package: string; path: string; script: string; command: string }>;
  bin: Array<{ name: string; path: string }>;
  files: Array<{ path: string; size: number; sha256: string | null }>;
  symlinks: Array<{ path: string; target: string }>;
  binaries: Array<{ path: string; format: 'elf' | 'macho' | 'pe'; size: number; sha256: string | null }>;
  js: { parsed: number; skipped: Array<{ path: string; reason: string }> };
  findings: Finding[];
  hosts: string[];
  truncated: string[];
  report_hash: string;
}
export interface ScanOptions { maxParseBytes?: number; maxFiles?: number; maxHashBytes?: number; deadlineMs?: number; parser?: TsLike | null }

// ─── TypeScript compiler API, loaded lazily and typed structurally ──────────────────────────────────────────────────
// The server's own `typescript` is 7.x (native compiler, no JS API). A 6.x JS API ships as the runtime dependency alias
// `typescript-parser` (npm:typescript@6.x, present under --omit=dev); the root workspace's dev `typescript` is the fallback.
interface TsNode { kind: number; [k: string]: any }
export interface TsLike {
  version: string;
  SyntaxKind: Record<string, number>;
  ScriptTarget: Record<string, number>;
  ScriptKind: Record<string, number>;
  createSourceFile(name: string, text: string, target: number, setParents: boolean, kind: number): TsNode & { getLineAndCharacterOfPosition(pos: number): { line: number } };
  forEachChild(node: TsNode, cb: (n: TsNode) => void): void;
}
let cachedTs: TsLike | null | undefined;
const TS_CANDIDATES: Array<[from: string, id: string]> = [
  [__filename, 'typescript-parser'],
  [__filename, 'typescript'],
  [path.resolve(__dirname, '../../../../package.json'), 'typescript'],
];
export function loadTsParser(candidates: Array<[from: string, id: string]> = TS_CANDIDATES): TsLike | null {
  const useCache = candidates === TS_CANDIDATES;
  if (useCache && cachedTs !== undefined) return cachedTs;
  let found: TsLike | null = null;
  for (const [from, id] of candidates) {
    try {
      const ts = createRequire(from)(id) as Partial<TsLike>;
      if (typeof ts.createSourceFile === 'function' && typeof ts.forEachChild === 'function') { found = ts as TsLike; break; }
    } catch { /* not installed here */ }
  }
  if (useCache) cachedTs = found;
  return found;
}

// ─── Canonical JSON + hashing ───────────────────────────────────────────────────────────────────────────────────────
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
/** sha256 of the canonical JSON of the report body (report_hash itself excluded). */
export function reportHash(r: Omit<ShippedCodeReport, 'report_hash'> & { report_hash?: string }): string {
  const { report_hash: _omit, ...body } = r;
  return createHash('sha256').update(canonical(body)).digest('hex');
}

/** Streams the file through sha256 (no whole-file buffer); also returns the first 4 bytes for magic detection. */
function hashFile(abs: string, size: number, maxHashBytes: number): { sha256: string | null; head: Buffer } {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(1 << 20, Math.max(4, size)));
    const head = Buffer.alloc(4);
    const h = size <= maxHashBytes ? createHash('sha256') : null;
    let pos = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      if (pos === 0) buf.copy(head, 0, 0, Math.min(4, n));
      if (!h) break;
      h.update(buf.subarray(0, n)); pos += n;
    }
    return { sha256: h ? h.digest('hex') : null, head };
  } finally { closeSync(fd); }
}

function binaryFormat(head: Buffer): 'elf' | 'macho' | 'pe' | null {
  const hex = head.toString('hex');
  if (hex === '7f454c46') return 'elf';
  if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(hex)) return 'macho';
  if (head[0] === 0x4d && head[1] === 0x5a) return 'pe';
  return null;
}

const moduleName = (spec: string) => spec.replace(/^node:/, '').split('/')[0];
function moduleCategory(spec: string): string | null {
  const m = moduleName(spec);
  if (NETWORK_MODULES.has(m)) return 'network';
  if (PROCESS_MODULES.has(m)) return 'process';
  if (CODE_MODULES.has(m)) return 'code';
  return null;
}
const hostOf = (url: string): string | null => { try { return new URL(url).hostname || null; } catch { return null; } };

/** Parse-only JS findings for one file. `text` is untrusted and is never evaluated. */
function analyzeJs(ts: TsLike, file: string, text: string, hosts: Set<string>): Finding[] {
  const SK = ts.SyntaxKind;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: Finding[] = [];
  const add = (kind: FindingKind, node: TsNode, detail: string) => {
    const start = typeof node.getStart === 'function' ? node.getStart(sf) : node.pos;
    if (out.length < MAX_FINDINGS_PER_FILE) out.push({ kind, file, line: sf.getLineAndCharacterOfPosition(start).line + 1, detail });
  };
  const literal = (n: TsNode | undefined): string | null => (n && (n.kind === SK.StringLiteral || n.kind === SK.NoSubstitutionTemplateLiteral) ? String(n.text) : null);
  const urlPrefix = (n: TsNode | undefined): string | null => literal(n) ?? (n && n.kind === SK.TemplateExpression ? String(n.head.text) : null);
  const ident = (n: TsNode | undefined): string | null => (n && n.kind === SK.Identifier ? String(n.escapedText ?? n.text) : null);
  const isProcessEnv = (n: TsNode | undefined) => !!n && n.kind === SK.PropertyAccessExpression && ident(n.name) === 'env' && ident(n.expression) === 'process';
  const calleeName = (n: TsNode): string | null => ident(n) ?? (n.kind === SK.PropertyAccessExpression ? ident(n.name) : null);
  const touchesHome = (n: TsNode): boolean => {
    let hit = false;
    const visit = (x: TsNode) => {
      if (hit) return;
      if (x.kind === SK.CallExpression && calleeName(x.expression) === 'homedir') hit = true;
      else if (x.kind === SK.PropertyAccessExpression && isProcessEnv(x.expression) && /^(HOME|USERPROFILE|APPDATA|XDG_CONFIG_HOME)$/.test(ident(x.name) ?? '')) hit = true;
      else if (literal(x)?.startsWith('~/')) hit = true;
      else ts.forEachChild(x, visit);
    };
    visit(n);
    return hit;
  };
  const moduleRef = (node: TsNode, spec: string) => { const c = moduleCategory(spec); if (c) add('module_import', node, `${c}:${moduleName(spec)}`); };

  const visit = (n: TsNode): void => {
    const lit = literal(n);
    if (lit) for (const u of lit.match(URL_RE) ?? []) { const h = hostOf(u); if (h) hosts.add(h); }
    if (n.kind === SK.TemplateExpression) for (const u of String(n.head.text).match(URL_RE) ?? []) { const h = hostOf(u); if (h) hosts.add(h); }

    if ((n.kind === SK.ImportDeclaration || n.kind === SK.ExportDeclaration) && literal(n.moduleSpecifier)) moduleRef(n, literal(n.moduleSpecifier)!);
    else if (n.kind === SK.CallExpression) {
      const callee = n.expression as TsNode;
      const arg0 = n.arguments?.[0] as TsNode | undefined;
      const name = ident(callee);
      if (callee.kind === SK.ImportKeyword) {
        const spec = literal(arg0);
        if (spec) moduleRef(n, spec); else add('dynamic_import', n, 'import(<expression>)');
      } else if (name === 'require') {
        const spec = literal(arg0);
        if (spec) moduleRef(n, spec); else if (arg0) add('dynamic_require', n, 'require(<expression>)');
      } else if (name === 'eval') add('eval', n, 'eval(...)');
      else if (name === 'Function') add('new_function', n, 'Function(...)');
      else if (name === 'fetch' || (callee.kind === SK.PropertyAccessExpression && ident(callee.name) === 'fetch')) {
        const u = urlPrefix(arg0); if (u && /^(?:https?|wss?):\/\//.test(u)) add('endpoint', n, `fetch ${u}`);
      }
      const cn = calleeName(callee);
      if (cn && FS_WRITES.has(cn) && arg0 && touchesHome(arg0)) add('home_write', n, cn);
    } else if (n.kind === SK.NewExpression) {
      const name = ident(n.expression);
      if (name === 'Function') add('new_function', n, 'new Function(...)');
      else if (name === 'WebSocket' || name === 'EventSource') {
        const u = urlPrefix(n.arguments?.[0]); if (u) add('endpoint', n, `${name} ${u}`);
      }
    } else if (n.kind === SK.PropertyAccessExpression && isProcessEnv(n.expression)) {
      const v = ident(n.name); if (v && TOKEN_ENV.test(v)) add('env_token_read', n, v);
    } else if (n.kind === SK.ElementAccessExpression && isProcessEnv(n.expression)) {
      const v = literal(n.argumentExpression); if (v && TOKEN_ENV.test(v)) add('env_token_read', n, v);
    } else if (n.kind === SK.VariableDeclaration && isProcessEnv(n.initializer) && n.name?.kind === SK.ObjectBindingPattern) {
      for (const el of n.name.elements as TsNode[]) {
        const v = ident(el.propertyName) ?? literal(el.propertyName) ?? ident(el.name);
        if (v && TOKEN_ENV.test(v)) add('env_token_read', el, v);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const posix = (p: string) => p.split(path.sep).join('/');
const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

function lifecycleOf(pkg: Record<string, unknown>): Array<{ script: string; command: string }> {
  const scripts = (pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}) as Record<string, unknown>;
  return LIFECYCLE_SCRIPTS.filter((s) => typeof scripts[s] === 'string').map((s) => ({ script: s, command: String(scripts[s]) }));
}
function readJson(abs: string): Record<string, unknown> | null {
  try { const v = JSON.parse(readFileSync(abs, 'utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/**
 * Scans an installed npm package directory (or any runtime install dir) without executing anything in it. Deterministic:
 * sorted walk, sorted output, no timestamps or absolute paths in the body; report_hash = sha256(canonical body).
 */
export async function scanPackage(dir: string, opts: ScanOptions = {}): Promise<ShippedCodeReport> {
  const o = { ...SCAN_DEFAULTS, ...opts };
  const ts = opts.parser === undefined ? loadTsParser() : opts.parser;
  const root = path.resolve(dir);
  const st = lstatSync(root);
  if (st.isSymbolicLink()) throw new Error(`${dir}: is a symlink (not followed)`);
  if (!st.isDirectory()) throw new Error(`${dir}: not a directory`);
  const deadline = Date.now() + o.deadlineMs;
  const pkg = readJson(path.join(root, 'package.json')) ?? {};
  const truncated = new Set<string>();
  if (!ts) truncated.add('js_parser_unavailable');

  // bins declared by the package (string = one bin named after the package)
  const binDecl = typeof pkg.bin === 'string' ? { [String(pkg.name ?? '').split('/').pop() || 'bin']: pkg.bin } : (pkg.bin && typeof pkg.bin === 'object' ? pkg.bin as Record<string, unknown> : {});
  const bin = Object.entries(binDecl).filter(([, p]) => typeof p === 'string').map(([name, p]) => ({ name, path: path.posix.normalize(String(p)).replace(/^\.\//, '') })).sort((a, b) => cmp(a.name, b.name));
  const binPaths = new Set(bin.map((b) => b.path));

  const files: ShippedCodeReport['files'] = [];
  const symlinks: ShippedCodeReport['symlinks'] = [];
  const binaries: ShippedCodeReport['binaries'] = [];
  const nested: ShippedCodeReport['nested_lifecycle'] = [];
  const skipped: ShippedCodeReport['js']['skipped'] = [];
  const findings: Finding[] = [];
  const hosts = new Set<string>();
  let parsed = 0;
  let seen = 0;

  const stack: string[] = [''];
  walk: while (stack.length) {
    const rel = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(path.join(root, rel)).sort(cmp); } catch { truncated.add('unreadable_dir'); continue; }
    const subdirs: string[] = [];
    for (const name of entries) {
      const r = rel ? `${rel}/${name}` : name;
      const abs = path.join(root, r);
      let s;
      try { s = lstatSync(abs); } catch { truncated.add('unreadable_entry'); continue; }
      if (s.isSymbolicLink()) { let target = ''; try { target = posix(readlinkSync(abs)); } catch { /* unreadable */ } symlinks.push({ path: r, target }); continue; }
      if (s.isDirectory()) { subdirs.push(r); continue; }
      if (!s.isFile()) continue;
      if (seen >= o.maxFiles) { truncated.add('max_files'); break walk; }
      if (Date.now() > deadline) { truncated.add('deadline'); break walk; }
      seen++;
      if (seen % 50 === 0) await yieldNow();
      let hashed: { sha256: string | null; head: Buffer };
      try { hashed = hashFile(abs, s.size, o.maxHashBytes); } catch { truncated.add('unreadable_entry'); continue; }
      if (!hashed.sha256) truncated.add('max_hash_bytes');
      files.push({ path: r, size: s.size, sha256: hashed.sha256 });
      const fmt = binaryFormat(hashed.head);
      if (fmt) { binaries.push({ path: r, format: fmt, size: s.size, sha256: hashed.sha256 }); continue; }
      if (name === 'package.json' && rel && /(^|\/)node_modules\/(@[^/]+\/)?[^/]+$/.test(rel)) {
        const p = readJson(abs);
        if (p) for (const l of lifecycleOf(p)) nested.push({ package: `${String(p.name ?? '?')}@${String(p.version ?? '?')}`, path: rel, ...l });
      }
      const shebangNode = !JS_EXT.test(name) && (binPaths.has(r) || !name.includes('.')) && hashed.head.subarray(0, 2).toString() === '#!';
      if (!JS_EXT.test(name) && !shebangNode) continue;
      if (!ts) continue;
      if (s.size > o.maxParseBytes) { skipped.push({ path: r, reason: 'too_large' }); continue; }
      const text = readFileSync(abs, 'utf8');
      if (shebangNode && !/^#![^\n]*\bnode\b/.test(text)) continue;
      try { findings.push(...analyzeJs(ts, r, text, hosts)); parsed++; } catch { skipped.push({ path: r, reason: 'parse_error' }); }
    }
    // reverse so the sorted-first subdirectory is popped first (deterministic, depth-first, sorted)
    for (const d of subdirs.reverse()) stack.push(d);
  }

  const byPath = <T extends { path: string }>(a: T, b: T) => cmp(a.path, b.path);
  findings.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.kind, b.kind) || cmp(a.detail, b.detail));
  const body: Omit<ShippedCodeReport, 'report_hash'> = {
    schema: 'shipped-code-scan/v1',
    package: { name: typeof pkg.name === 'string' ? pkg.name : null, version: typeof pkg.version === 'string' ? pkg.version : null },
    parser: ts ? { name: 'typescript', version: ts.version } : null,
    limits: { max_parse_bytes: o.maxParseBytes, max_files: o.maxFiles, max_hash_bytes: o.maxHashBytes },
    lifecycle: lifecycleOf(pkg),
    nested_lifecycle: nested.sort((a, b) => cmp(a.path, b.path) || cmp(a.script, b.script)),
    bin,
    files: files.sort(byPath),
    symlinks: symlinks.sort(byPath),
    binaries: binaries.sort(byPath),
    js: { parsed, skipped: skipped.sort(byPath) },
    findings,
    hosts: [...hosts].sort(cmp),
    truncated: [...truncated].sort(cmp),
  };
  return { ...body, report_hash: reportHash(body) };
}

// ─── Diff ───────────────────────────────────────────────────────────────────────────────────────────────────────────
type SetDelta = { added: string[]; removed: string[] };
export interface ShippedCodeDiff {
  changed: boolean;
  from: { version: string | null; report_hash: string } | null;
  to: { version: string | null; report_hash: string };
  lifecycle: SetDelta; network_modules: SetDelta; endpoints: SetDelta; dynamic_code: SetDelta; binaries: SetDelta; bin: SetDelta;
  env_token_reads: SetDelta; home_writes: SetDelta; files: { added: number; removed: number; changed: number };
}
const DYNAMIC: FindingKind[] = ['eval', 'new_function', 'dynamic_require', 'dynamic_import'];
function facets(r: ShippedCodeReport | null) {
  const f = r?.findings ?? [];
  return {
    lifecycle: [...(r?.lifecycle ?? []).map((l) => `${l.script}: ${l.command}`), ...(r?.nested_lifecycle ?? []).map((l) => `${l.package} ${l.script}: ${l.command}`)],
    network_modules: f.filter((x) => x.kind === 'module_import').map((x) => x.detail),
    endpoints: [...(r?.hosts ?? []), ...f.filter((x) => x.kind === 'endpoint').map((x) => x.detail)],
    dynamic_code: f.filter((x) => DYNAMIC.includes(x.kind)).map((x) => `${x.kind} ${x.file}`),
    binaries: (r?.binaries ?? []).map((b) => `${b.path}#${(b.sha256 ?? 'unhashed').slice(0, 12)}`),
    bin: (r?.bin ?? []).map((b) => `${b.name} -> ${b.path}`),
    env_token_reads: f.filter((x) => x.kind === 'env_token_read').map((x) => x.detail),
    home_writes: f.filter((x) => x.kind === 'home_write').map((x) => x.file),
  };
}
const delta = (a: string[], b: string[]): SetDelta => {
  const A = new Set(a); const B = new Set(b);
  return { added: [...B].filter((x) => !A.has(x)).sort(cmp), removed: [...A].filter((x) => !B.has(x)).sort(cmp) };
};

/** Release-to-release delta of what the package ships (prev = null: everything is new). */
export function diffReports(prev: ShippedCodeReport | null, next: ShippedCodeReport): ShippedCodeDiff {
  const a = facets(prev); const b = facets(next);
  const pf = new Map((prev?.files ?? []).map((f) => [f.path, f.sha256]));
  const nf = new Map(next.files.map((f) => [f.path, f.sha256]));
  return {
    changed: prev?.report_hash !== next.report_hash,
    from: prev ? { version: prev.package.version, report_hash: prev.report_hash } : null,
    to: { version: next.package.version, report_hash: next.report_hash },
    lifecycle: delta(a.lifecycle, b.lifecycle), network_modules: delta(a.network_modules, b.network_modules), endpoints: delta(a.endpoints, b.endpoints),
    dynamic_code: delta(a.dynamic_code, b.dynamic_code), binaries: delta(a.binaries, b.binaries), bin: delta(a.bin, b.bin),
    env_token_reads: delta(a.env_token_reads, b.env_token_reads), home_writes: delta(a.home_writes, b.home_writes),
    files: { added: [...nf.keys()].filter((k) => !pf.has(k)).length, removed: [...pf.keys()].filter((k) => !nf.has(k)).length, changed: [...nf].filter(([k, h]) => pf.has(k) && pf.get(k) !== h).length },
  };
}

export function reportSummary(r: ShippedCodeReport) {
  const by_kind: Record<string, number> = {};
  for (const f of r.findings) by_kind[f.kind] = (by_kind[f.kind] ?? 0) + 1;
  return { files: r.files.length, js_parsed: r.js.parsed, js_skipped: r.js.skipped.length, lifecycle_scripts: r.lifecycle.length, nested_lifecycle_scripts: r.nested_lifecycle.length,
    bins: r.bin.length, binaries: r.binaries.length, symlinks: r.symlinks.length, hosts: r.hosts.length, findings_by_kind: by_kind, parser: r.parser?.version ?? null, truncated: r.truncated };
}
export const evidenceRef = (r: ShippedCodeReport) => `shipped-code-scan:${r.package.name ?? '?'}@${r.package.version ?? '?'}#${r.report_hash.slice(0, 12)}`;

// ─── Storage, shadow consumer, trigger ──────────────────────────────────────────────────────────────────────────────
export interface ScanTarget { runtime_id: string; path: string }
export interface ScanRunResult { runtime_id: string; path: string; package: string | null; version: string | null; report_hash: string | null; stored: boolean; error: string | null }

export const shippedCodeScanMode = (env: NodeJS.ProcessEnv = process.env): 'off' | 'shadow' => (env.SHIPPED_CODE_SCAN_MODE === 'shadow' ? 'shadow' : 'off');

/** The runtimes the prod Dockerfile installs: `npm install --global` lands under <prefix>/lib/node_modules; atomic is a tarball in /opt. */
export function defaultScanTargets(execPath = process.execPath): ScanTarget[] {
  const globalRoot = path.posix.join(path.posix.dirname(path.posix.dirname(posix(execPath))), 'lib', 'node_modules');
  return [
    { runtime_id: 'claude', path: `${globalRoot}/@anthropic-ai/claude-code` },
    { runtime_id: 'codex', path: `${globalRoot}/@openai/codex` },
    { runtime_id: 'opencode', path: `${globalRoot}/opencode-ai` },
    { runtime_id: 'atomic', path: '/opt/atomic-agent' },
  ];
}

const packageKey = (t: ScanTarget, r: ShippedCodeReport) => r.package.name ?? `${t.runtime_id}:${path.basename(t.path)}`;

/**
 * Scans each target, stores a row when the content hash is new for that package (with the diff against the previous row),
 * and records a shadow `shipped_code_scan` judgment carrying the evidence_refs candidate. Never changes an admission.
 */
export async function runShippedCodeScan(db: Database, targets: ScanTarget[], now = Date.now(), opts: ScanOptions = {}): Promise<ScanRunResult[]> {
  const results: ScanRunResult[] = [];
  for (const t of targets) {
    try {
      const report = await scanPackage(t.path, opts);
      const key = packageKey(t, report);
      const prevRow = db.prepare('SELECT report_json FROM shipped_code_scans WHERE package = ? ORDER BY id DESC LIMIT 1').get(key) as { report_json: string } | undefined;
      const prev = prevRow ? JSON.parse(prevRow.report_json) as ShippedCodeReport : null;
      const base = { runtime_id: t.runtime_id, path: t.path, package: report.package.name, version: report.package.version, report_hash: report.report_hash, error: null };
      if (prev?.report_hash === report.report_hash) { results.push({ ...base, stored: false }); continue; }
      const diff = diffReports(prev, report);
      const summary = reportSummary(report);
      const at = new Date(now).toISOString();
      const admission = checkAdmission(t.runtime_id, report.package.version, now);
      db.transaction(() => {
        db.prepare(`INSERT INTO shipped_code_scans (package, version, runtime_id, scanned_path, report_hash, prev_report_hash, report_json, diff_json, summary_json, scanned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, report.package.version, t.runtime_id, t.path, report.report_hash, prev?.report_hash ?? null,
          JSON.stringify(report), JSON.stringify(diff), JSON.stringify(summary), at);
        const reason = `${key}@${report.package.version ?? '?'}: ${summary.files} files, ${summary.lifecycle_scripts} lifecycle, ${summary.binaries} binaries, ${summary.hosts} hosts`
          + (prev ? `; delta lifecycle +${diff.lifecycle.added.length} endpoints +${diff.endpoints.added.length} dynamic +${diff.dynamic_code.added.length} binaries +${diff.binaries.added.length}` : '; first scan');
        db.prepare(`INSERT INTO judgments (id, judgment, subject_type, subject_id, state_hash, mode, decision, reason, answers_json, created_at)
          VALUES (?, 'shipped_code_scan', 'runtime_admission', ?, ?, 'shadow', ?, ?, ?, ?)`)
          .run(`scs-${report.report_hash.slice(0, 16)}-${t.runtime_id}-${now}`, t.runtime_id, report.report_hash, prev ? 'changed' : 'first_seen', reason,
            JSON.stringify({ evidence_ref_candidate: evidenceRef(report), gate: 'supply_chain', summary, diff, admission: { decision: admission.decision, ref: admission.ref, allowed: admission.allowed } }), at);
      })();
      results.push({ ...base, stored: true });
    } catch (e) {
      results.push({ runtime_id: t.runtime_id, path: t.path, package: null, version: null, report_hash: null, stored: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  }
  return results;
}

/** GET /api/health/shipped-code: latest scan per package, its summary and its diff against the previous scan. */
export function shippedCodeView(db: Database, env: NodeJS.ProcessEnv = process.env) {
  type Row = { package: string; version: string | null; runtime_id: string; scanned_path: string; report_hash: string; prev_report_hash: string | null; diff_json: string; summary_json: string; scanned_at: string; scans: number };
  let rows: Row[] = [];
  try {
    rows = db.prepare(`SELECT s.package, s.version, s.runtime_id, s.scanned_path, s.report_hash, s.prev_report_hash, s.diff_json, s.summary_json, s.scanned_at,
        (SELECT COUNT(*) FROM shipped_code_scans c WHERE c.package = s.package) AS scans
      FROM shipped_code_scans s WHERE s.id = (SELECT MAX(id) FROM shipped_code_scans m WHERE m.package = s.package) ORDER BY s.package`).all() as Row[];
  } catch { /* table absent on an unmigrated db */ }
  return {
    mode: shippedCodeScanMode(env),
    parser: loadTsParser()?.version ?? null,
    packages: rows.map(({ diff_json, summary_json, ...r }) => ({ ...r, summary: JSON.parse(summary_json), diff: JSON.parse(diff_json) as ShippedCodeDiff })),
    note: 'shadow only: reports are evidence candidates for the runtime-admission supply_chain gate; no admission decision reads them. Scanned code is parsed, never executed.',
  };
}

export const SHIPPED_CODE_SCAN_INTERVAL_MS = 86_400_000;

/** Daily scan of the runtime packages when SHIPPED_CODE_SCAN_MODE=shadow (first run 15 min after boot). */
export function startShippedCodeScan(db: Database, env: NodeJS.ProcessEnv = process.env, targets: ScanTarget[] = defaultScanTargets()): (() => void) | null {
  if (shippedCodeScanMode(env) === 'off') return null;
  let running = false;
  const tick = () => {
    if (running) return; running = true;
    runShippedCodeScan(db, targets).then((r) => {
      markRun('shipped_code_scan');
      const changed = r.filter((x) => x.stored).map((x) => `${x.package}@${x.version}`);
      if (changed.length) console.log(`🔎 shipped-code scan (shadow): new reports for ${changed.join(', ')}`);
    }).catch((e) => { markRun('shipped_code_scan', e); console.warn('shipped-code scan failed:', e instanceof Error ? e.message : String(e)); })
      .finally(() => { running = false; });
  };
  const first = setTimeout(tick, 15 * 60_000); first.unref?.();
  const timer = setInterval(tick, SHIPPED_CODE_SCAN_INTERVAL_MS); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
