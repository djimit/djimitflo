import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { DiscoveryRelevanceSection } from './DiscoveryRelevanceSection';
import { api, type RelevanceQueue } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';

const queue = (cards: RelevanceQueue['cards'], labels = 0): RelevanceQueue => ({
  cards,
  progress: { protected: { labelled: labels, total: 340 }, relabel: { labelled: 0, total: 68, due: 0 }, al: { labelled: 0, total: 150 } },
  today: { day: '2026-10-14', labels, seconds: labels * 50, median_seconds: labels ? 50 : null, target_seconds: 1800, remaining_seconds: 1800 - labels * 50, est_cards_left: labels ? 34 : null },
});
const card = { ref: 'arxiv:2510.17932', pass: 'relabel' as const, title: 'Self-repairing agents', note: 'We study agents that fix their own tests.', source: 'djimitflo-scout', url: 'https://arxiv.org/abs/2510.17932' };

beforeEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never });
});

it('shows a blind card (title, note, source, link — not the pass) and posts the answer with its seconds', async () => {
  vi.spyOn(api, 'getRelevanceQueue').mockResolvedValueOnce(queue([card])).mockResolvedValueOnce(queue([], 1));
  const post = vi.spyOn(api, 'labelDiscoveryRelevance').mockResolvedValue({ recorded: true });
  const { container } = render(<DiscoveryRelevanceSection />);
  expect(await screen.findByText('Self-repairing agents')).toBeTruthy();
  expect(screen.getByText('We study agents that fix their own tests.')).toBeTruthy();
  expect(screen.getByRole('link', { name: card.url }).getAttribute('href')).toBe(card.url);
  // a re-label card looks exactly like a first one: nothing names the pass, a tier or an earlier answer
  expect(container.textContent).not.toMatch(/relabel|re-label this|previous|earlier|protected|jev|admitted/i);
  fireEvent.click(screen.getByRole('button', { name: 'Not relevant' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith(card.ref, 'relabel', 'not_relevant', expect.any(Number)));
  expect(await screen.findByText('No card to label.')).toBeTruthy();
  expect(screen.getByLabelText("Today's labelling quota").textContent).toContain('0:50 of 30:00');
});

it('a viewer sees the card but cannot answer', async () => {
  useAuthStore.setState({ user: { id: 'viewer-fixture', email: 'viewer@example.test', role: 'viewer' } as never });
  vi.spyOn(api, 'getRelevanceQueue').mockResolvedValue(queue([card]));
  render(<DiscoveryRelevanceSection />);
  await screen.findByText('Self-repairing agents');
  for (const name of [/^Relevant/, /^Not relevant/, /^Unclear/]) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
});
