import { describe, expect, it } from 'vitest';
import {
  abstractFromNote,
  DISCOVERY_RELEVANCE_POLICY,
  discoveryRelevancePaused,
  discoveryRelevanceSources,
  sourceUnitsEnabled,
} from '../services/expert-source-units-service';

describe('sourceUnitsEnabled', () => {
  it('returns true only when FRONTIER_EXPERT_SOURCE_UNITS_ENABLED is "true"', () => {
    expect(sourceUnitsEnabled({ FRONTIER_EXPERT_SOURCE_UNITS_ENABLED: 'true' })).toBe(true);
  });

  it('returns false when the flag is unset', () => {
    expect(sourceUnitsEnabled({})).toBe(false);
  });

  it('returns false when the flag is any other value', () => {
    expect(sourceUnitsEnabled({ FRONTIER_EXPERT_SOURCE_UNITS_ENABLED: 'false' })).toBe(false);
    expect(sourceUnitsEnabled({ FRONTIER_EXPERT_SOURCE_UNITS_ENABLED: '1' })).toBe(false);
  });
});

describe('discoveryRelevanceSources', () => {
  it('returns null when DISCOVERY_RELEVANCE_SOURCES is unset', () => {
    expect(discoveryRelevanceSources({})).toBeNull();
  });

  it('returns null when the list is empty after trimming', () => {
    expect(discoveryRelevanceSources({ DISCOVERY_RELEVANCE_SOURCES: ' , , ' })).toBeNull();
  });

  it('returns a Set of trimmed source names', () => {
    expect(discoveryRelevanceSources({ DISCOVERY_RELEVANCE_SOURCES: 'a, b ,c' })).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('discoveryRelevancePaused', () => {
  it('returns true when DISCOVERY_RELEVANCE_PAUSED is "true"', () => {
    expect(discoveryRelevancePaused({ DISCOVERY_RELEVANCE_PAUSED: 'true' })).toBe(true);
  });

  it('returns false when unset', () => {
    expect(discoveryRelevancePaused({})).toBe(false);
  });

  it('returns false for any other value', () => {
    expect(discoveryRelevancePaused({ DISCOVERY_RELEVANCE_PAUSED: 'false' })).toBe(false);
  });
});

describe('DISCOVERY_RELEVANCE_POLICY', () => {
  it('is a non-empty string prefixed with discovery_relevance:', () => {
    expect(typeof DISCOVERY_RELEVANCE_POLICY).toBe('string');
    expect(DISCOVERY_RELEVANCE_POLICY.startsWith('discovery_relevance:')).toBe(true);
    expect(DISCOVERY_RELEVANCE_POLICY.length).toBeGreaterThan('discovery_relevance:'.length);
  });
});

describe('abstractFromNote', () => {
  const longProse = 'A'.repeat(200);
  const longerProse = 'B'.repeat(300);

  it('returns the trimmed text for prose of at least 200 characters', () => {
    expect(abstractFromNote(longProse)).toBe(longProse);
    expect(abstractFromNote(longerProse)).toBe(longerProse);
  });

  it('trims surrounding whitespace before length check and in the result', () => {
    const padded = '   ' + longProse + '   ';
    expect(abstractFromNote(padded)).toBe(longProse);
  });

  it('returns null for a note shorter than 200 characters', () => {
    expect(abstractFromNote('short note')).toBeNull();
    expect(abstractFromNote('A'.repeat(199))).toBeNull();
  });

  it('returns null for a note that is exactly 199 chars after trim', () => {
    const note = '  ' + 'x'.repeat(199) + '  ';
    expect(abstractFromNote(note)).toBeNull();
  });

  it('returns null for notes starting with "scout match" (case-insensitive)', () => {
    const scoutNote = 'scout match: agent, coding, ' + 'y'.repeat(200);
    expect(abstractFromNote(scoutNote)).toBeNull();
    expect(abstractFromNote('Scout Match whatever ' + 'y'.repeat(200))).toBeNull();
    expect(abstractFromNote('SCOUT MATCH ' + 'y'.repeat(200))).toBeNull();
  });

  it('returns null for notes starting with "hf daily" (case-insensitive)', () => {
    const hfNote = 'hf daily: model release, ' + 'y'.repeat(200);
    expect(abstractFromNote(hfNote)).toBeNull();
    expect(abstractFromNote('HF Daily ' + 'y'.repeat(200))).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(abstractFromNote(null)).toBeNull();
    expect(abstractFromNote(undefined)).toBeNull();
    expect(abstractFromNote(42)).toBeNull();
    expect(abstractFromNote({ text: longProse })).toBeNull();
    expect(abstractFromNote(['array', longProse])).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(abstractFromNote('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(abstractFromNote('   \n\t  ')).toBeNull();
  });

  it('does not reject prose that merely contains "scout match" later in the text', () => {
    const note = 'This paper discusses scout matching techniques. ' + 'z'.repeat(200);
    expect(abstractFromNote(note)).toBe(note);
  });
});