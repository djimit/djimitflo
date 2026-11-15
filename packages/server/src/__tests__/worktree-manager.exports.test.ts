import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restoreAgentConfig } from '../services/worktree-manager';

let trusted: string;
let worktree: string;
const dirs: string[] = [];

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const initRepo = (dir: string) => {
  git(dir, ['init', '--quiet', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
};

const commitAll = (cwd: string, msg: string) => {
  git(cwd, ['add', '-A']);
  execFileSync('git', ['-C', cwd, 'commit', '--quiet', '--allow-empty', '-m', msg], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

beforeEach(() => {
  trusted = fs.mkdtempSync(path.join(os.tmpdir(), 'wtm-exports-trusted-')); dirs.push(trusted);
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wtm-exports-worktree-')); dirs.push(worktree);
  initRepo(trusted);
  initRepo(worktree);
});

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('restoreAgentConfig', () => {
  it('restores an edited agent-config file to the base content and commits the change', () => {
    fs.writeFileSync(path.join(trusted, 'AGENTS.md'), 'base agents\n');
    commitAll(trusted, 'trusted base');

    fs.writeFileSync(path.join(worktree, 'AGENTS.md'), 'maker-edited\n');
    commitAll(worktree, 'maker edit');

    const changed = restoreAgentConfig(trusted, worktree);

    expect(changed).toEqual(['AGENTS.md']);
    expect(fs.readFileSync(path.join(worktree, 'AGENTS.md'), 'utf8')).toBe('base agents\n');
    expect(git(worktree, ['log', '--format=%s', '-1'])).toBe('Restore agent config from the base commit (checker independence)');
  });

  it('removes an agent-config file added by the maker that is not in the trusted base', () => {
    fs.writeFileSync(path.join(trusted, 'AGENTS.md'), 'base agents\n');
    commitAll(trusted, 'trusted base');

    fs.writeFileSync(path.join(worktree, 'AGENTS.md'), 'base agents\n');
    fs.mkdirSync(path.join(worktree, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.claude', 'settings.json'), '{"maker":true}\n');
    commitAll(worktree, 'maker adds claude settings');

    const changed = restoreAgentConfig(trusted, worktree);

    expect(changed).toEqual(['.claude/settings.json']);
    expect(fs.existsSync(path.join(worktree, '.claude', 'settings.json'))).toBe(false);
  });

  it('restores a deleted agent-config file from the trusted base', () => {
    fs.mkdirSync(path.join(trusted, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(trusted, '.opencode', 'config.json'), '{"base":true}\n');
    fs.writeFileSync(path.join(trusted, 'opencode.json'), '{"base":true}\n');
    commitAll(trusted, 'trusted base');

    fs.mkdirSync(path.join(worktree, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.opencode', 'config.json'), '{"base":true}\n');
    fs.writeFileSync(path.join(worktree, 'opencode.json'), '{"base":true}\n');
    commitAll(worktree, 'maker matches base');
    // commit the deletion so the worktree HEAD no longer has the file
    git(worktree, ['rm', '--quiet', 'opencode.json']);
    commitAll(worktree, 'maker deletes opencode.json');

    const changed = restoreAgentConfig(trusted, worktree);

    expect(changed).toEqual(['opencode.json']);
    expect(fs.readFileSync(path.join(worktree, 'opencode.json'), 'utf8')).toBe('{"base":true}\n');
  });

  it('leaves a matching agent-config file untouched and returns no changes when nothing differs', () => {
    fs.mkdirSync(path.join(trusted, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(trusted, '.opencode', 'config.json'), '{"base":true}\n');
    fs.writeFileSync(path.join(trusted, 'AGENTS.md'), 'base agents\n');
    commitAll(trusted, 'trusted base');

    fs.mkdirSync(path.join(worktree, '.opencode'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.opencode', 'config.json'), '{"base":true}\n');
    fs.writeFileSync(path.join(worktree, 'AGENTS.md'), 'base agents\n');
    commitAll(worktree, 'maker matches base');
    const headBefore = git(worktree, ['rev-parse', 'HEAD']);

    const changed = restoreAgentConfig(trusted, worktree);

    expect(changed).toEqual([]);
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(headBefore);
  });

  it('ignores non-agent-config files in the worktree (they are never changed or reported)', () => {
    fs.writeFileSync(path.join(trusted, 'AGENTS.md'), 'base agents\n');
    commitAll(trusted, 'trusted base');

    fs.writeFileSync(path.join(worktree, 'AGENTS.md'), 'base agents\n');
    fs.mkdirSync(path.join(worktree, 'packages/server/src/services'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'packages/server/src/services/widget.ts'), 'export const w = 1;\n');
    commitAll(worktree, 'maker adds source file');

    const changed = restoreAgentConfig(trusted, worktree);

    expect(changed).toEqual([]);
    expect(fs.existsSync(path.join(worktree, 'packages/server/src/services/widget.ts'))).toBe(true);
  });

  it('reports multiple changed files sorted alphabetically', () => {
    fs.writeFileSync(path.join(trusted, 'AGENTS.md'), 'base agents\n');
    fs.writeFileSync(path.join(trusted, 'CLAUDE.md'), 'base claude\n');
    fs.writeFileSync(path.join(trusted, 'opencode.json'), '{}\n');
    commitAll(trusted, 'trusted base');

    fs.writeFileSync(path.join(worktree, 'AGENTS.md'), 'maker\n');
    fs.writeFileSync(path.join(worktree, 'CLAUDE.md'), 'base claude\n');
    fs.writeFileSync(path.join(worktree, 'opencode.json'), '{}\n');
    fs.mkdirSync(path.join(worktree, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.codex', 'config.toml'), 'maker\n');
    commitAll(worktree, 'maker state');

    const changed = restoreAgentConfig(trusted, worktree);

    expect(changed).toEqual(['.codex/config.toml', 'AGENTS.md']);
    expect(fs.readFileSync(path.join(worktree, 'AGENTS.md'), 'utf8')).toBe('base agents\n');
    expect(fs.existsSync(path.join(worktree, '.codex', 'config.toml'))).toBe(false);
  });
});
