/**
 * UXE-03: synthetic fixtures for the role-matrix route smoke (`RouteSmoke.test.tsx`). One entry per page in the
 * `App.tsx` route table. `primary` is the call the page is about: its server permission is the page's permission, and
 * `NAV_PERMISSIONS` must mirror it. `shows` is a fixture value the page must render as visible text.
 * Synthetic values only (R7): no hosts, tokens or personal data.
 */
import { FIXTURES as A } from './route-fixtures-a';
import { FIXTURES as B } from './route-fixtures-b';
import { FIXTURES as C } from './route-fixtures-c';

export interface PageFixture {
  primary: string | null; // 'GET /api/…' (no query); null = the page loads nothing on mount
  responses: Record<string, unknown>; // body per 'METHOD /api/path'; anything else answers 503
  shows: string | null;
}

/** Calls the layout makes on every page (organizations, pending approvals, task and agent store). */
export const SHELL_RESPONSES: Record<string, unknown> = {
  'GET /api/organizations': [],
  'GET /api/approvals': { approvals: [] },
  'GET /api/tasks': { tasks: [], total: 0 },
  'GET /api/agents': { agents: [] },
};

// pages that load nothing until the operator presses a button
const NO_MOUNT_DATA: Record<string, PageFixture> = Object.fromEntries(['/agi-reasoning', '/predictive-analytics', '/self-healing', '/pipeline-builder']
  .map((path) => [path, { primary: null, responses: {}, shows: null }]));

export const PAGE_FIXTURES: Record<string, PageFixture> = { ...A, ...B, ...C, ...NO_MOUNT_DATA };
