import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Button, DataTable, Section, StatusPill } from './index';

type Row = { name: string; runs: number; ok: number };
const rows: Row[] = [{ name: 'beta', runs: 4, ok: 1 }, { name: 'alpha', runs: 10, ok: 9 }];
const columns = [
  { key: 'name', label: 'Name', render: (r: Row) => r.name, sortValue: (r: Row) => r.name },
  { key: 'rate', label: 'Success', numeric: true, render: (r: Row) => `${Math.round((r.ok / r.runs) * 100)}%`, n: (r: Row) => r.runs, sortValue: (r: Row) => r.ok / r.runs },
];

it('UX-26: DataTable has a caption, scoped headers, an overflow wrapper and n next to a numeric value', () => {
  const { container } = render(<DataTable caption="Species success" columns={columns} rows={rows} rowKey={(r) => r.name} />);
  const table = screen.getByRole('table', { name: 'Species success' });
  expect(table.closest('div')?.className).toContain('overflow-x-auto');
  for (const th of within(table).getAllByRole('columnheader')) expect(th.getAttribute('scope')).toBe('col');
  expect(screen.getByText('n=10')).toBeTruthy();
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
});

it('UX-26: DataTable sorts on a sortable column and announces the direction', () => {
  render(<DataTable caption="Species success" columns={columns} rows={rows} rowKey={(r) => r.name} sortable />);
  fireEvent.click(screen.getByRole('button', { name: 'Name' }));
  const cells = () => screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
  expect(cells()).toEqual(['alpha', 'beta']);
  expect(screen.getByRole('columnheader', { name: /Name/ }).getAttribute('aria-sort')).toBe('ascending');
  fireEvent.click(screen.getByRole('button', { name: 'Name' }));
  expect(cells()).toEqual(['beta', 'alpha']);
});

it('UX-26: DataTable shows honest loading, error and empty states instead of an empty table', () => {
  const { rerender } = render(<DataTable caption="c" columns={columns} rows={[]} rowKey={(r) => r.name} loading />);
  expect(screen.getByText('Loading…')).toBeTruthy();
  rerender(<DataTable caption="c" columns={columns} rows={[]} rowKey={(r) => r.name} error="boom" />);
  expect(screen.getByRole('alert').textContent).toBe('boom');
  rerender(<DataTable caption="c" columns={columns} rows={[]} rowKey={(r) => r.name} empty="Nothing yet." />);
  expect(screen.getByText('Nothing yet.')).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});

it('UX-26: StatusPill always carries text, never colour alone', () => {
  render(<StatusPill tone="error" label="benched" />);
  expect(screen.getByText('benched')).toBeTruthy();
});

it('UX-26: a Button without the permission is disabled and says which permission it needs', () => {
  render(<Button needs="approve:task" onClick={() => { throw new Error('must not run'); }}>Approve</Button>);
  const b = screen.getByRole('button', { name: /Approve/ });
  expect((b as HTMLButtonElement).disabled).toBe(true);
  expect(b.getAttribute('title')).toBe('Needs approve:task');
  expect(screen.getByText('Needs approve:task')).toBeTruthy();
});

it('UX-26: Section renders a heading with a stable anchor id and labels the region with it', () => {
  render(<Section id="stalls" title="Silent stalls"><p>x</p></Section>);
  const region = screen.getByRole('region', { name: 'Silent stalls' });
  expect(region.querySelector('h2')?.id).toBe('stalls');
});
