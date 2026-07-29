export const LOOP_CATALOG = [
  {
    name: 'doc-drift-and-small-fix-loop',
    title: 'Doc Drift And Small Fix',
    description: 'Find documentation drift and bounded low-risk fixes, then prepare maker/checker worktrees on demand.',
    mode: 'closed',
  },
  {
    name: 'repo-maintenance-loop',
    title: 'Repo Maintenance',
    description: 'Find small maintenance gaps such as missing deterministic scripts, stale TODOs and repository hygiene issues.',
    mode: 'closed',
  },
  {
    name: 'skill-quality-loop',
    title: 'Skill Quality',
    description: 'Validate loop skills for required governance metadata before they can orchestrate workers.',
    mode: 'closed',
  },
  {
    name: 'mcp-connector-validation-loop',
    title: 'MCP Connector Validation',
    description: 'Check MCP connector inventory and permission metadata without invoking connector tools.',
    mode: 'closed',
  },
  {
    name: 'security-regression-loop',
    title: 'Security Regression',
    description: 'Find security-sensitive regression gaps and force maker/checker/security-checker review before completion.',
    mode: 'closed',
  },
  {
    name: 'okf-synchronization-loop',
    title: 'OKF Synchronization',
    description: 'Find drift between durable OKF knowledge folders and generated indexes/state files.',
    mode: 'closed',
  },
  {
    name: 'overwatch-policy-drift-loop',
    title: 'Overwatch Policy Drift',
    description: 'Detect drift in approval policies, risk gates and autonomy boundaries without applying policy changes.',
    mode: 'closed',
  },
] as const;

export type LoopName = typeof LOOP_CATALOG[number]['name'];

export function isCanonicalLoopName(value: string): value is LoopName {
  return LOOP_CATALOG.some((loop) => loop.name === value);
}

export function canonicalWorkerRole(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}
