import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConfigurationPage } from './ConfigurationPage';
import { api } from '../lib/api';

beforeEach(() => vi.restoreAllMocks());

it('groups settings, shows masked secrets as masked and filters by name or value', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockResolvedValue({ masked: 1, entries: [
    { name: 'LOOP_EVOLVE_SPECIES', value: 'remote@workstation/atomic', masked: false, group: 'LOOP' },
    { name: 'NVIDIA_API_KEY', value: 'set (40 chars)', masked: true, group: 'NVIDIA' },
  ] });
  render(<ConfigurationPage />);
  expect(await screen.findByText('remote@workstation/atomic')).toBeTruthy();
  expect(screen.getByText('set (40 chars)')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'workstation' } });
  expect(screen.queryByText('NVIDIA_API_KEY')).toBeNull();
  fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: '40 chars' } }); // masked values are not searchable
  expect(screen.getByText(/No setting matches/)).toBeTruthy();
});

it('shows the permission error', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockRejectedValue(new Error('Access denied'));
  render(<ConfigurationPage />);
  expect((await screen.findByRole('alert')).textContent).toBe('Access denied');
});
