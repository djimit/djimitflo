import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { E1RetrievalLabelSection } from './E1RetrievalLabelSection';
import { api, type E1LabelQueue } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';

const task = { task_id: '11111111-1111-1111-1111-111111111111', query: 'Fix the flaky panel retry', candidates: [
  { handle: 'h000000000001', title: 'Panel backoff', excerpt: 'Retry with jitter.' },
  { handle: 'h000000000002', title: 'Unrelated page', excerpt: 'Cooking notes.' },
] };
const queue = (t: E1LabelQueue['task'], labelled = 0): E1LabelQueue => ({ task: t, progress: { labelled, tasks: 40, target: 30, max_tasks: 40 } });

beforeEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never });
});

it('shows the query and blind candidates, posts the ticked handles, and counts n/30', async () => {
  vi.spyOn(api, 'getE1LabelQueue').mockResolvedValueOnce(queue(task)).mockResolvedValueOnce(queue(null, 1));
  const post = vi.spyOn(api, 'labelE1Retrieval').mockResolvedValue({ recorded: true });
  render(<E1RetrievalLabelSection />);
  expect(await screen.findByText('Fix the flaky panel retry')).toBeTruthy();
  expect(screen.getByLabelText('E1 labelling progress').textContent).toContain('0/30');
  expect(screen.getByRole('article', { name: 'Retrieval task to label' }).textContent).not.toMatch(/score|trust|qdrant|okf|djimitkb|approved|validated/i);
  expect((screen.getByRole('button', { name: /^Save 0 relevant/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Panel backoff' }));
  expect((screen.getByRole('button', { name: /^None relevant/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /^Save 1 relevant/ }));
  await waitFor(() => expect(post).toHaveBeenCalledWith(task.task_id, ['h000000000001'], expect.any(Number)));
  expect(await screen.findByText('Every task is labelled.')).toBeTruthy();
  expect(screen.getByLabelText('E1 labelling progress').textContent).toContain('1/30');
});

it("'None relevant' posts an empty list", async () => {
  vi.spyOn(api, 'getE1LabelQueue').mockResolvedValue(queue(task));
  const post = vi.spyOn(api, 'labelE1Retrieval').mockResolvedValue({ recorded: true });
  render(<E1RetrievalLabelSection />);
  fireEvent.click(await screen.findByRole('button', { name: /^None relevant/ }));
  await waitFor(() => expect(post).toHaveBeenCalledWith(task.task_id, [], expect.any(Number)));
});

it('a viewer sees the task but cannot answer', async () => {
  useAuthStore.setState({ user: { id: 'viewer-fixture', email: 'viewer@example.test', role: 'viewer' } as never });
  vi.spyOn(api, 'getE1LabelQueue').mockResolvedValue(queue(task));
  render(<E1RetrievalLabelSection />);
  await screen.findByText('Fix the flaky panel retry');
  expect((screen.getByRole('checkbox', { name: 'Panel backoff' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: /^None relevant/ }) as HTMLButtonElement).disabled).toBe(true);
});
