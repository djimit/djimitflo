import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { LoopService } from '../services/loop-service';

/**
 * C2 unit tests for the claude / gemini / editor(=cline) loop runtimes:
 * - buildRuntimeCommand: command + args shape, skipPermissions toggle, model
 *   injection (claude --dangerously-skip-permissions, gemini -y, cline
 *   --auto-approve true).
 * - getRuntimeContract: available vs drifted via fake binaries that respond to
 *   `--version` and the runtime's help subcommand with the required flags.
 *
 * buildRuntimeCommand and getRuntimeContract are private; accessed via the
 * instance (same pattern as worktree-retry.test.ts). Each fake binary is unique
 * per test so the per-instance runtimeContractCache (keyed on `runtime::command`)
 * never cross-contaminates.
 */

const previousEnv = { ...process.env };

function writeFakeBin(dir: string, name: string, helpText: string): string {
  const file = path.join(dir, name);
  // `--version` -> exit 0 with a version line; `--help` (and any other first
  // arg) -> print the supplied help text. The real run path is exercised by the
  // e2e in nested-spawn-loop.test.ts, not here.
  const script = `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "${name} fake-runtime 1.0.0"
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  cat <<'EOF'
${helpText}
EOF
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  cat <<'EOF'
${helpText}
EOF
  exit 0
fi
cat <<'EOF'
${helpText}
EOF
exit 0
`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('buildRuntimeCommand: claude / gemini / editor', () => {
  let db: Database.Database;
  let binDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-rt-cmd-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(binDir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in previousEnv)) delete (process.env as any)[k];
    }
    Object.assign(process.env, previousEnv);
  });

  it('claude: -p <prompt> --output-format json, skip-permissions + model toggles', () => {
    const bin = writeFakeBin(binDir, 'claude', 'Usage: claude -p <prompt> --output-format json');
    process.env.CLAUDE_BIN_PATH = bin;
    process.env.DJIMITFLO_CLAUDE_MODEL = 'sonnet';
    const loops = new LoopService(db);
    const cmd = (loops as any).buildRuntimeCommand('claude', '/wt', 'do work', false) as { command: string; args: string[] };
    expect(cmd.command).toBe(bin);
    expect(cmd.args).toEqual(['-p', 'do work', '--output-format', 'json', '--model', 'sonnet']);

    const skip = (loops as any).buildRuntimeCommand('claude', '/wt', 'do work', true) as { args: string[] };
    expect(skip.args).toEqual(['-p', 'do work', '--output-format', 'json', '--dangerously-skip-permissions', '--model', 'sonnet']);
  });

  it('gemini: -p <prompt> -o json, -y + -m toggles', () => {
    const bin = writeFakeBin(binDir, 'gemini', 'Usage: gemini -p <prompt> -o json');
    process.env.GEMINI_BIN_PATH = bin;
    process.env.DJIMITFLO_GEMINI_MODEL = 'pro';
    const loops = new LoopService(db);
    const cmd = (loops as any).buildRuntimeCommand('gemini', '/wt', 'do work', false) as { command: string; args: string[] };
    expect(cmd.command).toBe(bin);
    expect(cmd.args).toEqual(['-p', 'do work', '-o', 'json', '-m', 'pro']);

    const skip = (loops as any).buildRuntimeCommand('gemini', '/wt', 'do work', true) as { args: string[] };
    expect(skip.args).toEqual(['-p', 'do work', '-o', 'json', '-y', '-m', 'pro']);
  });

  it('editor(=cline): --json --auto-approve <bool> -c <wt> --thinking <t> <prompt>, -m toggle', () => {
    const bin = writeFakeBin(binDir, 'cline', 'Usage: cline --json --auto-approve <bool> -c <dir>');
    process.env.CLINE_BIN_PATH = bin;
    process.env.DJIMITFLO_CLINE_THINKING = 'high';
    process.env.DJIMITFLO_CLINE_MODEL = 'gpt-5';
    const loops = new LoopService(db);
    const cmd = (loops as any).buildRuntimeCommand('editor', '/wt/x', 'do work', false) as { command: string; args: string[] };
    expect(cmd.command).toBe(bin);
    expect(cmd.args).toEqual(['--json', '--auto-approve', 'false', '-c', '/wt/x', '--thinking', 'high', '-m', 'gpt-5', 'do work']);

    const skip = (loops as any).buildRuntimeCommand('editor', '/wt/x', 'do work', true) as { args: string[] };
    // --auto-approve flips to true only when skipPermissions is armed.
    expect(skip.args[1]).toBe('--auto-approve');
    expect(skip.args[2]).toBe('true');
    expect(skip.args).toEqual(['--json', '--auto-approve', 'true', '-c', '/wt/x', '--thinking', 'high', '-m', 'gpt-5', 'do work']);
  });

  it('falls back to the bare CLI name when no _BIN_PATH is set', () => {
    delete process.env.CLAUDE_BIN_PATH;
    delete process.env.GEMINI_BIN_PATH;
    delete process.env.CLINE_BIN_PATH;
    const loops = new LoopService(db);
    expect((loops as any).buildRuntimeCommand('claude', '/wt', 'p', false).command).toBe('claude');
    expect((loops as any).buildRuntimeCommand('gemini', '/wt', 'p', false).command).toBe('gemini');
    expect((loops as any).buildRuntimeCommand('editor', '/wt', 'p', false).command).toBe('cline');
  });
});

