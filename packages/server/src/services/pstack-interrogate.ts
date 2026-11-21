import { createHash } from 'node:crypto';

/**
 * Small, local adaptation of pstack's interrogate workflow. The upstream skill
 * is an agent workflow, so the existing checker remains the executor and gate
 * owner; this module only supplies the review invariant and provenance.
 */
export const PSTACK_INTERROGATE_SOURCE = 'https://github.com/cursor/plugins/tree/50b3a3234bf2e0293849a48784d72030948e44ee/pstack/skills/interrogate';
export const PSTACK_INTERROGATE_SOURCE_SHA = '3f3c2e9b8cf6b180dba9f32a4aff85e5691b09805232468e37a0ba45437a9984';
export const PSTACK_INTERROGATE_VERSION = 'cursor-pstack@50b3a323';

const POLICY = [
  'PSTACK INTERROGATE POLICY (version cursor-pstack@50b3a323): challenge the proposed change independently.',
  'A finding is actionable only when this run proves it against the actual diff or repository with a command, test, or observed output.',
  'For every retained finding, report the exact check, observed result, expected result, and why it violates the assignment.',
  'Do not apply fixes during review. Drop hypotheses that were not reproduced and say when there are no verified findings.',
].join('\n');

export const PSTACK_INTERROGATE_POLICY_HASH = createHash('sha256').update(POLICY).digest('hex');

export function pstackInterrogatePolicy(): string[] {
  return [PSTACK_INTERROGATE_SOURCE, `Policy sha256: ${PSTACK_INTERROGATE_POLICY_HASH}`, '', POLICY, ''];
}
