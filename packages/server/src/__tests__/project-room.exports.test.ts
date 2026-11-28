import { describe, expect, it } from 'vitest';
import { refResolver, roomSelected, roomVariant } from '../services/project-room';
import type { SourceRef } from '../services/plan-artifact';

/**
 * G2/G3 exports: roomSelected reports whether a goal's metadata routes it through
 * the project room; roomVariant picks two_stage (default) or single; refResolver
 * builds a function that resolves a SourceRef against a pinned commit using git.
 * These exported helpers had no test naming them; this test-only file covers them
 * directly (no database, no network).
 */
describe('roomSelected', () => {
  it('returns true only when metadata.task_profile is exactly "project_room"', () => {
    expect(roomSelected({ task_profile: 'project_room' })).toBe(true);
  });

  it('returns false for any other task_profile value', () => {
    expect(roomSelected({ task_profile: 'direct' })).toBe(false);
    expect(roomSelected({ task_profile: 'Project_Room' })).toBe(false);
    expect(roomSelected({})).toBe(false);
    expect(roomSelected({ task_profile: '' })).toBe(false);
  });
});

describe('roomVariant', () => {
  it('defaults to two_stage when project_room is absent or has no variant', () => {
    expect(roomVariant({})).toBe('two_stage');
    expect(roomVariant({ task_profile: 'project_room' })).toBe('two_stage');
    expect(roomVariant({ project_room: {} })).toBe('two_stage');
  });

  it('returns single only when project_room.variant is exactly "single"', () => {
    expect(roomVariant({ project_room: { variant: 'single' } })).toBe('single');
  });

  it('treats any other variant value as two_stage', () => {
    expect(roomVariant({ project_room: { variant: 'two_stage' } })).toBe('two_stage');
    expect(roomVariant({ project_room: { variant: 'Single' } })).toBe('two_stage');
    expect(roomVariant({ project_room: { variant: 1 } })).toBe('two_stage');
  });
});

describe('refResolver', () => {
  const repoRoot = '/repo';
  const commit = 'abc123';
  type GitArgs = [string, string[]];

  it('returns true for a file path that exists in the commit when no symbol is named', () => {
    const git = (cwd: string, args: string[]): string => {
      expect(cwd).toBe(repoRoot);
      expect(args).toEqual(['show', `${commit}:src/foo.ts`]);
      return 'file contents';
    };
    const resolve = refResolver(repoRoot, commit, git);
    expect(resolve({ path: 'src/foo.ts' } as SourceRef)).toBe(true);
  });

  it('returns true when the named symbol is present in the file at the commit', () => {
    const seen: GitArgs[] = [];
    const git = (cwd: string, args: string[]): string => {
      seen.push([cwd, args]);
      return 'export function roomSelected() {}\n';
    };
    const resolve = refResolver(repoRoot, commit, git);
    expect(resolve({ path: 'src/project-room.ts', symbol: 'roomSelected' } as SourceRef)).toBe(true);
    expect(seen).toEqual([[repoRoot, ['show', `${commit}:src/project-room.ts`]]]);
  });

  it('returns false when the named symbol is absent from the file', () => {
    const git = (): string => 'export const other = 1;\n';
    const resolve = refResolver(repoRoot, commit, git);
    expect(resolve({ path: 'src/x.ts', symbol: 'roomVariant' } as SourceRef)).toBe(false);
  });

  it('returns false when git show throws (missing file or commit)', () => {
    const git = (): string => { throw new Error('fatal: path does not exist'); };
    const resolve = refResolver(repoRoot, commit, git);
    expect(resolve({ path: 'src/missing.ts' } as SourceRef)).toBe(false);
    expect(resolve({ path: 'src/missing.ts', symbol: 'x' } as SourceRef)).toBe(false);
  });
});
