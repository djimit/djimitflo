import { band, type JudgmentDef } from '../judgment-service';

/**
 * S1 (System One review 2026-10-01): the goal risk class comes from keywords in the task text (CommandRiskClassifier), so a
 * test-only task for a file named *auth*, *mutation* or *approval* is 'high' — prod 01-10: all 8 oracle-lane makers went to
 * the human and needed a security reviewer. These atomic questions ask what the CHANGE touches, not which words appear.
 * Whether the artifact is a test file is a fact checked in code (`facts.testOnly`), never asked. SHADOW ONLY: the reason
 * records the keyword class next to jev's so the two can be compared on labelled outcomes before anything uses jev's.
 */
export const riskAtomic: JudgmentDef = {
  id: 'risk_atomic',
  questions: {
    changes_auth: { type: 'noul', instructions: 'Would the change described in `task` alter authentication, authorization, permissions or approval logic (not merely test it)?' },
    handles_secrets: { type: 'noul', instructions: 'Would the change described in `task` read, write, move or log secrets, tokens, keys or credentials?' },
    changes_deploy: { type: 'noul', instructions: 'Would the change described in `task` alter deployment, CI, infrastructure or production configuration?' },
    weakens_controls: { type: 'noul', instructions: 'Could the change described in `task` disable, bypass or weaken a security, policy or verification control?' },
  },
  decide(a, facts) {
    const hits = (['changes_auth', 'handles_secrets', 'changes_deploy', 'weakens_controls'] as const)
      .map((k) => [k, band(a[k]?.noul, 0.3, 0.7)] as const);
    const yes = hits.filter(([, d]) => d === 'yes').map(([k]) => k);
    const unsure = hits.filter(([, d]) => d === 'uncertain').map(([k]) => k);
    const testOnly = facts?.testOnly === true;
    const keyword = typeof facts?.keywordRisk === 'string' ? facts.keywordRisk : 'unknown';
    // jev's class: high if any control-touching answer is yes; uncertain if any is unclear; else low (medium when not test-only)
    const jev = yes.length ? 'high' : unsure.length ? 'uncertain' : testOnly ? 'low' : 'medium';
    const reason = `jev=${jev} keyword=${keyword}${testOnly ? ' test_only' : ''}${yes.length ? ` yes=${yes.join(',')}` : ''}${unsure.length ? ` unsure=${unsure.join(',')}` : ''}`;
    // decision = "is the change high risk?" so agreement with the keyword class is countable in the judgments table
    return { decision: jev === 'high' ? 'yes' : jev === 'uncertain' ? 'uncertain' : 'no', reason };
  },
};

export function riskAtomicState(task: { title: string; description: string; target?: string | null }): { task: { title: string; description: string; target: string | null } } {
  return { task: { title: task.title.slice(0, 300), description: task.description.slice(0, 4_000), target: task.target ?? null } };
}
