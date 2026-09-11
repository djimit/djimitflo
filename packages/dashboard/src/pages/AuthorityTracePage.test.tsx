import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthorityTracePage } from './AuthorityTracePage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('distinguishes an unavailable ledger from zero events and allows retry', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { message: 'Authority ledger unavailable', code: 'AUTHORITY_LEDGER_UNAVAILABLE' } }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ total: 3 }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [], total: 3 }) });
  vi.stubGlobal('fetch', fetch);
  render(<AuthorityTracePage />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Authority ledger unavailable');
  expect(screen.queryByText('Totaal events')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('3')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
