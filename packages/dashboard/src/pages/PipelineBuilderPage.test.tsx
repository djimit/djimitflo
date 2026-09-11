import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PipelineBuilderPage } from './PipelineBuilderPage';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children, nodes }: { children: React.ReactNode; nodes: Array<{ id: string; data: { label: string } }> }) => <div data-testid="pipeline-canvas">{nodes.map(node => <span key={node.id}>{node.data.label} node</span>)}{children}</div>,
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
  BackgroundVariant: { Dots: 'dots' },
  addEdge: vi.fn(),
  applyNodeChanges: vi.fn(),
  applyEdgeChanges: vi.fn(),
}));

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

describe('PipelineBuilderPage', () => {
  it('renders the pipeline builder heading', () => {
    render(<PipelineBuilderPage />);
    expect(screen.getByDisplayValue('Untitled Pipeline')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Goal/ })).toBeTruthy();
    expect(screen.getByTestId('pipeline-canvas')).toBeTruthy();
  });

  it('saves a real draft and restores its name and nodes after remount', () => {
    const view = render(<PipelineBuilderPage />);
    fireEvent.change(screen.getByDisplayValue('Untitled Pipeline'), { target: { value: 'Fixture pipeline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Goal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft locally' }));
    expect(screen.getByRole('status').textContent).toBe('Draft saved in this browser.');
    view.unmount();
    render(<PipelineBuilderPage />);
    expect(screen.getByDisplayValue('Fixture pipeline')).toBeTruthy();
    expect(screen.getByText('Goal node')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Worker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft locally' }));
    const { nodes } = JSON.parse(localStorage.getItem('djimitflo_pipeline_draft')!);
    expect(new Set(nodes.map((node: { id: string }) => node.id)).size).toBe(2);
  });

  it('keeps corrupt saved data and exposes a storage failure instead of claiming success', () => {
    localStorage.setItem('djimitflo_pipeline_draft', '{broken');
    render(<PipelineBuilderPage />);
    expect(screen.getByRole('status').textContent).toContain('could not be loaded');
    expect(localStorage.getItem('djimitflo_pipeline_draft')).toBe('{broken');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota'); });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft locally' }));
    expect(screen.getByRole('status').textContent).toContain('could not be saved');
  });
});
