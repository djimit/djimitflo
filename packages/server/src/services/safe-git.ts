/**
 * D3 (H4 security-boundaries audit, 2026-11-14): the one way the server runs git inside a maker or checker worktree.
 *
 * A maker controls its worktree, including its `.git` pointer file, so it can control the gitdir and the repo-local config
 * the server's git reads. Without this, a repo-local hook, `core.fsmonitor` or filter/diff driver ran as the server uid with
 * the server's full environment (GITHUB_TOKEN, JWT_SECRET, ...). Every call here:
 *
 * Neutralised with `-c` (command-line config beats every config file, and reaches child git processes such as a local
 * receive-pack through GIT_CONFIG_PARAMETERS):
 * - core.hooksPath=/dev/null  every hook: pre-commit, commit-msg, post-checkout, reference-transaction, pre-push, a local
 *                             receive-pack's pre-receive, ...
 * - core.fsmonitor=false      the fsmonitor command (status, diff, add, commit, checkout run it)
 * - core.untrackedCache=false the untracked cache is the fsmonitor's companion; it is never trusted from a maker repo
 * - credential.helper=        an empty value resets the helper list (URL-scoped `credential.<url>.helper` included)
 * - core.askPass=             no askpass program (GIT_ASKPASS / SSH_ASKPASS are not in the env either)
 * - core.editor / sequence.editor=false   no editor (every server call passes -m)
 * - commit/tag/push.gpgSign=false, log.showSignature=false   gpg.program / gpg.<format>.program never runs
 * - gc.auto=0, maintenance.auto=false     no background gc / maintenance spawned in a maker-controlled repository
 * - --no-pager                            core.pager / pager.<cmd> never run
 *
 * Transports: GIT_ALLOW_PROTOCOL is set on every call (it overrides protocol.* config of every scope). It is empty by
 * default, so a call cannot use any transport (no lazy fetch, no submodule clone, no `ext::`); a fetch/push names the
 * transports it needs (`protocols`). That also makes core.sshCommand, core.gitProxy and remote helpers (remote.<n>.vcs)
 * unreachable unless a caller allows ssh/git.
 *
 * Refused (SAFE_GIT_UNSAFE_CONFIG) when they appear in local or worktree scope, because `-c` cannot neutralise them (the
 * driver name is free, or an empty value makes the command fail instead of skipping the driver):
 * filter.<x>.clean|smudge|process, diff.<x>.command|textconv, diff.external, merge.<x>.driver,
 * remote.<x>.uploadpack|receivepack, core.alternateRefsCommand. Global config (the server's own HOME) stays trusted; the
 * system config is ignored (GIT_CONFIG_NOSYSTEM=1).
 *
 * Environment: only PATH, HOME, locale/TZ/TMPDIR and USER/LOGNAME of the server env reach git, plus what a call adds.
 * A secret (the push token) goes in through `secretConfig`: `--config-env` puts it in that one child's env, never in argv
 * (argv is world-readable in /proc).
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'child_process';

export const SAFE_GIT_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false',
  'credential.helper=', 'core.askPass=', 'core.editor=false', 'sequence.editor=false',
  'commit.gpgSign=false', 'tag.gpgSign=false', 'push.gpgSign=false', 'log.showSignature=false',
  'gc.auto=0', 'maintenance.auto=false',
];

/** Repo-local keys that make git execute a configured command and that `-c` cannot switch off. */
export const UNSAFE_REPO_CONFIG_KEY = /^(filter\..+\.(clean|smudge|process)|diff\..+\.(command|textconv)|diff\.external|merge\..+\.driver|remote\..+\.(uploadpack|receivepack)|core\.alternaterefscommand)$/i;

const PASS_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'USER', 'LOGNAME'];

