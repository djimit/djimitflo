import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConfigurationPage } from './ConfigurationPage';
import { api, type RuntimeConfigEntry } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';

// UX-4: actions are gated by role; these cases exercise them as an admin
beforeEach(() => { useAuthStore.setState({ user: { id: 'admin-fixture', email: 'admin@example.test', role: 'admin' } as never }); });

beforeEach(() => vi.restoreAllMocks());
// nav cut: the page also holds the runtime-tuned parameters section (former /self-driving); disabled here unless a case says otherwise
beforeEach(() => { vi.spyOn(api, 'getMetaStats').mockResolvedValue({ enabled: false }); });

const entry = (e: Partial<RuntimeConfigEntry> & { name: string }): RuntimeConfigEntry => ({
  value: null, masked: false, group: e.name.split('_')[0], area: 'other', source: 'env', default: null, overridden: null, takes_effect: 'restart', ...e,
});
const BUILD = { commit: 'a'.repeat(40), built_commit: 'b'.repeat(40), build_source: 'deploy-vps', build_time: '2026-10-23T10:00:00Z', instance_id: null, commit_matches_build: false };
const fixture = () => ({ masked: 1, build: BUILD, entries: [
  entry({ name: 'LOOP_EVOLVE_SPECIES', value: 'remote@workstation/atomic', area: 'experiments', default: 'unset', overridden: true }),
  entry({ name: 'NVIDIA_API_KEY', value: 'set (40 chars)', masked: true, area: 'models/routing' }),
  entry({ name: 'LOOP_BANDIT_MAX_SHARE', value: '0.1', area: 'experiments', default: '0.1', overridden: false }),
  entry({ name: 'DREAM_PROMOTION_ALPHA', value: null, source: 'default', area: 'experiments', default: '0.05', overridden: false }),
  entry({ name: 'OLLAMA_THROTTLE_AT', value: '0.9', area: 'budgets/caps', default: '0.7', overridden: true }),
  entry({ name: 'DJIMITFLO_COMMIT_SHA', value: 'a'.repeat(40), stale: true }),
] });

it('groups settings, shows masked secrets as masked and filters by name or value', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockResolvedValue(fixture());
  render(<ConfigurationPage />);
  expect(await screen.findByText('remote@workstation/atomic')).toBeTruthy();
  expect(screen.getByText('set')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: 'workstation' } });
  expect(screen.queryByText('NVIDIA_API_KEY')).toBeNull();
  fireEvent.change(screen.getByLabelText('Filter settings'), { target: { value: '40 chars' } }); // masked values are not searchable
  expect(screen.getByText(/No setting matches/)).toBeTruthy();
});

it('shows source, default, override and activation per key, filtered by task area and overridden-only', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockResolvedValue(fixture());
  render(<ConfigurationPage />);
  const row = (name: string) => (screen.getByText(name).closest('tr') as HTMLElement);
  await screen.findByText('OLLAMA_THROTTLE_AT');
  expect(within(row('OLLAMA_THROTTLE_AT')).getByText('overridden')).toBeTruthy();
  expect(within(row('OLLAMA_THROTTLE_AT')).getByText('0.7')).toBeTruthy();
  expect(within(row('OLLAMA_THROTTLE_AT')).getByText('restart')).toBeTruthy();
  expect(within(row('DREAM_PROMOTION_ALPHA')).getByText('code default')).toBeTruthy();
  expect(within(row('DREAM_PROMOTION_ALPHA')).getByText('(unset)')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'experiments' } });
  expect(screen.queryByText('OLLAMA_THROTTLE_AT')).toBeNull();
  expect(screen.getByText('LOOP_BANDIT_MAX_SHARE')).toBeTruthy();

  fireEvent.click(screen.getByLabelText('Overridden only'));
  expect(screen.queryByText('LOOP_BANDIT_MAX_SHARE')).toBeNull();
  expect(screen.queryByText('DREAM_PROMOTION_ALPHA')).toBeNull();
  expect(screen.getByText('LOOP_EVOLVE_SPECIES')).toBeTruthy();
});

it('shows the running build as provenance and flags a stale DJIMITFLO_COMMIT_SHA', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockResolvedValue(fixture());
  render(<ConfigurationPage />);
  expect((await screen.findByTestId('running-build')).textContent).toContain('b'.repeat(12));
  expect(screen.getByRole('alert').textContent).toMatch(/DJIMITFLO_COMMIT_SHA.*aaaaaaaaaaaa.*differs from the running build bbbbbbbbbbbb/);
  expect(within(screen.getByText('DJIMITFLO_COMMIT_SHA').closest('tr') as HTMLElement).getByText('stale')).toBeTruthy();
});

it('keeps the raw view grouped by prefix', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockResolvedValue(fixture());
  render(<ConfigurationPage />);
  await screen.findByText('OLLAMA_THROTTLE_AT');
  fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
  expect(screen.getByRole('region', { name: 'LOOP' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'OLLAMA' })).toBeTruthy();
  expect(screen.queryByText('code default')).toBeNull();
});

it('shows the permission error', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockRejectedValue(new Error('Access denied'));
  render(<ConfigurationPage />);
  expect((await screen.findByRole('alert')).textContent).toBe('Access denied');
});

// Dashboard truth audit 2026-11-12 (/configuration): masked values leaked their length, mode flags had no accepted
// values, and at 390 px `break-all` wrapped every value one character per line.
it('shows a masked value as "set" only, the accepted values of a mode flag, and breaks only long tokens', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockResolvedValue({ masked: 1, build: BUILD, entries: [
    entry({ name: 'NVIDIA_API_KEY', value: 'set (40 chars)', masked: true }),
    entry({ name: 'ASG_MODE', value: 'shadow', default: 'off', overridden: true, accepted: ['off', 'shadow', 'on'] }),
    entry({ name: 'LONG_LIST', value: 'x'.repeat(80) }),
  ] });
  render(<ConfigurationPage />);
  const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
  await screen.findByText('ASG_MODE');
  expect(within(row('NVIDIA_API_KEY')).getByText('set')).toBeTruthy();
  expect(screen.queryByText(/40 chars/)).toBeNull();
  expect(screen.getByRole('columnheader', { name: 'Accepted' })).toBeTruthy();
  expect(within(row('ASG_MODE')).getByText('off · shadow · on')).toBeTruthy();
  const short = within(row('ASG_MODE')).getByText('shadow', { selector: 'td' });
  expect(short.className).not.toMatch(/break-all/);
  expect(within(row('LONG_LIST')).getByText('x'.repeat(80)).className).toMatch(/break-all/);
});

it('nav cut: holds the runtime-tuned parameters of the former /self-driving page', async () => {
  vi.spyOn(api, 'getRuntimeConfig').mockResolvedValue(fixture());
  render(<ConfigurationPage />);
  expect(await screen.findByRole('heading', { name: 'Runtime-tuned parameters' })).toBeTruthy();
  expect(await screen.findByText(/Meta orchestration is disabled on this instance/)).toBeTruthy();
  expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Configuration']);
});
