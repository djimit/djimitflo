import { describe, expect, it } from 'vitest';
import { calibrationRefusal } from '../services/openmythos-attestation-service';

const base = {
  calibrated: true,
  agreement_rate: 0.9,
  lowest_category_agreement_rate: 0.85,
};

describe('calibrationRefusal', () => {
  it('returns null when calibrated with valid agreement at or above the default minimum', () => {
    expect(calibrationRefusal({ ...base })).toBeNull();
  });

  it('returns null at exactly the default minimum (0.8)', () => {
    expect(calibrationRefusal({ ...base, agreement_rate: 0.8, lowest_category_agreement_rate: 0.8 })).toBeNull();
  });

  it('returns "not calibrated" when calibrated is not true', () => {
    expect(calibrationRefusal({ ...base, calibrated: false })).toBe('not calibrated');
    expect(calibrationRefusal({ ...base, calibrated: undefined })).toBe('not calibrated');
  });

  it('returns a refusal when agreement_rate is missing or not a finite rate', () => {
    expect(calibrationRefusal({ ...base, agreement_rate: undefined })).toBe(
      'agreement_rate missing or not a rate in [0, 1]',
    );
    expect(calibrationRefusal({ ...base, agreement_rate: '0.9' })).toBe(
      'agreement_rate missing or not a rate in [0, 1]',
    );
    expect(calibrationRefusal({ ...base, agreement_rate: 1.5 })).toBe(
      'agreement_rate missing or not a rate in [0, 1]',
    );
    expect(calibrationRefusal({ ...base, agreement_rate: Number.NaN })).toBe(
      'agreement_rate missing or not a rate in [0, 1]',
    );
  });

  it('returns a refusal when lowest_category_agreement_rate is missing or not a finite rate', () => {
    expect(calibrationRefusal({ ...base, lowest_category_agreement_rate: undefined })).toBe(
      'lowest_category_agreement_rate missing or not a rate in [0, 1]',
    );
    expect(calibrationRefusal({ ...base, lowest_category_agreement_rate: null })).toBe(
      'lowest_category_agreement_rate missing or not a rate in [0, 1]',
    );
  });

  it('returns a refusal when minimum_agreement_rate is present but not a rate', () => {
    expect(calibrationRefusal({ ...base, minimum_agreement_rate: 'high' })).toBe(
      'minimum_agreement_rate not a rate in [0, 1]',
    );
    expect(calibrationRefusal({ ...base, minimum_agreement_rate: 2 })).toBe(
      'minimum_agreement_rate not a rate in [0, 1]',
    );
  });

  it('returns a refusal when minimum_category_agreement_rate is present but not a rate', () => {
    expect(calibrationRefusal({ ...base, minimum_category_agreement_rate: 'low' })).toBe(
      'minimum_category_agreement_rate not a rate in [0, 1]',
    );
  });

  it('returns a refusal when agreement is below the default minimum', () => {
    expect(calibrationRefusal({ ...base, agreement_rate: 0.7 })).toBe('agreement 0.7 < minimum 0.8');
  });

  it('returns a refusal when agreement is below a custom minimum_agreement_rate', () => {
    expect(
      calibrationRefusal({ ...base, agreement_rate: 0.85, minimum_agreement_rate: 0.9 }),
    ).toBe('agreement 0.85 < minimum 0.9');
  });

  it('returns a refusal when the lowest category is below minimum_category_agreement_rate', () => {
    expect(
      calibrationRefusal({ ...base, lowest_category_agreement_rate: 0.4, minimum_category_agreement_rate: 0.5 }),
    ).toBe('lowest category agreement 0.4 < minimum 0.5');
  });

  it('returns a refusal when the lowest category exceeds the overall rate (inconsistent)', () => {
    expect(
      calibrationRefusal({ ...base, agreement_rate: 0.8, lowest_category_agreement_rate: 0.9 }),
    ).toBe('lowest category agreement 0.9 > overall 0.8 (inconsistent)');
  });

  it('tolerates floating-point noise within 1e-9 for lowest == overall', () => {
    expect(
      calibrationRefusal({
        ...base,
        agreement_rate: 0.9,
        lowest_category_agreement_rate: 0.9 + 5e-10,
        minimum_agreement_rate: 0.8,
      }),
    ).toBeNull();
  });

  it('honours a custom minimum_agreement_rate of 0 that lets low agreement pass', () => {
    expect(
      calibrationRefusal({
        ...base,
        agreement_rate: 0.1,
        lowest_category_agreement_rate: 0.1,
        minimum_agreement_rate: 0,
      }),
    ).toBeNull();
  });
});
