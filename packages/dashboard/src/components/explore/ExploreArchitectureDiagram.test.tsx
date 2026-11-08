import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ExploreArchitectureDiagram } from './ExploreArchitectureDiagram';
import type { ExploreArchitectureDiagramProps } from '@djimitflo/shared';

const baseProps: ExploreArchitectureDiagramProps = {
  nodes: [
    { id: 'hub1', label: 'core', kind: 'hub' },
    { id: 'bridge1', label: 'linker', kind: 'bridge' },
    { id: 'normal1', label: 'worker', kind: 'normal' },
  ],
  edges: [
    { from: 'hub1', to: 'bridge1', surprising: false },
    { from: 'bridge1', to: 'normal1', surprising: true },
  ],
};

describe('ExploreArchitectureDiagram', () => {
  it('renders the empty-state message when there are no nodes', () => {
    render(<ExploreArchitectureDiagram nodes={[]} edges={[]} />);
    expect(screen.getByText('No architecture graph available for this repository.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders the heading, summary, and svg role when nodes are present', () => {
    render(<ExploreArchitectureDiagram {...baseProps} />);
    expect(screen.getByRole('heading', { name: 'Architecture' })).toBeTruthy();
    expect(screen.getByText(/Constellation view of code communities/)).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('renders a circle group per node with the truncated uppercase label and the full label', () => {
    render(<ExploreArchitectureDiagram {...baseProps} />);
    expect(screen.getByText('COR')).toBeTruthy();
    expect(screen.getByText('LIN')).toBeTruthy();
    expect(screen.getByText('WOR')).toBeTruthy();
    expect(screen.getByText('core')).toBeTruthy();
    expect(screen.getByText('linker')).toBeTruthy();
    expect(screen.getByText('worker')).toBeTruthy();
  });

  it('renders the legend with hub, bridge, and surprising connection entries', () => {
    render(<ExploreArchitectureDiagram {...baseProps} />);
    expect(screen.getByText('Hub node')).toBeTruthy();
    expect(screen.getByText('Bridge node')).toBeTruthy();
    expect(screen.getByText('Surprising connection')).toBeTruthy();
  });

  it('skips edges whose endpoints are not in the node set', () => {
    const { container } = render(
      <ExploreArchitectureDiagram
        nodes={[{ id: 'a', label: 'alpha', kind: 'normal' }]}
        edges={[
          { from: 'a', to: 'a' },
          { from: 'a', to: 'missing' },
          { from: 'missing', to: 'a' },
        ]}
      />,
    );
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBe(1);
    cleanup();
  });

  it('renders without crashing for a single node', () => {
    render(
      <ExploreArchitectureDiagram
        nodes={[{ id: 'solo', label: 'solo', kind: 'normal' }]}
        edges={[]}
      />,
    );
    expect(screen.getByText('SOL')).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
  });
});
