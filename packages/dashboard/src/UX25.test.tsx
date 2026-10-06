import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useDialog } from './components/ConfirmDialog';
import { Layout } from './components/Layout';

function Harness({ onResult }: { onResult: (v: unknown) => void }) {
  const dialog = useDialog();
  return (
    <>
      <button onClick={async () => onResult(await dialog.confirm('Complete loop?', 'This does not merge, push, or deploy.'))}>open confirm</button>
      <button onClick={async () => onResult(await dialog.ask({ title: 'Deny request', fields: [{ name: 'reason', label: 'Reason', options: ['Out of scope', 'Other'], required: true }, { name: 'detail', label: 'Details' }], confirmLabel: 'Deny' }))}>open deny</button>
      {dialog.element}
    </>
  );
}

it('UX-25: the confirm dialog opens with its message, moves focus inside, and returns false on cancel and focus to the trigger', async () => {
  const onResult = vi.fn();
  render(<Harness onResult={onResult} />);
  const trigger = screen.getByText('open confirm');
  trigger.focus(); fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toContain('does not merge, push, or deploy');
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.click(screen.getByText('Cancel'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it('UX-25: the action runs only on confirm', async () => {
  const onResult = vi.fn();
  render(<Harness onResult={onResult} />);
  fireEvent.click(screen.getByText('open confirm'));
  await screen.findByRole('dialog');
  expect(onResult).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Confirm'));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
});

it('UX-25: deny needs a reason — the button stays disabled until one is chosen; details are optional', async () => {
  const onResult = vi.fn();
  render(<Harness onResult={onResult} />);
  fireEvent.click(screen.getByText('open deny'));
  await screen.findByRole('dialog');
  const deny = screen.getByText('Deny') as HTMLButtonElement;
  expect(deny.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Out of scope' } });
  expect(deny.disabled).toBe(false);
  fireEvent.click(deny);
  await waitFor(() => expect(onResult).toHaveBeenCalledWith({ reason: 'Out of scope', detail: '' }));
});

it('UX-25: the layout has a skip link to the main content and marks the active nav link with aria-current', () => {
  render(<MemoryRouter initialEntries={['/decisions']}><Layout><p>page</p></Layout></MemoryRouter>);
  const skip = screen.getByText('Skip to content') as HTMLAnchorElement;
  expect(skip.getAttribute('href')).toBe('#main-content');
  expect(document.getElementById('main-content')).not.toBeNull();
  const current = document.querySelectorAll('a[aria-current="page"]');
  expect(current.length).toBeGreaterThan(0);
  expect(Array.from(current).every((a) => a.getAttribute('href') === '/decisions')).toBe(true);
});

it('UX-25: reduced motion is honoured globally and the status-warning token exists', () => {
  const css = readFileSync(join(__dirname, 'styles/index.css'), 'utf8');
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{[^}]*animation-duration/); // global, not only the Commons animations
  expect(css).toMatch(/--color-status-warning:/);
});

it('UX-25: no window.confirm / window.prompt left in the pages that decide things', () => {
  for (const f of ['pages/GoalsLoopsPage.tsx', 'pages/TaskDetailPage.tsx', 'components/ApprovalCard.tsx']) {
    expect(readFileSync(join(__dirname, f), 'utf8')).not.toMatch(/\bwindow\.(confirm|prompt)\(|(?<![.\w])(confirm|prompt)\(/);
  }
});
