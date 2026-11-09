import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoopRunList } from './LoopRunList';
import type { LoopRunRecord } from '../../lib/api';

type Props = React.ComponentProps<typeof LoopRunList>;

const run = (over: Partial<LoopRunRecord> = {}): LoopRunRecord => ({
  id: 'run-1',
  goal_id: null,
  loop_name: 'Doc Drift',
  mode: 'closed',
  status: 'running',
  repository_path: null,
  state_file: null,
  findings: [],
  plan: {},
  gates: [],
  next_actions: [],
  metadata: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  completed_at: null,
  ...over,
});

function renderList(over: Partial<Props> = {}) {
  const props: Props = {
    runs: [],
    loading: false,
    selectedRun: null,
    actionId: null,
    setSelectedRunId: vi.fn<(id: string) => void>(),
    ...over,
  };
  return { ...render(<LoopRunList {...props} />), props };
}

describe('LoopRunList', () => {
  it('shows the loading message while loading', () => {
    renderList({ loading: true });
    expect(screen.getByText('Loading loop runs...')).toBeTruthy();
  });

  it('shows the empty message when there are no runs and not loading', () => {
    renderList({ runs: [] });
    expect(screen.getByText('No loop runs yet.')).toBeTruthy();
  });

  it('renders each run with its name, id, mode and counts', () => {
    renderList({
      runs: [
        run({ id: 'r1', loop_name: 'Alpha', mode: 'open', findings: [{}, {}] as never, gates: [{} as never] }),
        run({ id: 'r2', loop_name: 'Beta', mode: 'closed', status: 'completed' }),
      ],
    });
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('r1')).toBeTruthy();
    expect(screen.getByText('r2')).toBeTruthy();
    expect(screen.getByText('open')).toBeTruthy();
    expect(screen.getByText('closed')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
  });

  it('renders the first next action when present and omits the line when empty', () => {
    renderList({
      runs: [
        run({ id: 'r1', loop_name: 'A', next_actions: ['Review finding', 'Then verify'] }),
        run({ id: 'r2', loop_name: 'B', next_actions: [] }),
      ],
    });
    expect(screen.getByText('Review finding')).toBeTruthy();
    expect(screen.queryByText('Then verify')).toBeNull();
  });

  it('calls setSelectedRunId with the run id on click', () => {
    const { props } = renderList({ runs: [run({ id: 'r1', loop_name: 'A' })] });
    fireEvent.click(screen.getByText('A'));
    expect(props.setSelectedRunId).toHaveBeenCalledWith('r1');
  });

  it('disables all run buttons while an action is in flight', () => {
    renderList({ runs: [run({ id: 'r1', loop_name: 'A' })], actionId: 'r1' });
    const btn = screen.getByText('A').closest('button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('highlights the selected run with the accent border class', () => {
    const selected = run({ id: 'r1', loop_name: 'A' });
    renderList({ runs: [selected], selectedRun: selected });
    const btn = screen.getByText('A').closest('button') as HTMLButtonElement;
    expect(btn.className).toContain('border-accent/40');
  });

  it('renders SmallStat labels Findings, Gates and Mode for each run', () => {
    renderList({ runs: [run({ id: 'r1', loop_name: 'A' })] });
    expect(screen.getByText('Findings')).toBeTruthy();
    expect(screen.getByText('Gates')).toBeTruthy();
    expect(screen.getByText('Mode')).toBeTruthy();
  });
});
