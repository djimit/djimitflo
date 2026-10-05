import fs from 'fs';
import path from 'path';
import { expect, it } from 'vitest';
import { EVOLUTION_FLAGS } from '../services/evolution-evidence';

it('RX-2: every evolution flag the evidence endpoint reports is documented in the operations runbook', () => {
  const runbook = fs.readFileSync(path.resolve(__dirname, '../../../../docs/runbooks/self-improvement-loop-operations.md'), 'utf8');
  expect(EVOLUTION_FLAGS.map((f) => f.name).filter((name) => !runbook.includes(`\`${name}\``))).toEqual([]);
});
