import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ExplainerFleetPage } from './ExplainerFleetPage';

vi.mock('../../lib/api', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path.includes('/fleet/status')) return { total_repositories: 1, active_repositories: 1, pending_jobs: 0, running_jobs: 0, completed_today: 0, failed_today: 0, paused: false, budget: { llm_calls_used: 0, llm_calls_remaining: 100, github_api_calls_used: 0, github_api_calls_remaining: 5000, git_ops_used: 0, git_ops_remaining: 200 } };
      if (path.includes('/health-drift')) return { drift_count: 0, drift: [] };
      if (path.includes('/review-queue')) return { count: 0, items: [] };
      if (path.includes('/calibration')) return { ratings: 0 };
      return { repositories: [{ id: 'r1', full_name: 'djimit/djimitflo', priority_tier: 1, language: 'TypeScript', license: 'MIT', stargazers_count: 0, open_issues_count: 0, last_commit_at: null, last_commit_sha: null, is_active: 1, last_generated: '2026-10-01 18:36:22', openmythos_score: 90, health_score: 80, fresh: false, age_days: 42 }] };
    }),
    post: vi.fn(async () => ({})),
  },
}));

afterEach(cleanup);

it('truth audit: the last-generated date uses the dashboard date format (day first), not the browser US M/D', async () => {
  render(<ExplainerFleetPage />);
  expect(await screen.findByText('djimit/djimitflo')).toBeTruthy();
  expect(screen.getByText(/^01\/10\/2026, \d\d:\d\d$/)).toBeTruthy();
  expect(screen.queryByText('10/1/2026')).toBeNull();
});
