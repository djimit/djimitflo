import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';
import {
  MAKER_UID, PROBE_SCRIPT, buildProbeCommand, makerUidSeparationMode, parseProbeOutput, probeMakerContext, uidSeparationRefusal,
  type UidSeparationProbe,
} from '../execution/executors/maker-uid-separation';

/** MAKER_UID_SEPARATION (S0 step 1): off = nothing runs; shadow = per-lease probe recorded; on = refuse an unseparated maker. */
const roots: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const tmp = (prefix: string) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(r); return r; };

describe('mode and probe construction', () => {
  it('only shadow and on switch anything; unset or unknown is off', () => {
    expect(makerUidSeparationMode({})).toBe('off');
    expect(makerUidSeparationMode({ MAKER_UID_SEPARATION: 'true' })).toBe('off');
    expect(makerUidSeparationMode({ MAKER_UID_SEPARATION: 'ON' })).toBe('off');
    expect(makerUidSeparationMode({ MAKER_UID_SEPARATION: 'shadow' })).toBe('shadow');
    expect(makerUidSeparationMode({ MAKER_UID_SEPARATION: 'on' })).toBe('on');
    expect(MAKER_UID).toBe(1002);
  });

  it('the probe argv passes the DB path as an argument, never inside the script', () => {
    const odd = '/data/x"; touch /tmp/pwn; echo "';
    const { command, args } = buildProbeCommand(odd);
    expect(command).toBe('/bin/sh');
    expect(args).toEqual(['-c', PROBE_SCRIPT, 'probe', odd]);
    expect(PROBE_SCRIPT).not.toContain('/data');
  });

  it('scripts/maker-uid-probe.sh runs the same probe text as the server', () => {
    const sh = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/maker-uid-probe.sh'), 'utf8');
    const block = sh.split('# PROBE_SCRIPT_BEGIN\n')[1]?.split('\n# PROBE_SCRIPT_END')[0];
    expect(block).toBe(`PROBE='${PROBE_SCRIPT}'`);
  });

  it('the Dockerfile reserves uid/gid 1002 maker outside the djimitflo group and keeps USER djimitflo', () => {
    const df = fs.readFileSync(path.resolve(__dirname, '../../../../Dockerfile'), 'utf8');
    expect(df).toContain('groupadd -g 1002 maker');
    expect(df).toContain('useradd -u 1002 -g maker -M -d /nonexistent -s /usr/sbin/nologin maker');
    expect(df).not.toMatch(/usermod[^\n]*maker|-G[^\n]*djimitflo[^\n]*maker/);
    expect(df.trim().split('\n').filter((l) => l.startsWith('USER '))).toEqual(['USER djimitflo']);
  });
});

describe('parseProbeOutput', () => {
  it('any exposure → separated false', () => {
    expect(parseProbeOutput('uid=1001 gid=1001 db_exists=1 db_writable=1 db_readable=1 db_dir_writable=1 proc1_environ_readable=1 parent_environ_readable=1\n'))
      .toEqual({ uid: 1001, gid: 1001, db_exists: true, db_writable: true, db_readable: true, db_dir_writable: true, proc1_environ_readable: true, parent_environ_readable: true, separated: false });
  });
  it('every exposure known and closed → separated true', () => {
    const r = parseProbeOutput('uid=1002 gid=1002 db_exists=1 db_writable=0 db_readable=0 db_dir_writable=0 proc1_environ_readable=0 parent_environ_readable=0');
    expect(r.separated).toBe(true);
    expect(r.uid).toBe(1002);
  });
  it('no /proc (na) is unknown, never "not readable"', () => {
    const r = parseProbeOutput('uid=501 gid=20 db_exists=1 db_writable=0 db_readable=0 db_dir_writable=0 proc1_environ_readable=na parent_environ_readable=na');
    expect(r.proc1_environ_readable).toBeNull();
    expect(r.separated).toBeNull();
  });
  it('empty or malformed output → all null', () => {
    expect(parseProbeOutput('garbage')).toMatchObject({ uid: null, db_writable: null, separated: null });
  });
});

describe('uidSeparationRefusal (fail closed in on, never in shadow)', () => {
  const p = (over: Partial<UidSeparationProbe>): UidSeparationProbe => ({ mode: 'on', probed_at: 't', db_path: '/d', uid: 1, gid: 1, db_exists: true, db_writable: false,
    db_readable: false, db_dir_writable: false, proc1_environ_readable: false, parent_environ_readable: false, separated: true, ...over });
  it('shadow never refuses', () => {
    expect(uidSeparationRefusal(p({ mode: 'shadow', separated: false, db_writable: true }))).toBeNull();
    expect(uidSeparationRefusal(p({ mode: 'shadow', separated: null, probe_error: 'x' }))).toBeNull();
  });
  it('on: proven separation starts; anything else refuses', () => {
    expect(uidSeparationRefusal(p({}))).toBeNull();
    expect(uidSeparationRefusal(p({ separated: false, db_writable: true }))).toBe('maker_uid_separation_not_separated');
    expect(uidSeparationRefusal(p({ separated: null }))).toBe('maker_uid_separation_unknown');
    expect(uidSeparationRefusal(p({ separated: null, probe_error: 'spawn ENOENT' }))).toBe('maker_uid_separation_probe_failed');
  });
});

