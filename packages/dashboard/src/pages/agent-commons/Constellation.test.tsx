import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ConstellationNode, ConstellationEdge } from './model';
import { CONSTELLATION_LEGEND, ConstellationEdgeTable, Constellation } from './Constellation';

const node = (over: Partial<ConstellationNode> = {}): ConstellationNode => ({
  id: 'a', name: 'Alpha', x: 10, y: 20, present: true, lured: false, threads: 1, hue: 120, ...over,
});
const edge = (over: Partial<ConstellationEdge> = {}): ConstellationEdge => ({
  from: 'a', to: 'b', x1: 10, y1: 20, x2: 30, y2: 40, count: 1, stage: 'asked', ...over,
});

describe('CONSTELLATION_LEGEND', () => {
  it('documents co-participation semantics', () => {
    expect(CONSTELLATION_LEGEND).toContain('co-participation');
    expect(CONSTELLATION_LEGEND).toContain('not proof');
  });
});

describe('ConstellationEdgeTable', () => {
  it('renders the pair count in the summary and one row per edge', () => {
    render(<ConstellationEdgeTable nodes={[node(), node({ id: 'b', name: 'Beta' })]} edges={[edge(), edge({ from: 'a', to: 'c', count: 2, stage: 'learned' })]} />);
    expect(screen.getByText(/Same-thread pairs as a table \(2\)/)).toBeTruthy();
    expect(screen.getAllByTestId('constellation-pair')).toHaveLength(2);
    expect(screen.getAllByText('Alpha')).toHaveLength(2);
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('Reflection')).toBeTruthy();
  });

  it('falls back to the id when a node is missing and pluralises the title', () => {
    render(<ConstellationEdgeTable nodes={[node()]} edges={[edge({ from: 'a', to: 'zzz', count: 1, stage: 'responding' })]} />);
    expect(screen.getByText('zzz')).toBeTruthy();
    expect(screen.getByText('In conversation')).toBeTruthy();
  });

  it('renders an empty note when there are no edges', () => {
    render(<ConstellationEdgeTable nodes={[]} edges={[]} />);
    expect(screen.getByText('No two agents share a thread yet.')).toBeTruthy();
  });
});

