import { execFile } from 'child_process';
import path from 'path';
import { resolveDbPath } from '../../database/path';

/**
 * MAKER_UID_SEPARATION (S0 step 1, default off). In-container maker CLIs run as the server uid, so a maker process can
 * open the control-plane DB for write and read the server's environment. This module measures that per maker lease and,
 * in `on`, refuses to start a maker whose process context is not separated.
 *
 *   off    — nothing runs; spawn args and behaviour are unchanged.
 *   shadow — one probe per in-container maker lease, spawned exactly like the maker (same cwd, same allowlisted env, same
 *            parent), records uid/gid and what that context can reach in lease metadata `uid_separation`. Never refuses.
 *   on     — the same probe; a maker is started only when the probe proves the context cannot write the DB (or its
 *            directory) and cannot read the server's environ. Fail closed: a probe error or an unknown answer refuses.
 *            Run-as-maker (uid 1002 via a fixed-target helper) is the follow-up that makes the probe pass; until it ships,
 *            `on` refuses every in-container maker (docs/design/maker-uid-separation.md).
 */
export type MakerUidSeparationMode = 'off' | 'shadow' | 'on';

export function makerUidSeparationMode(env: NodeJS.ProcessEnv = process.env): MakerUidSeparationMode {
  const v = env.MAKER_UID_SEPARATION;
  return v === 'shadow' || v === 'on' ? v : 'off';
}

/** Reserved in the image (Dockerfile `maker` user); the uid the follow-up runs maker CLIs as. */
export const MAKER_UID = 1002;

/**
 * POSIX sh, no dependencies (coreutils `head`/`dirname`/`id`). `$1` = DB path. `na` = /proc not present (e.g. macOS dev),
 * recorded as unknown, never as "not readable". scripts/maker-uid-probe.sh runs this same text on a real image.
 */
export const PROBE_SCRIPT = 'db="$1"; e1=na; ep=na; [ -e /proc/1/environ ] && { e1=0; head -c 1 /proc/1/environ >/dev/null 2>&1 && e1=1; }; [ -e "/proc/$PPID/environ" ] && { ep=0; head -c 1 "/proc/$PPID/environ" >/dev/null 2>&1 && ep=1; }; dx=0; [ -e "$db" ] && dx=1; dw=0; [ -w "$db" ] && dw=1; dr=0; [ -r "$db" ] && dr=1; dd=0; [ -w "$(dirname "$db")" ] && dd=1; echo "uid=$(id -u) gid=$(id -g) db_exists=$dx db_writable=$dw db_readable=$dr db_dir_writable=$dd proc1_environ_readable=$e1 parent_environ_readable=$ep"';

export const PROBE_TIMEOUT_MS = 5_000;

/** The probe's argv: `/bin/sh -c PROBE_SCRIPT probe <db>`. The DB path is an argument, never interpolated into the script. */
export function buildProbeCommand(dbPath: string): { command: string; args: string[] } {
  return { command: '/bin/sh', args: ['-c', PROBE_SCRIPT, 'probe', dbPath] };
}

export interface UidSeparationProbe {
  mode: MakerUidSeparationMode;
  probed_at: string;
  db_path: string;
  uid: number | null;
  gid: number | null;
  db_exists: boolean | null;
  db_writable: boolean | null;
  db_readable: boolean | null;
  db_dir_writable: boolean | null;
  /** null = /proc not available in this context (unknown, not "safe") */
  proc1_environ_readable: boolean | null;
  parent_environ_readable: boolean | null;
  /** true only when every exposure is known and closed; null when any answer is unknown */
  separated: boolean | null;
  probe_error?: string;
}

const bit = (v: string | undefined): boolean | null => (v === '1' ? true : v === '0' ? false : null);
const num = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);

/** Parses the probe's one line; a missing or malformed field stays null. */
export function parseProbeOutput(stdout: string): Omit<UidSeparationProbe, 'mode' | 'probed_at' | 'db_path' | 'probe_error'> {
  const f = Object.fromEntries(stdout.trim().split(/\s+/).map((kv) => kv.split('=', 2) as [string, string]));
  const r = {
    uid: num(f.uid), gid: num(f.gid), db_exists: bit(f.db_exists), db_writable: bit(f.db_writable), db_readable: bit(f.db_readable),
    db_dir_writable: bit(f.db_dir_writable), proc1_environ_readable: bit(f.proc1_environ_readable), parent_environ_readable: bit(f.parent_environ_readable),
  };
  return { ...r, separated: separatedFrom(r) };
}

/** Separated = the DB and its directory are not writable and neither environ is readable; any unknown → null. */
function separatedFrom(r: { db_writable: boolean | null; db_dir_writable: boolean | null; proc1_environ_readable: boolean | null; parent_environ_readable: boolean | null }): boolean | null {
  const exposures = [r.db_writable, r.db_dir_writable, r.proc1_environ_readable, r.parent_environ_readable];
  if (exposures.some((v) => v === true)) return false;
  return exposures.every((v) => v === false) ? true : null;
}

export type ProbeRunner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => Promise<string>;

const execFileRunner: ProbeRunner = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { ...options, maxBuffer: 16 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

/** Runs the probe in the maker's context (cwd + env as the maker gets them). Never throws: an error is recorded. */
export async function probeMakerContext(input: { mode: MakerUidSeparationMode; cwd: string; env: NodeJS.ProcessEnv; dbPath?: string; run?: ProbeRunner }): Promise<UidSeparationProbe> {
  const dbPath = path.resolve(input.dbPath ?? resolveDbPath());
  const base = { mode: input.mode, probed_at: new Date().toISOString(), db_path: dbPath };
  const { command, args } = buildProbeCommand(dbPath);
  try {
    const stdout = await (input.run ?? execFileRunner)(command, args, { cwd: input.cwd, env: input.env, timeout: PROBE_TIMEOUT_MS });
    return { ...base, ...parseProbeOutput(stdout) };
  } catch (error) {
    return { ...base, ...parseProbeOutput(''), probe_error: String((error as Error)?.message ?? error).slice(0, 300) };
  }
}

/** `on` only: why this maker must not start, or null to start it. Fail closed on anything but a proven separation. */
export function uidSeparationRefusal(probe: UidSeparationProbe): string | null {
  if (probe.mode !== 'on' || probe.separated === true) return null;
  if (probe.probe_error) return 'maker_uid_separation_probe_failed';
  return probe.separated === false ? 'maker_uid_separation_not_separated' : 'maker_uid_separation_unknown';
}
