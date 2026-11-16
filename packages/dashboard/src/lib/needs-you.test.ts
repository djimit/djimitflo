import { describe, expect, it } from 'vitest';
import { needsYouItems } from './needs-you';
import type { NeedsYouCounts } from './needs-you';

describe('needsYouItems', () => {
  it('returns the baseline human-decision items for an older server that sends only legacy counts', () => {
    const r = needsYouItems({ approvals: 2, requeue: 1, memory_review: 3, open_prs: 4, operator_stalls: 0, proposals: 5, join_requests: 6, shell_requests: 7 });
    const labels = r.items.map((i) => i.label);
    expect(labels).toEqual([
      'approvals',
      'requeue candidates',
      'memory reviews',
      'open loop PRs',
      'stalls that need you',
      'proposals awaiting approval',
      'Commons join requests',
      'fleet shell requests',
    ]);
    expect(r.items.map((i) => i.count)).toEqual([2, 1, 3, 4, 0, 5, 6, 7]);
    expect(r.total).toBe(28);
  });

  it('treats absent counts as 0 (older server omits a field)', () => {
    const r = needsYouItems({});
    expect(r.items.map((i) => i.count)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.total).toBe(0);
  });

  it('treats null counts as unknown and surfaces them in `unknown` (not as 0)', () => {
    const r = needsYouItems({ approvals: null, requeue: 2, memory_review: null, open_prs: 1 });
    const unknownLabels = r.unknown.map((u) => u.label);
    expect(unknownLabels).toEqual(['approvals', 'memory reviews']);
    expect(r.total).toBe(3);
  });

  it('switches to the split PR view (audit batch + flagged PRs) when either split field is present', () => {
    const split = needsYouItems({ audit_batch: 3, flagged_prs: 2 });
    const splitLabels = split.items.map((i) => i.label);
    expect(splitLabels).toContain('PRs in the weekly audit batch');
    expect(splitLabels).toContain('flagged loop PRs');
    expect(splitLabels).not.toContain('open loop PRs');
    expect(split.total).toBe(5);
  });

  it('keeps the legacy open-PRs view when no split field is present', () => {
    const r = needsYouItems({ open_prs: 9 });
    const labels = r.items.map((i) => i.label);
    expect(labels).toContain('open loop PRs');
    expect(labels).not.toContain('PRs in the weekly audit batch');
    expect(labels).not.toContain('flagged loop PRs');
  });

  it('adds a dependency-lane item only when dependency_tracked is true', () => {
    const off = needsYouItems({ dependency_tracked: false, dependency_human: 4 });
    expect(off.items.map((i) => i.label)).not.toContain('Dependabot PRs the lane leaves to you');

    const on = needsYouItems({ dependency_tracked: true, dependency_human: 4 });
    expect(on.items.map((i) => i.label)).toContain('Dependabot PRs the lane leaves to you');
    expect(on.items.find((i) => i.label === 'Dependabot PRs the lane leaves to you')?.count).toBe(4);
    expect(on.total).toBe(4);
  });

  it('hides the proposals-awaiting-approval item when the system auto-reviews proposals, and shows the panel-review system item instead', () => {
    const r = needsYouItems({ proposals: 7, system: { requeue_will_handle: 0, requeue_mode: null, proposals_auto_reviewed: true } });
    expect(r.items.map((i) => i.label)).not.toContain('proposals awaiting approval');
    expect(r.system.map((i) => i.label)).toContain('proposals in panel review');
    expect(r.system.find((i) => i.label === 'proposals in panel review')?.count).toBe(7);
  });

  it('exposes approvals-expiring and unsettled-PR info items that are never added to the total', () => {
    const r = needsYouItems({ approvals: 5, approvals_expiring: 2, draft_prs: 3 });
    expect(r.info.map((i) => i.label)).toEqual(['approvals expiring within 1 h', 'loop PRs unsettled']);
    expect(r.info.map((i) => i.count)).toEqual([2, 3]);
    expect(r.total).toBe(5);
  });

  it('uses the legacy single labelling item when optional_labelling is absent', () => {
    const r = needsYouItems({ labels: 4 });
    expect(r.labelling.map((l) => l.label)).toEqual(['pre-screen labels (D5)']);
    expect(r.labelling[0].count).toBe(4);
    expect(r.labellingTotal).toBe(4);
  });

  it('expands optional labelling into D5, CAR, E1 and DI-001 items with a summed total', () => {
    const r = needsYouItems({ optional_labelling: { d5: 1, car: 2, e1: 3, di001: 4, total: 99 } });
    expect(r.labelling.map((l) => l.label)).toEqual([
      'pre-screen labels (D5)',
      'CAR audits',
      'E1 retrieval labels',
      'DI-001 relevance labels',
    ]);
    expect(r.labelling.map((l) => l.count)).toEqual([1, 2, 3, 4]);
    expect(r.labellingTotal).toBe(10);
  });

  it('reports labellingTotal as null when any optional-labelling count is null (UNKNOWN is not zero)', () => {
    const r = needsYouItems({ optional_labelling: { d5: 1, car: null, e1: 3, di001: 4, total: null } });
    expect(r.labellingTotal).toBeNull();
  });

  it('shows the requeue-will-handle system item only when requeue_mode is "on"', () => {
    const off = needsYouItems({ system: { requeue_will_handle: 5, requeue_mode: 'off', proposals_auto_reviewed: false } });
    expect(off.system.map((i) => i.label)).not.toContain('requeue rows the system will handle');

    const on = needsYouItems({ system: { requeue_will_handle: 5, requeue_mode: 'on', proposals_auto_reviewed: false } });
    expect(on.system.map((i) => i.label)).toContain('requeue rows the system will handle');
    expect(on.system.find((i) => i.label === 'requeue rows the system will handle')?.count).toBe(5);
    expect(on.total).toBe(0);
  });

  it('adds the auto-merge system PR item only when system_prs is present', () => {
    const absent = needsYouItems({});
    expect(absent.system.map((i) => i.label)).not.toContain('loop PRs the auto-merge lane is handling');

    const present = needsYouItems({ system_prs: 6 });
    expect(present.system.map((i) => i.label)).toContain('loop PRs the auto-merge lane is handling');
    expect(present.system.find((i) => i.label === 'loop PRs the auto-merge lane is handling')?.count).toBe(6);
  });

  it('always includes silent stalls in the system list, counted by the server not the headline', () => {
    const r = needsYouItems({ stalls: 8 });
    expect(r.system.map((i) => i.label)).toContain('silent stalls');
    expect(r.system.find((i) => i.label === 'silent stalls')?.count).toBe(8);
    expect(r.total).toBe(0);
  });

  it('prefers the server-provided total over the item sum when present', () => {
    const r = needsYouItems({ approvals: 1, requeue: 1, memory_review: 1, open_prs: 1, operator_stalls: 1, proposals: 1, join_requests: 1, shell_requests: 1, total: 42 });
    expect(r.total).toBe(42);
  });

  it('treats a server-provided null total as unknown (falls back to item sum)', () => {
    const r = needsYouItems({ approvals: 2, total: null });
    expect(r.total).toBe(2);
  });

  it('every item carries an href into the decisions/shell routes', () => {
    const r = needsYouItems({ approvals: 1, audit_batch: 1, flagged_prs: 1, dependency_tracked: true, dependency_human: 1, optional_labelling: { d5: 1, car: 1, e1: 1, di001: 1, total: 4 }, system: { requeue_will_handle: 1, requeue_mode: 'on', proposals_auto_reviewed: true }, system_prs: 1, stalls: 1 });
    for (const group of [r.items, r.info, r.labelling, r.system] as const) {
      for (const item of group) {
        expect(typeof item.href).toBe('string');
        expect(item.href.length).toBeGreaterThan(0);
        expect(item.href.startsWith('/')).toBe(true);
      }
    }
  });

  it('accepts a fully populated NeedsYouCounts without type errors', () => {
    const n: NeedsYouCounts = {
      approvals: 1, requeue: 1, labels: 1, memory_review: 1, proposals: 1, draft_prs: 1, open_prs: 1,
      stalls: 1, approvals_expiring: 1, operator_stalls: 1, join_requests: 1, shell_requests: 1,
      shared_subjects: 1, total: 1, audit_batch: 1, flagged_prs: 1, system_prs: 1,
      dependency_human: 1, dependency_tracked: true,
      optional_labelling: { d5: 1, car: 1, e1: 1, di001: 1, total: 4 },
      system: { requeue_will_handle: 1, requeue_mode: 'on', proposals_auto_reviewed: false },
    };
    const r = needsYouItems(n);
    expect(r.total).toBe(1);
  });
});