describe.skipIf(process.platform === 'win32')('probeMakerContext (real /bin/sh)', () => {
  it('as the test user, a DB it owns is writable: not separated', async () => {
    const root = tmp('djimitflo-mus-');
    const db = path.join(root, 'djimitflo.sqlite'); fs.writeFileSync(db, '', { mode: 0o600 });
    const probe = await probeMakerContext({ mode: 'shadow', cwd: root, env: { PATH: process.env.PATH }, dbPath: db });
    expect(probe.probe_error).toBeUndefined();
    expect(probe).toMatchObject({ mode: 'shadow', db_path: db, uid: process.getuid!(), db_exists: true, db_writable: true, db_dir_writable: true, separated: false });
    // Linux has /proc: the server's own environ is readable by its uid; elsewhere unknown
    if (fs.existsSync('/proc/1/environ')) expect(probe.parent_environ_readable).toBe(true);
    else expect(probe.parent_environ_readable).toBeNull();
  });
  it('a probe that cannot run is recorded, never thrown', async () => {
    const probe = await probeMakerContext({ mode: 'on', cwd: '/', env: {}, dbPath: '/x', run: async () => { throw new Error('spawn /bin/sh ENOENT'); } });
    expect(probe).toMatchObject({ separated: null, probe_error: 'spawn /bin/sh ENOENT' });
    expect(uidSeparationRefusal(probe)).toBe('maker_uid_separation_probe_failed');
  });
});

async function runMaker(mode: 'off' | 'shadow' | 'on' | undefined) {
  const root = tmp('djimitflo-mus-run-');
  if (mode) vi.stubEnv('MAKER_UID_SEPARATION', mode);
  const dbFile = path.join(root, 'data', 'djimitflo.sqlite'); fs.mkdirSync(path.dirname(dbFile)); fs.writeFileSync(dbFile, '', { mode: 0o600 });
  vi.stubEnv('DB_PATH', dbFile);
  vi.stubEnv('LOOP_WORKTREE_ROOT', path.join(root, 'worktrees'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'Small documentation fixture\n');
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], { cwd: repo, stdio: 'ignore' });
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db); dbs.push(db);
  const loops = new LoopService(db, path.join(root, 'evidence'));
  db.prepare(`INSERT INTO loop_runs (id,loop_name,mode,status,repository_path,findings_json,metadata) VALUES ('mus-run','doc-drift-and-small-fix-loop','closed','running',?,?,?)`).run(repo,
    JSON.stringify([{ id: 'finding', type: 'todo_marker', severity: 'low', file: 'README.md', message: 'Improve wording', evidence: 'Small text', suggested_fix: 'Clarify wording' }]),
    JSON.stringify({ risk_class: 'low' }));
  const assignment = path.join(root, 'assignment.md'); fs.writeFileSync(assignment, 'Fixture assignment');
  loops.insertWorkerLease({ id: 'maker', loopRunId: 'mus-run', role: 'maker', runtime: 'opencode', findingId: 'finding', worktreePath: repo, branchName: null,
    now: new Date().toISOString(), metadata: { assignment_file: assignment } });
  vi.spyOn(loops, 'getRuntimeContract').mockReturnValue({ available: true, status: 'ok' } as ReturnType<LoopService['getRuntimeContract']>);
  const engine = vi.spyOn(loops.workerExecutor as unknown as { executeViaEngine: (...a: unknown[]) => Promise<unknown> }, 'executeViaEngine')
    .mockImplementation(async () => { fs.writeFileSync(path.join(repo, 'README.md'), 'Clearer documentation fixture\n'); return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '' }; });
  const outcome = await loops.executeMaker('mus-run', { lease_id: 'maker' }).then(() => 'ok', (e: Error) => e.message);
  // the spawn inputs handed to the engine (runtime, prompt, cwd, timeout, skip-permissions), with the temp root normalised
  const spawnInputs = engine.mock.calls.map((c) => JSON.stringify(c.slice(2)).split(root).join('<root>'));
  return { outcome, lease: loops.getWorkerLease('maker'), spawnInputs, events: db.prepare("SELECT event_type FROM loop_events WHERE loop_run_id = 'mus-run'").all() as { event_type: string }[], dbFile };
}

describe('runMaker hook', () => {
  it('off (unset): no probe, no metadata; shadow hands the engine byte-identical spawn inputs', async () => {
    const off = await runMaker(undefined);
    expect(off.outcome).toBe('ok');
    expect(off.lease.status).toBe('completed');
    expect(off.lease.metadata.uid_separation).toBeUndefined();
    const explicitOff = await runMaker('off');
    expect(explicitOff.lease.metadata.uid_separation).toBeUndefined();
    const shadow = await runMaker('shadow');
    expect(shadow.lease.status).toBe('completed');
    expect(off.spawnInputs).toHaveLength(1);
    expect(shadow.spawnInputs).toEqual(off.spawnInputs);
    expect(explicitOff.spawnInputs).toEqual(off.spawnInputs);
  });

  it('shadow: records the maker context (uid, DB writable) and never refuses', async () => {
    const r = await runMaker('shadow');
    expect(r.outcome).toBe('ok');
    expect(r.lease.metadata.uid_separation).toMatchObject({ mode: 'shadow', uid: process.getuid!(), db_path: r.dbFile, db_writable: true, separated: false, refused: false });
    expect(r.events.map((e) => e.event_type)).not.toContain('maker_uid_separation_refused');
  });

  it('on: an unseparated maker is not started — lease failed at prepare, engine never called', async () => {
    const r = await runMaker('on');
    expect(r.outcome).toBe('MAKER_UID_SEPARATION_REFUSED');
    expect(r.spawnInputs).toEqual([]);
    expect(r.lease.status).toBe('failed');
    expect(r.lease.metadata).toMatchObject({ failure_reason: 'maker_uid_separation_not_separated', failure: { stage: 'prepare' },
      uid_separation: { mode: 'on', db_writable: true, separated: false, refused: true } });
    expect(r.events.map((e) => e.event_type)).toContain('maker_uid_separation_refused');
  });
});
