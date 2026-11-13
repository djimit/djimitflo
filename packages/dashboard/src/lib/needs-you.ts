import type { OperatorCockpit } from './api';

// Shared by the cockpit (headline + needs-you panel) and the Decisions inbox (summary): one count, one set of links.
type NY = NonNullable<OperatorCockpit['needs_you']>;
export type NeedsYouCounts = { [K in Exclude<keyof NY, 'system_requeue' | 'optional_labelling' | 'system' | 'dependency_tracked'>]?: number | null }
  & Partial<Pick<NY, 'system_requeue' | 'optional_labelling' | 'system' | 'dependency_tracked'>>;

/**
 * Human-only needs-you (operator 26-10): `items` are HUMAN_DECISION items and make the headline; ground-truth labelling
 * (D5, CAR, E1, DI-001) is optional with its own count; `info` and `system` are shown, never counted.
 */
export function needsYouItems(n: NeedsYouCounts) {
  // absent (older server) = 0; null (the server could not count it) = unknown
  const c = (v: number | null | undefined) => (v === undefined ? 0 : v);
  type Item = { label: string; count: number | null; href: string };
  const split = n.audit_batch !== undefined || n.flagged_prs !== undefined;
  const proposalsSystem = !!n.system?.proposals_auto_reviewed;
  const items: Item[] = [
    { label: 'approvals', count: c(n.approvals), href: '/decisions#approvals' },
    { label: 'requeue candidates', count: c(n.requeue), href: '/decisions#requeue' },
    { label: 'memory reviews', count: c(n.memory_review), href: '/decisions#memory' },
    ...(split ? [{ label: 'PRs in the weekly audit batch', count: c(n.audit_batch), href: '/decisions#audit-batch' },
      { label: 'flagged loop PRs', count: c(n.flagged_prs), href: '/decisions#draft-prs' }]
      : [{ label: 'open loop PRs', count: c(n.open_prs), href: '/decisions#draft-prs' }]),
    // stalls whose remedy is an operator act (a verdict, a reinstall): counted by the server since the truth audit 11-12
    { label: 'stalls that need you', count: c(n.operator_stalls), href: '/#stalls' },
    ...(n.dependency_tracked ? [{ label: 'Dependabot PRs the lane leaves to you', count: c(n.dependency_human), href: '/decisions#dependency-lane' }] : []),
    ...(proposalsSystem ? [] : [{ label: 'proposals awaiting approval', count: c(n.proposals), href: '/governance?tab=assurance' }]),
    { label: 'Commons join requests', count: c(n.join_requests), href: '/agent-commons' },
    { label: 'fleet shell requests', count: c(n.shell_requests), href: '/fleet' },
  ];
  // UX-6: 'approvals expiring' is a subset of 'approvals' and unsettled loop PRs include merged ones still settling — not double-counted
  const info: Item[] = [
    { label: 'approvals expiring within 1 h', count: c(n.approvals_expiring), href: '/decisions#approvals' },
    { label: 'loop PRs unsettled', count: c(n.draft_prs), href: '/decisions#draft-prs' },
  ];
  const ol = n.optional_labelling;
  const labelling: Item[] = [
    { label: 'pre-screen labels (D5)', count: ol ? ol.d5 : c(n.labels), href: '/decisions#prescreen' },
    ...(ol ? [{ label: 'CAR audits', count: ol.car, href: '/decisions#attribution-audit' }, { label: 'E1 retrieval labels', count: ol.e1, href: '/decisions#e1-retrieval-labels' },
      { label: 'DI-001 relevance labels', count: ol.di001, href: '/decisions#discovery-relevance' }] : []),
  ];
  const system: Item[] = [
    ...(n.system?.requeue_mode === 'on' ? [{ label: 'requeue rows the system will handle', count: n.system.requeue_will_handle, href: '/decisions#requeue' }] : []),
    { label: 'silent stalls', count: c(n.stalls), href: '/#stalls' },
    ...(proposalsSystem ? [{ label: 'proposals in panel review', count: c(n.proposals), href: '/governance?tab=assurance' }] : []),
  ];
  // the server's total counts human decisions only; older servers send no total
  const total = n.total ?? items.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const unknown = items.filter((item) => item.count === null);
  const labellingTotal = labelling.some((l) => l.count === null) ? null : labelling.reduce((a, l) => a + (l.count as number), 0);
  return { items, info, labelling, labellingTotal, system, total, unknown };
}