export interface SafeGitOptions {
  input?: string | Buffer;
  timeout?: number;
  maxBuffer?: number;
  /** Extra trusted `-c name=value` entries (an identity, ...). */
  config?: string[];
  /** `name → value` config whose value must stay out of argv (a token header); passed with --config-env. */
  secretConfig?: Record<string, string>;
  /** Colon-separated transports this call may use (GIT_ALLOW_PROTOCOL), e.g. 'https'. Default: none. */
  protocols?: string;
}

/** The environment a server-side git child gets: no server secrets. */
export function safeGitEnv(extra: Record<string, string> = {}, protocols = ''): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASS_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: protocols, ...extra };
}

const baseArgs = (): string[] => ['--no-pager', ...SAFE_GIT_CONFIG.flatMap((c) => ['-c', c])];

/** The first local/worktree-scope key git would turn into a command (`scope:key`), else null. */
export function unsafeRepoConfig(cwd: string): string | null {
  const r = spawnSync('git', [...baseArgs(), '-C', cwd, 'config', '--list', '--show-scope', '-z'],
    { encoding: 'utf8', env: safeGitEnv(), timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  // not a repository / unreadable config: the real call fails on the same config read, so there is nothing to run
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const parts = r.stdout.split('\0'); // scope \0 key\nvalue \0 ...
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]; const key = parts[i + 1].split('\n')[0];
    if ((scope === 'local' || scope === 'worktree') && UNSAFE_REPO_CONFIG_KEY.test(key)) return `${scope}:${key}`;
  }
  return null;
}

function prepare(cwd: string, args: string[], opts: SafeGitOptions): { argv: string[]; env: NodeJS.ProcessEnv } {
  const unsafe = unsafeRepoConfig(cwd);
  if (unsafe) {
    const message = `SAFE_GIT_UNSAFE_CONFIG: ${unsafe} defines a command; refusing to run git in ${cwd}`;
    throw Object.assign(new Error(message), { stderr: message }); // callers that surface git's stderr surface this
  }
  const secretEnv: Record<string, string> = {};
  const secretArgs = Object.entries(opts.secretConfig ?? {}).flatMap(([name, value], i) => {
    secretEnv[`DJIMITFLO_GIT_SECRET_${i}`] = value;
    return [`--config-env=${name}=DJIMITFLO_GIT_SECRET_${i}`];
  });
  return {
    argv: [...baseArgs(), ...(opts.config ?? []).flatMap((c) => ['-c', c]), ...secretArgs, '-C', cwd, ...args],
    env: safeGitEnv(secretEnv, opts.protocols ?? ''),
  };
}

const stdio = (opts: SafeGitOptions) => [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] as ['ignore' | 'pipe', 'pipe', 'pipe'];

/** git in `cwd`, utf8 stdout (untrimmed). Throws execFileSync's error (status/stdout/stderr) or SAFE_GIT_UNSAFE_CONFIG. */
export function safeGit(cwd: string, args: string[], opts: SafeGitOptions = {}): string {
  const { argv, env } = prepare(cwd, args, opts);
  return execFileSync('git', argv, { encoding: 'utf8', env, input: opts.input, timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024, stdio: stdio(opts) });
}

/** safeGit with binary stdout. */
export function safeGitBuffer(cwd: string, args: string[], opts: SafeGitOptions = {}): Buffer {
  const { argv, env } = prepare(cwd, args, opts);
  return execFileSync('git', argv, { encoding: null, env, input: opts.input, timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024, stdio: stdio(opts) });
}

/** Non-throwing variant (spawnSync shape); a refusal comes back as status null with the reason in stderr and error. */
export function safeGitSpawn(cwd: string, args: string[], opts: SafeGitOptions = {}): SpawnSyncReturns<string> {
  let prepared: ReturnType<typeof prepare>;
  try { prepared = prepare(cwd, args, opts); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { pid: 0, output: [null, '', message], stdout: '', stderr: message, status: null, signal: null, error: error instanceof Error ? error : new Error(message) };
  }
  return spawnSync('git', prepared.argv, { encoding: 'utf8', env: prepared.env, input: opts.input, timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024, stdio: stdio(opts) });
}
