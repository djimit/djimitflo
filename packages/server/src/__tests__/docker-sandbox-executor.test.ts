import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@djimitflo/shared';
import type { TaskExecutor } from '../execution/types';
import { DockerSandboxExecutor, DEFAULT_SANDBOX_CONFIG } from '../execution/executors/docker-sandbox-executor';

describe('DockerSandboxExecutor', () => {
  it('refuses execution when Docker CLI is unavailable', async () => {
    const inner = {
      kind: 'mock',
      canExecute: () => true,
      start: vi.fn(),
    } as unknown as TaskExecutor;
    const sandbox = new DockerSandboxExecutor(inner, undefined, 'docker-that-does-not-exist');

    await expect(sandbox.start({ id: 'task-1' } as Task)).rejects.toThrow('DOCKER_SANDBOX_UNAVAILABLE');
    expect(inner.start).not.toHaveBeenCalled();
  });

  it('reports kind as docker regardless of inner executor', () => {
    const inner = {
      kind: 'opencode',
      canExecute: () => true,
      start: vi.fn(),
    } as unknown as TaskExecutor;
    const sandbox = new DockerSandboxExecutor(inner);
    expect(sandbox.kind).toBe('docker');
  });

  it('delegates canExecute to inner executor', () => {
    const inner = {
      kind: 'mock',
      canExecute: vi.fn().mockReturnValue(false),
      start: vi.fn(),
    } as unknown as TaskExecutor;
    const sandbox = new DockerSandboxExecutor(inner);
    const task = { id: 'task-1' } as Task;
    expect(sandbox.canExecute(task)).toBe(false);
    expect(inner.canExecute).toHaveBeenCalledWith(task);
  });
});

describe('DockerSandboxExecutor.buildDockerArgs', () => {
  it('includes security hardening flags', () => {
    const args = DockerSandboxExecutor.buildDockerArgs(
      'test-container',
      DEFAULT_SANDBOX_CONFIG,
      'echo',
      ['hello'],
      '/tmp/work',
      { FOO: 'bar' },
    );

    expect(args).toContain('--user');
    expect(args).toContain('1000:1000');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges:true');
  });

  it('includes resource limits', () => {
    const args = DockerSandboxExecutor.buildDockerArgs(
      'test-container',
      DEFAULT_SANDBOX_CONFIG,
      'echo',
      ['hello'],
    );

    expect(args).toContain('--cpus');
    expect(args).toContain('1.0');
    expect(args).toContain('--memory');
    expect(args).toContain('512m');
    expect(args).toContain('--network');
    expect(args).toContain('none');
  });

  it('includes read-only root with tmpfs', () => {
    const args = DockerSandboxExecutor.buildDockerArgs(
      'test-container',
      DEFAULT_SANDBOX_CONFIG,
      'echo',
      ['hello'],
    );

    expect(args).toContain('--read-only');
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/tmp:size=64m');
  });

  it('includes working directory bind mount', () => {
    const args = DockerSandboxExecutor.buildDockerArgs(
      'test-container',
      DEFAULT_SANDBOX_CONFIG,
      'echo',
      ['hello'],
      '/host/work',
    );

    expect(args).toContain('-v');
    expect(args).toContain('/host/work:/workspace:rw');
    expect(args).toContain('-w');
    expect(args).toContain('/workspace');
  });

  it('strips __ prefixed env vars', () => {
    const args = DockerSandboxExecutor.buildDockerArgs(
      'test-container',
      DEFAULT_SANDBOX_CONFIG,
      'echo',
      ['hello'],
      undefined,
      { __SECRET: 'hidden', VISIBLE: 'yes' },
    );

    expect(args).not.toContain('__SECRET=hidden');
    expect(args).toContain('VISIBLE=yes');
  });

  it('includes image and command at the end', () => {
    const args = DockerSandboxExecutor.buildDockerArgs(
      'test-container',
      DEFAULT_SANDBOX_CONFIG,
      'sh',
      ['-c', 'echo test'],
    );

    const imageIdx = args.indexOf(DEFAULT_SANDBOX_CONFIG.image);
    expect(imageIdx).toBeGreaterThan(-1);
    expect(args[imageIdx + 1]).toBe('sh');
    expect(args[imageIdx + 2]).toBe('-c');
    expect(args[imageIdx + 3]).toBe('echo test');
  });

  it('includes custom bind mounts', () => {
    const config = {
      ...DEFAULT_SANDBOX_CONFIG,
      bindMounts: [{ host: '/data', container: '/data', mode: 'ro' as const }],
    };
    const args = DockerSandboxExecutor.buildDockerArgs(
      'test-container',
      config,
      'echo',
      ['hello'],
    );

    expect(args).toContain('/data:/data:ro');
  });

  it('uses container name with --name flag', () => {
    const args = DockerSandboxExecutor.buildDockerArgs(
      'my-sandbox-123',
      DEFAULT_SANDBOX_CONFIG,
      'echo',
      ['hello'],
    );

    expect(args).toContain('--name');
    expect(args).toContain('my-sandbox-123');
  });

  it('includes --rm for automatic cleanup', () => {
    const args = DockerSandboxExecutor.buildDockerArgs(
      'test-container',
      DEFAULT_SANDBOX_CONFIG,
      'echo',
      ['hello'],
    );

    expect(args).toContain('--rm');
  });
});

describe('DockerSandboxExecutor isolation invariants', () => {
  it('default config has network none', () => {
    expect(DEFAULT_SANDBOX_CONFIG.networkMode).toBe('none');
  });

  it('default config has readOnlyRoot true', () => {
    expect(DEFAULT_SANDBOX_CONFIG.readOnlyRoot).toBe(true);
  });

  it('default config has no-new-privileges enabled', () => {
    expect(DEFAULT_SANDBOX_CONFIG.noNewPrivileges).toBe(true);
  });

  it('default config drops ALL capabilities', () => {
    expect(DEFAULT_SANDBOX_CONFIG.capDrop).toContain('ALL');
  });

  it('default config runs as non-root user', () => {
    expect(DEFAULT_SANDBOX_CONFIG.user).toBe('1000:1000');
  });
});
