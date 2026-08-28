import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PipelineBuilderPage } from './PipelineBuilderPage';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children: React.ReactNode }) => <div data-testid="pipeline-canvas">{children}</div>,
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

describe('PipelineBuilderPage', () => {
  it('renders the pipeline builder heading', () => {
    render(<PipelineBuilderPage />);
    expect(screen.getByDisplayValue('Untitled Pipeline')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Goal/ })).toBeTruthy();
    expect(screen.getByTestId('pipeline-canvas')).toBeTruthy();
  });
});
