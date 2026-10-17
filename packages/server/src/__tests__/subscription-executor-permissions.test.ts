// SUBSCRIPTION_GYM_SPECIES makers must be able to edit files in their worktree (prod 17-10: a claude subscription maker ended
// 'out of scope: no change' because `claude -p` ran without any edit permission) — least privilege, never a blanket bypass.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { Task } from '@djimitflo/shared';
import { ClaudeExecutor } from '../execution/executors/claude-executor';
import { CodexExecutor } from '../execution/executors/codex-executor';
import { SUBSCRIPTION_ENV_MARKER } from '../execution/executors/subscription-env';

const task = { id: 't', description: 'fix the bug' } as Task;
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
// Captured from the CLIs pinned in the Dockerfile (@anthropic-ai/claude-code@2.1.282, @openai/codex@0.146.0).
const claudeHelp = fixture('claude-2.1.282-help.txt');
const codexExecHelp = fixture('codex-0.146.0-exec-help.txt');
const codexApprovalVariants = fixture('codex-0.146.0-approval-policy-error.txt');
const sub = (runtime: string) => ({ environment: { [SUBSCRIPTION_ENV_MARKER]: runtime } });
const previous = { ...process.env };

afterEach(() => { process.env = { ...previous }; });

describe('subscription gym maker permissions', () => {
  it('claude subscription run gets --permission-mode acceptEdits, never --dangerously-skip-permissions', () => {
    process.env.CLAUDE_SKIP_PERMISSIONS = 'true';
    const args = new ClaudeExecutor('claude').buildCommand(task, { ...sub('claude'), skipPermissions: true }).args;
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(claudeHelp).toContain('--permission-mode <mode>');
    expect(claudeHelp).toMatch(/choices: "acceptEdits"/);
  });

  it('non-subscription claude args are unchanged', () => {
    delete process.env.CLAUDE_SKIP_PERMISSIONS;
    const plain = new ClaudeExecutor('claude').buildCommand(task, { format: 'json' }).args;
    expect(plain).toEqual(['-p', 'fix the bug', '--output-format', 'json']);
    expect(new ClaudeExecutor('claude').buildCommand(task, { skipPermissions: true, format: 'json' }).args)
      .toEqual(['-p', 'fix the bug', '--output-format', 'json', '--dangerously-skip-permissions']);
    // a marker naming another runtime does not change claude's args
    expect(new ClaudeExecutor('claude').buildCommand(task, { ...sub('codex'), format: 'json' }).args).toEqual(plain);
  });

  it('codex subscription run is workspace-write sandboxed with approvals never, never bypassed', () => {
    const args = new CodexExecutor('codex').buildCommand(task, { ...sub('codex'), skipPermissions: true, workingDirectory: '/wt' }).args;
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(args.filter((a) => a === '--sandbox')).toHaveLength(1);
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args[args.length - 1]).toBe('fix the bug');
    expect(codexExecHelp).toMatch(/-s, --sandbox <SANDBOX_MODE>/);
    expect(codexExecHelp).toMatch(/possible values: read-only, workspace-write, danger-full-access/);
    expect(codexApprovalVariants).toMatch(/`never`/);
    expect(codexApprovalVariants).toContain('in `approval_policy`');
  });

  it('codex subscription run keeps an explicit sandbox from the loop worker and does not duplicate it', () => {
    const args = new CodexExecutor('codex').buildCommand(task, { ...sub('codex'), codexSandbox: 'workspace-write' }).args;
    expect(args.filter((a) => a === '--sandbox')).toHaveLength(1);
  });

  it('non-subscription codex args are unchanged', () => {
    expect(new CodexExecutor('codex').buildCommand(task, { format: 'json', skipPermissions: true }).args)
      .toEqual(['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', 'fix the bug']);
    expect(new CodexExecutor('codex').buildCommand(task, { format: 'json', ...sub('claude') }).args)
      .toEqual(['exec', '--json', 'fix the bug']);
  });
});
