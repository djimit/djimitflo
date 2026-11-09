import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../lib/chunk-reload', () => ({
  isChunkLoadError: vi.fn((error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /ChunkLoadError/.test(message);
  }),
  reloadOnceForChunkError: vi.fn(),
}));

import { GlobalErrorBoundary } from './GlobalErrorBoundary';
import { isChunkLoadError, reloadOnceForChunkError } from '../lib/chunk-reload';

function Boom({ message }: { message: string }) {
  throw new Error(message);
}

describe('GlobalErrorBoundary', () => {
  const reloadSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isChunkLoadError).mockReset();
    vi.mocked(isChunkLoadError).mockImplementation((error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error ?? '');
      return /ChunkLoadError/.test(message);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload: reloadSpy },
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when no error is thrown', () => {
    render(
      <GlobalErrorBoundary>
        <div>healthy child</div>
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText('healthy child')).toBeTruthy();
    expect(screen.queryByText('Retry')).toBeNull();
  });

  it('renders the fallback UI with the error message when a child throws', () => {
    render(
      <GlobalErrorBoundary>
        <Boom message="kaboom" />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText('Something crashed')).toBeTruthy();
    expect(screen.getByText('kaboom')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('logs the caught error to console.error with the boundary tag', () => {
    render(
      <GlobalErrorBoundary>
        <Boom message="logged" />
      </GlobalErrorBoundary>,
    );
    const tagged = console.error.mock.calls.find((c) => c[0] === '[GlobalErrorBoundary]');
    expect(tagged).toBeTruthy();
  });

  it('does not call reloadOnceForChunkError for a non-chunk error', () => {
    render(
      <GlobalErrorBoundary>
        <Boom message="plain failure" />
      </GlobalErrorBoundary>,
    );
    expect(reloadOnceForChunkError).not.toHaveBeenCalled();
  });

  it('calls reloadOnceForChunkError when the caught error is a chunk-load error', () => {
    vi.mocked(isChunkLoadError).mockReturnValue(true);
    render(
      <GlobalErrorBoundary>
        <Boom message="dynamic import failed" />
      </GlobalErrorBoundary>,
    );
    expect(reloadOnceForChunkError).toHaveBeenCalledTimes(1);
  });

  it('shows the chunk-deploy hint and reloads the page on Retry for a chunk-load error', () => {
    vi.mocked(isChunkLoadError).mockReturnValue(true);
    render(
      <GlobalErrorBoundary>
        <Boom message="chunk gone" />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText('A new version was deployed. Retry reloads the page.')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('resets error state on Retry for a non-chunk error and renders children again', () => {
    vi.mocked(isChunkLoadError).mockReturnValue(false);
    const { rerender } = render(
      <GlobalErrorBoundary>
        <Boom message="transient" />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText('Something crashed')).toBeTruthy();
    rerender(
      <GlobalErrorBoundary>
        <div>recovered child</div>
      </GlobalErrorBoundary>,
    );
    fireEvent.click(screen.getByText('Retry'));
    expect(screen.getByText('recovered child')).toBeTruthy();
    expect(screen.queryByText('Something crashed')).toBeNull();
  });

  it('falls back to "Unknown error" when the thrown value has no message', () => {
    function ThrowNull() {
      throw null;
    }
    render(
      <GlobalErrorBoundary>
        <ThrowNull />
      </GlobalErrorBoundary>,
    );
    expect(screen.getByText('Unknown error')).toBeTruthy();
  });
});
