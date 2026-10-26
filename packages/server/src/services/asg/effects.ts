import fs from 'fs';
import path from 'path';
import { matchesAny, SAFE_PATH, sha256, type FailureClass } from './contract';

/** A failure with its taxonomy class. Thrown by the capability gate, procedures and fault injection. */
export class AsgError extends Error {
  constructor(public readonly cls: FailureClass, message: string, public readonly crash = false) { super(message); this.name = 'AsgError'; }
}

const SENSITIVE = /(^|\/)(\.git|node_modules|\.env[^/]*|\.npmrc|\.ssh|secrets?)(\/|$)|\.(pem|key)$/i;

/** Workspace-relative posix path that may be touched at all (no traversal, no VCS/deps/secrets). */
export function safeWorkspacePath(p: unknown): p is string {
  return typeof p === 'string' && SAFE_PATH.test(p) && !p.split('/').includes('..') && !SENSITIVE.test(p);
}

/** A workspace rooted at one directory (a maker worktree or a harness fixture copy). Paths are always workspace-relative. */
export class FsWorkspace {
  constructor(public readonly root: string) {}
  private abs(p: string): string {
    if (!safeWorkspacePath(p)) throw new AsgError('policy_refusal', `path refused: ${String(p).slice(0, 80)}`);
    const a = path.resolve(this.root, p);
    if (!a.startsWith(path.resolve(this.root) + path.sep)) throw new AsgError('policy_refusal', 'path escapes the workspace');
    return a;
  }
  exists(p: string): boolean { return fs.existsSync(this.abs(p)); }
  read(p: string): string | null { const a = this.abs(p); return fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null; }
  write(p: string, content: string): void { const a = this.abs(p); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, content); }
  remove(p: string): void { const a = this.abs(p); if (fs.existsSync(a)) fs.unlinkSync(a); }
  list(): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.name === '.git' || e.name === 'node_modules') continue;
        if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (e.isFile()) out.push(r);
      }
    };
    if (fs.existsSync(this.root)) walk(this.root, '');
    return out.sort();
  }
}

export type Snapshot = Record<string, string>; // path → sha256
export const digestOf = (content: string | null): string | null => (content === null ? null : sha256(content));

export function snapshot(ws: FsWorkspace, paths?: string[]): Snapshot {
  const out: Snapshot = {};
  for (const p of paths ?? ws.list()) { const c = ws.read(p); if (c !== null) out[p] = sha256(c); }
  return out;
}

export interface ObservedEffects { created: string[]; modified: string[]; deleted: string[] }
export function diffSnapshots(before: Snapshot, after: Snapshot): ObservedEffects {
  const created: string[] = []; const modified: string[] = []; const deleted: string[] = [];
  for (const [p, d] of Object.entries(after)) { if (!(p in before)) created.push(p); else if (before[p] !== d) modified.push(p); }
  for (const p of Object.keys(before)) if (!(p in after)) deleted.push(p);
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}
export const changedPaths = (e: ObservedEffects): string[] => [...e.created, ...e.modified, ...e.deleted].sort();
export function outOfScope(e: ObservedEffects, allowedWrite: string[]): string[] {
  return changedPaths(e).filter((p) => !matchesAny(p, allowedWrite));
}

/**
 * The capability boundary at dispatch: every write (macro procedure or micro action) passes through it. The allowed set is
 * fixed when the gate is made (task capability ∩ contract effects for a macro, task capability for micro) and cannot grow.
 */
export class CapabilityGate {
  readonly writes: { path: string; allowed: boolean }[] = [];
  constructor(private readonly allowed: readonly string[], private readonly onWrite?: (p: string) => void) {}
  checkWrite(p: string): void {
    const ok = safeWorkspacePath(p) && matchesAny(p, [...this.allowed]);
    this.writes.push({ path: p, allowed: ok });
    if (!ok) throw new AsgError('permission_invalid', `write outside the capability boundary: ${String(p).slice(0, 80)}`);
    this.onWrite?.(p);
  }
}

/** One recovery at a time per workspace: an exclusive lock file outside the workspace (so it is never an effect). */
export class WorkspaceLock {
  private readonly file: string;
  constructor(lockDir: string, root: string) { fs.mkdirSync(lockDir, { recursive: true }); this.file = path.join(lockDir, `${sha256(path.resolve(root)).slice(0, 16)}.lock`); }
  acquire(attemptId: string): boolean {
    try { fs.writeFileSync(this.file, attemptId, { flag: 'wx' }); return true; } catch { return this.holder() === attemptId; }
  }
  holder(): string | null { try { return fs.readFileSync(this.file, 'utf8'); } catch { return null; } }
  release(attemptId: string): void { if (this.holder() === attemptId) fs.rmSync(this.file, { force: true }); }
}

export interface ActionRecord {
  key: string; attempt_id: string; action_id: string; skill: string; state: 'started' | 'completed' | 'reconciled';
  pre: Record<string, string | null>; expected_post?: Record<string, string | null>; observed_post?: Record<string, string | null>;
  output?: Record<string, unknown> | null; failure?: FailureClass | null; at: string;
}

/** Write-ahead action ledger, persisted outside the workspace: survives a crash/restart and dedupes a duplicate delivery. */
export class AttemptStore {
  constructor(private readonly file: string | null) { if (file) fs.mkdirSync(path.dirname(file), { recursive: true }); }
  private mem = new Map<string, ActionRecord>();
  private load(): Map<string, ActionRecord> {
    if (!this.file || !fs.existsSync(this.file)) return this.mem;
    try { this.mem = new Map(Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, ActionRecord>)); } catch { /* corrupt ledger = empty */ }
    return this.mem;
  }
  get(key: string): ActionRecord | undefined { return this.load().get(key); }
  put(r: ActionRecord): void {
    const m = this.load(); m.set(r.key, r);
    if (this.file) { const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m))); fs.renameSync(tmp, this.file); }
  }
  all(): ActionRecord[] { return [...this.load().values()]; }
}

export const idempotencyKey = (skill: string, version: number, fields: Record<string, unknown>, keyFields: string[], base: Record<string, string | null>): string =>
  sha256(JSON.stringify({ skill, version, fields: keyFields.map((k) => [k, fields[k] ?? null]), base: Object.keys(base).sort().map((k) => [k, base[k]]) })).slice(0, 32);
