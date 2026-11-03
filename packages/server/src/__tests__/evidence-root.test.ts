import { expect, it } from 'vitest';
import { resolveEvidenceRoot } from '../services/loop-service';

it('keeps worker evidence next to the database unless LOOP_EVIDENCE_ROOT says otherwise (prod 2026-09-24: lost on deploy)', () => {
  expect(resolveEvidenceRoot({ DB_PATH: '/data/djimitflo.sqlite' })).toBe('/data/agent-evidence/agentic-control-loop-fleet');
  expect(resolveEvidenceRoot({ DB_PATH: '/data/djimitflo.sqlite', LOOP_EVIDENCE_ROOT: '/x/ev' })).toBe('/x/ev');
  expect(resolveEvidenceRoot({ DB_PATH: 'relative.sqlite' })).toMatch(/\.data\/agent-evidence\/agentic-control-loop-fleet$/);
  expect(resolveEvidenceRoot({})).toMatch(/\.data\/agent-evidence\/agentic-control-loop-fleet$/);
});
