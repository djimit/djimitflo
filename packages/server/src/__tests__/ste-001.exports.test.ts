import { expect, it } from 'vitest';
import { STE_001_TARGET_PER_ARM, runSte001, ste001On } from '../services/ste-001';

// Minimal structural mock of better-sqlite3 Database — only what runSte001 touches.
type Row = { metadata: string } | undefined;
const makeDb = (...rows: Row[]) => ({
  prepare: (_sql: string) => ({ get: () => rows[0] }),
});

// --- ste001On ---
it('ste001On returns true only when STE_001_MODE=on', () => {
  expect(ste001On({ STE_001_MODE: 'on' })).toBe(true);
  expect(ste001On({ STE_001_MODE: 'off' })).toBe(false);
  expect(ste001On({})).toBe(false);
});

// --- STE_001_TARGET_PER_ARM ---
it('STE_001_TARGET_PER_ARM is the pre-registered per-arm target (100)', () => {
  expect(STE_001_TARGET_PER_ARM).toBe(100);
});

// --- runSte001 ---
it('runSte001 returns null for a run with no assignment_context event', () => {
  expect(runSte001(makeDb(undefined), 'no-such-run')).toBeNull();
});

it('runSte001 returns null when metadata has no valid ste_001 field', () => {
  // empty metadata object
  expect(runSte001(makeDb({ metadata: '{}' }), 'r-empty')).toBeNull();

  // ste_001 present but arm out of range
  const bad = { metadata: JSON.stringify({ ste_001: { arm: 7, template_hash: 'abc' } }) };
  expect(runSte001(makeDb(bad), 'r-badarm')).toBeNull();

  // ste_001 missing entirely
  const nokey = { metadata: JSON.stringify({ examples: [] }) };
  expect(runSte001(makeDb(nokey), 'r-nokey')).toBeNull();
});

it('runSte001 returns the SteContext from the latest assignment_context event', () => {
  const ctx = { arm: 1 as const, template_hash: 'deadbeefcafe' };
  const row = { metadata: JSON.stringify({ ste_001: ctx }) };
  expect(runSte001(makeDb(row), 'r-ctx')).toEqual(ctx);
});

it('runSte001 picks the most recent event when multiple exist (ORDER BY created_at DESC)', () => {
  // The mock always returns rows[0], simulating the "latest" row.
  const newer = { arm: 1 as const, template_hash: 'new' };
  const older = { arm: 0 as const, template_hash: 'old' };
  // newest first — matches ORDER BY created_at DESC LIMIT 1
  expect(runSte001(makeDb({ metadata: JSON.stringify({ ste_001: newer }) }), 'r-multi')).toEqual(newer);
  expect(runSte001(makeDb({ metadata: JSON.stringify({ ste_001: older }) }), 'r-multi')).toEqual(older);
});

it('runSte001 returns null on malformed metadata JSON', () => {
  expect(runSte001(makeDb({ metadata: '{not valid json' }), 'r-badjson')).toBeNull();
});