describe('Constellation', () => {
  it('renders an svg with an accessible label that includes the legend and counts', () => {
    render(<Constellation nodes={[node(), node({ id: 'b', name: 'Beta' })]} edges={[edge()]} focus={null} highlight={[]} onSelect={vi.fn()} />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('aria-label')).toContain('2 agents');
    expect(svg.getAttribute('aria-label')).toContain('1 same-thread pairs');
    expect(svg.getAttribute('aria-label')).toContain(CONSTELLATION_LEGEND);
  });

  it('renders a still-empty placeholder when there are no nodes', () => {
    render(<Constellation nodes={[]} edges={[]} focus={null} highlight={[]} onSelect={vi.fn()} />);
    expect(screen.getByText('still empty')).toBeTruthy();
  });

  it('draws a line per edge with the stage color, width from the count and a singular/plural pair title', () => {
    const { container, rerender } = render(<Constellation nodes={[node(), node({ id: 'b', name: 'Beta' })]} edges={[edge({ count: 9, stage: 'learned' })]} focus={null} highlight={[]} onSelect={vi.fn()} />);
    const line = container.querySelector('line');
    expect(line).not.toBeNull();
    expect(line?.getAttribute('stroke')).toBe('rgb(34 197 94)');
    expect(line?.getAttribute('stroke-width')).toBe('6');
    expect(line?.querySelector('title')?.textContent).toBe('Alpha and Beta: same thread, 9 shared threads, furthest stage Reflection');
    rerender(<Constellation nodes={[node(), node({ id: 'b', name: 'Beta' })]} edges={[edge({ count: 1, stage: 'asked' })]} focus={null} highlight={[]} onSelect={vi.fn()} />);
    expect(container.querySelector('line title')?.textContent).toBe('Alpha and Beta: same thread, 1 shared thread, furthest stage Curious');
  });

  it('dims non-focus edges and highlights co-participation pairs in the highlight set', () => {
    const { container } = render(
      <Constellation
        nodes={[node(), node({ id: 'b', name: 'Beta' }), node({ id: 'c', name: 'Gamma', x: 50, y: 60 })]}
        edges={[edge({ from: 'a', to: 'b', stage: 'responding' }), edge({ from: 'a', to: 'c', stage: 'asked' })]}
        focus="a"
        highlight={['a', 'b']}
        onSelect={vi.fn()}
      />,
    );
    const lines = container.querySelectorAll('line');
    expect(lines).toHaveLength(2);
    expect(lines[0].getAttribute('stroke-opacity')).toBe('0.95');
    expect(lines[0].getAttribute('stroke-dasharray')).toBe('6 6');
    expect(lines[1].getAttribute('stroke-opacity')).toBe('0.4');
    expect(lines[1].getAttribute('stroke-dasharray')).toBeNull();
  });

  it('dims edges not touching the focus when a focus is set', () => {
    const { container } = render(
      <Constellation
        nodes={[node(), node({ id: 'b', name: 'Beta' }), node({ id: 'c', name: 'Gamma', x: 50, y: 60 }), node({ id: 'd', name: 'Delta', x: 70, y: 80 })]}
        edges={[edge({ from: 'c', to: 'd', stage: 'learned' })]}
        focus="a"
        highlight={[]}
        onSelect={vi.fn()}
      />,
    );
    const line = container.querySelector('line');
    expect(line?.getAttribute('stroke-opacity')).toBe('0.1');
  });

  it('renders present and lured nodes differently and calls onSelect on click', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <Constellation
        nodes={[node({ present: true }), node({ id: 'b', name: 'Beta', x: 30, y: 40, present: false, lured: true, threads: 0 })]}
        edges={[]}
        focus={null}
        highlight={[]}
        onSelect={onSelect}
      />,
    );
    const groups = container.querySelectorAll('g');
    expect(groups).toHaveLength(2);
    const presentCircles = groups[0].querySelectorAll('circle');
    expect(presentCircles).toHaveLength(2);
    const luredCircles = groups[1].querySelectorAll('circle');
    expect(luredCircles).toHaveLength(1);
    expect(luredCircles[0].getAttribute('stroke')).toBe('rgb(217 70 239)');
    expect(luredCircles[0].getAttribute('fill')).toBe('none');
    fireEvent.click(groups[0]);
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('truncates long node names and dims non-focus nodes', () => {
    const { container } = render(
      <Constellation
        nodes={[node({ id: 'a', name: 'A'.repeat(20) }), node({ id: 'b', name: 'Beta', x: 30, y: 40 })]}
        edges={[]}
        focus="a"
        highlight={[]}
        onSelect={vi.fn()}
      />,
    );
    const texts = container.querySelectorAll('text');
    expect(texts[0].textContent).toBe('A'.repeat(13) + '...');
    const groups = container.querySelectorAll('g');
    expect(groups[0].getAttribute('opacity')).toBe('1');
    expect(groups[1].getAttribute('opacity')).toBe('0.35');
  });

  it('scales the filled node radius by its thread count up to a cap', () => {
    const { container } = render(
      <Constellation nodes={[node({ id: 'a', name: 'Alpha', threads: 0, present: false }), node({ id: 'b', name: 'Beta', x: 30, y: 40, threads: 9, lured: false, present: false })]} edges={[]} focus={null} highlight={[]} onSelect={vi.fn()} />,
    );
    const groups = container.querySelectorAll('g');
    expect(groups[0].querySelector('circle')?.getAttribute('r')).toBe('8');
    expect(groups[1].querySelector('circle')?.getAttribute('r')).toBe('14');
  });
});
