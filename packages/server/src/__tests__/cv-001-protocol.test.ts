import { expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * CV-001 step 2 (docs/research/cv-001/CV-001_PROTOCOL.md): the frozen pre-registration. The fingerprint covers everything
 * above the PREREG_SHA256 line; the body pins the treatment (aliases, vector digest, scale) and the decision rule.
 */
const CV001_PREREG_SHA256 = 'b6e1bb318557464e49d6cef8663c5730a1d56dc396c6e471324e556faf25771c';
const CV001_VECTOR_SHA256 = 'db1893a4d12936fefedb98d117955ef6cc7b1d59c661c1e44f6eee590cda4281';

it('the CV-001 protocol fingerprint matches its body, and the body pins the treatment and the decision rule', () => {
  const doc = readFileSync(join(__dirname, '../../../../docs/research/cv-001/CV-001_PROTOCOL.md'), 'utf8');
  const [body, tail] = doc.split('\n---\nPREREG_SHA256: ');
  expect(createHash('sha256').update(body).digest('hex')).toBe(tail.slice(0, 64));
  expect(tail.slice(0, 64)).toBe(CV001_PREREG_SHA256);
  expect(body).toContain(CV001_VECTOR_SHA256);
  expect(body).toContain('`qwen38-27b-cvd15`');
  expect(body).toContain('control-vector-scaled = /home/djimit/cv-001/qwen38-27b-discipline.gguf:1.5');
  for (const rule of ['clean success rate B − A ≥ +10 points and p < 0.05', 'plain success rate B − A ≥ −5 points',
    'degenerate rate B − A ≤ +2 points', 'timeout rate B ≤ timeout rate A']) expect(body).toContain(rule);
  expect(body).toContain('**60 seeded mutant-repair tasks**');
  expect(body).toContain('**2 repeats**');
  expect(body).toContain('**N = 6**');
});
