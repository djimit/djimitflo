import { execFileSync } from 'child_process';

/**
 * Runs a git subcommand with its arguments passed as an array — never through
 * a shell. Repository-controlled values (filenames, refs, branch names) can
 * therefore never be interpreted as shell metacharacters or inject commands.
 *
 * stderr is captured (available on the thrown error for diagnostics) rather
 * than streamed to the console; a non-zero exit throws (callers handle
 * fallbacks).
 */
export function runGit(args: string[], cwd: string, maxBuffer: number = 1024 * 1024): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
