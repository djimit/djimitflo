import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PipelineBuilderPage } from './PipelineBuilderPage';

describe('PipelineBuilderPage', () => {
  it('renders the editable pipeline and node palette', () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    render(<PipelineBuilderPage />);

    expect(screen.getByDisplayValue('Untitled Pipeline')).toBeTruthy();
    expect(screen.getByRole('button', { name: /goal/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /export/i })).toBeTruthy();
  });
});