describe('getRuntimeContract: claude / gemini / editor probes', () => {
  let db: Database.Database;
  let binDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djimitflo-rt-contract-'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(binDir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in previousEnv)) delete (process.env as any)[k];
    }
    Object.assign(process.env, previousEnv);
  });

  it('claude: available when help lists -p and --output-format', () => {
    const bin = writeFakeBin(binDir, 'claude', 'Usage: claude -p <prompt> --output-format json [--dangerously-skip-permissions]');
    process.env.CLAUDE_BIN_PATH = bin;
    const loops = new LoopService(db);
    const contract = (loops as any).getRuntimeContract('claude');
    expect(contract.runtime).toBe('claude');
    expect(contract.available).toBe(true);
    expect(contract.status).toBe('ok');
    expect(contract.command).toBe(bin);
    expect(contract.json_flag).toBe('--output-format');
    expect(contract.supports_json_events).toBe(true);
  });

  it('gemini: available when help lists -p and -o', () => {
    const bin = writeFakeBin(binDir, 'gemini', 'Usage: gemini -p <prompt> -o json [-y]');
    process.env.GEMINI_BIN_PATH = bin;
    const loops = new LoopService(db);
    const contract = (loops as any).getRuntimeContract('gemini');
    expect(contract.runtime).toBe('gemini');
    expect(contract.available).toBe(true);
    expect(contract.status).toBe('ok');
    expect(contract.json_flag).toBe('-o');
  });

  it('editor(=cline): available when help lists --json and -c', () => {
    const bin = writeFakeBin(binDir, 'cline', 'Usage: cline --json --auto-approve <bool> -c <dir>');
    process.env.CLINE_BIN_PATH = bin;
    const loops = new LoopService(db);
    const contract = (loops as any).getRuntimeContract('editor');
    expect(contract.runtime).toBe('editor');
    expect(contract.available).toBe(true);
    expect(contract.status).toBe('ok');
    expect(contract.cwd_flag).toBe('-c');
    expect(contract.json_flag).toBe('--json');
  });

  it('drifts when the headless flag is missing from help', () => {
    // claude help with --output-format but WITHOUT -p → missing headless flag →
    // drifted/unavailable.
    const bin = writeFakeBin(binDir, 'claude-broken', 'Usage: claude --output-format json (interactive only)');
    process.env.CLAUDE_BIN_PATH = bin;
    const loops = new LoopService(db);
    const contract = (loops as any).getRuntimeContract('claude');
    expect(contract.status).toBe('drifted');
    expect(contract.available).toBe(false);
    expect(contract.reason).toMatch(/headless/);
  });

  it('returns unavailable when the binary is missing', () => {
    process.env.CLAUDE_BIN_PATH = path.join(binDir, 'does-not-exist');
    const loops = new LoopService(db);
    const contract = (loops as any).getRuntimeContract('claude');
    expect(contract.status).toBe('unavailable');
    expect(contract.available).toBe(false);
  });

  it('getRuntimeContracts() exposes claude/gemini/editor alongside codex/opencode', () => {
    process.env.CLAUDE_BIN_PATH = path.join(binDir, 'nope');
    process.env.GEMINI_BIN_PATH = path.join(binDir, 'nope');
    process.env.CLINE_BIN_PATH = path.join(binDir, 'nope');
    const loops = new LoopService(db);
    const { runtimes } = (loops as any).getRuntimeContracts() as { runtimes: Record<string, any> };
    for (const r of ['manual', 'mock', 'codex', 'opencode', 'claude', 'gemini', 'editor']) {
      expect(runtimes[r]).toBeDefined();
    }
    expect(runtimes.claude.runtime).toBe('claude');
    expect(runtimes.editor.runtime).toBe('editor');
  });
});