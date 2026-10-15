import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { canonicalManifestJson, manifestSha256, validateManifestSchema } from '../services/holdout-manifest';

const SHA64 = 'a'.repeat(64);

const validManifest = {
  manifest_version: 1,
  holdout_epoch: 0,
  tasks: { mined: [{ key: 'c1', source: 'a.ts' }] },
  manifest_sha256: '',
} as Record<string, unknown>;

function withSha(m: Record<string, unknown>): Record<string, unknown> {
  m.manifest_sha256 = manifestSha256(m);
  return m;
}

describe('canonicalManifestJson', () => {
  it('returns JSON.stringify of the manifest with manifest_sha256 omitted', () => {
    const m = { manifest_version: 1, manifest_sha256: SHA64, extra: [1, 2] };
    expect(canonicalManifestJson(m)).toBe(JSON.stringify({ manifest_version: 1, extra: [1, 2] }));
  });

  it('omits manifest_sha256 even when undefined and preserves other keys', () => {
    const m = { manifest_version: 1, manifest_sha256: undefined, tasks: { mined: [] } };
    expect(canonicalManifestJson(m)).toBe(JSON.stringify({ manifest_version: 1, tasks: { mined: [] } }));
  });

  it('is stable: removing manifest_sha256 and re-stringifying yields the same bytes', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 2, tasks: { mined: [{ key: 'k', source: 's' }] } });
    const { manifest_sha256: _sha, ...rest } = m;
    expect(canonicalManifestJson(m)).toBe(JSON.stringify(rest));
  });
});

describe('validateManifestSchema', () => {
  it('accepts a minimal valid manifest', () => {
    expect(validateManifestSchema(withSha({ ...validManifest }))).toEqual([]);
  });

  it('rejects a non-object manifest', () => {
    expect(validateManifestSchema(null)).toEqual(['manifest is not a JSON object']);
    expect(validateManifestSchema('str')).toEqual(['manifest is not a JSON object']);
    expect(validateManifestSchema([1, 2])).toEqual(['manifest is not a JSON object']);
  });

  it('rejects manifest_version other than 1', () => {
    const m = withSha({ ...validManifest, manifest_version: 2 });
    expect(validateManifestSchema(m)).toContain('manifest_version must be 1');
  });

  it('rejects a non-integer or negative holdout_epoch', () => {
    expect(validateManifestSchema(withSha({ ...validManifest, holdout_epoch: -1 }))).toContain('holdout_epoch must be a non-negative integer');
    expect(validateManifestSchema(withSha({ ...validManifest, holdout_epoch: 1.5 }))).toContain('holdout_epoch must be a non-negative integer');
  });

  it('rejects a malformed manifest_sha256', () => {
    expect(validateManifestSchema({ ...validManifest, manifest_sha256: 'short' })).toContain('manifest_sha256 must be 64 lowercase hex characters');
    expect(validateManifestSchema({ ...validManifest, manifest_sha256: 'G'.repeat(64) })).toContain('manifest_sha256 must be 64 lowercase hex characters');
  });

  it('rejects a non-object tasks', () => {
    expect(validateManifestSchema({ manifest_version: 1, holdout_epoch: 0, manifest_sha256: SHA64, tasks: [] }))
      .toContain('tasks must be an object');
  });

  it('rejects tasks.mined that is not a list of {key, source}', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: '', source: 'a.ts' }] } });
    expect(validateManifestSchema(m)).toContain('tasks.mined must be a list of {key, source}');
  });

  it('rejects an invalid tasks.write_test', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: 'c1', source: 'a.ts' }], write_test: [{ key: 'c1' }] } });
    expect(validateManifestSchema(m)).toContain('tasks.write_test must be a list of {key, source}');
  });

  it('rejects an invalid tasks.mutant', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: 'c1', source: 'a.ts' }], mutant: { generated_at_freeze: false, proposed_tiers: [2] } } });
    expect(validateManifestSchema(m)).toContain('tasks.mutant must be {generated_at_freeze: true, proposed_tiers: [1..8], max_per_source?: integer >= 1}');
  });

  it('rejects mutant.proposed_tiers out of range', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: 'c1', source: 'a.ts' }], mutant: { generated_at_freeze: true, proposed_tiers: [9] } } });
    expect(validateManifestSchema(m)).toContain('tasks.mutant must be {generated_at_freeze: true, proposed_tiers: [1..8], max_per_source?: integer >= 1}');
  });

  it('rejects an invalid calibration', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: 'c1', source: 'a.ts' }] }, calibration: { mined: [1, 2] } });
    expect(validateManifestSchema(m)).toContain('calibration must be {mined?: string[], write_test?: string[]}');
  });

  it('rejects evaluation_policy.deciding other than mutant/mined', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: 'c1', source: 'a.ts' }] }, evaluation_policy: { deciding: 'other' } });
    expect(validateManifestSchema(m)).toContain("evaluation_policy.deciding must be 'mutant' or 'mined'");
  });

  it('rejects deciding=mutant without tasks.mutant', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: 'c1', source: 'a.ts' }] }, evaluation_policy: { deciding: 'mutant' } });
    expect(validateManifestSchema(m)).toContain("evaluation_policy.deciding is 'mutant' but tasks.mutant is missing");
  });

  it('reports duplicate task keys across mined and write_test', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: 'dup', source: 'a.ts' }], write_test: [{ key: 'dup', source: 'b.ts' }] } });
    const errs = validateManifestSchema(m);
    expect(errs.some((e) => e.startsWith('duplicate task keys:'))).toBe(true);
  });

  it('accepts a manifest with mutant and calibration', () => {
    const m = withSha({
      manifest_version: 1, holdout_epoch: 1,
      tasks: { mined: [{ key: 'c1', source: 'a.ts' }], mutant: { generated_at_freeze: true, proposed_tiers: [1, 2], max_per_source: 5 } },
      calibration: { mined: ['c1'] },
      evaluation_policy: { deciding: 'mutant' },
    });
    expect(validateManifestSchema(m)).toEqual([]);
  });
});

describe('manifestSha256 / canonical roundtrip', () => {
  it('manifestSha256 matches sha256 of the canonical JSON', () => {
    const m = withSha({ manifest_version: 1, holdout_epoch: 0, tasks: { mined: [{ key: 'c1', source: 'a.ts' }] } });
    const expected = createHash('sha256').update(canonicalManifestJson(m)).digest('hex');
    expect(m.manifest_sha256).toBe(expected);
  });
});