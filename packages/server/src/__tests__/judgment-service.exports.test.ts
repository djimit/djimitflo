import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { judgmentMode } from '../services/judgment-service';

describe('judgmentMode — env-driven mode resolution', () => {
  const snapshot = { ...process.env };

  beforeEach(() => {
    delete process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE;
    delete process.env.TYPESAFE_AUDIT_GATE_MODE;
    delete process.env.TYPESAFE_MixedCase_MODE;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TYPESAFE_') && !(k in snapshot)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(snapshot)) process.env[k] = v as string;
  });

  it('defaults to off when the env var is unset', () => {
    expect(judgmentMode('proposal_prescreen')).toBe('off');
  });

  it('returns off when the env var is an unrecognized value', () => {
    process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = 'loud';
    expect(judgmentMode('proposal_prescreen')).toBe('off');
  });

  it('returns off for empty string', () => {
    process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = '';
    expect(judgmentMode('proposal_prescreen')).toBe('off');
  });

  it('returns shadow when the env var is "shadow"', () => {
    process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = 'shadow';
    expect(judgmentMode('proposal_prescreen')).toBe('shadow');
  });

  it('returns enforce when the env var is "enforce"', () => {
    process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = 'enforce';
    expect(judgmentMode('proposal_prescreen')).toBe('enforce');
  });

  it('lowercases the env value before matching', () => {
    process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = 'SHADOW';
    expect(judgmentMode('proposal_prescreen')).toBe('shadow');
    process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = 'Enforce';
    expect(judgmentMode('proposal_prescreen')).toBe('enforce');
  });

  it('uppercases the judgment id when building the env var name', () => {
    process.env.TYPESAFE_AUDIT_GATE_MODE = 'shadow';
    expect(judgmentMode('audit_gate')).toBe('shadow');
  });

  it('handles ids with mixed casing by uppercasing them', () => {
    process.env.TYPESAFE_MIXEDCASE_MODE = 'enforce';
    expect(judgmentMode('MixedCase')).toBe('enforce');
  });

  it('resolves different ids independently', () => {
    process.env.TYPESAFE_PROPOSAL_PRESCREEN_MODE = 'shadow';
    process.env.TYPESAFE_AUDIT_GATE_MODE = 'enforce';
    expect(judgmentMode('proposal_prescreen')).toBe('shadow');
    expect(judgmentMode('audit_gate')).toBe('enforce');
    expect(judgmentMode('unknown_gate')).toBe('off');
  });
});