import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useResource } from './useResource';

afterEach(() => { vi.useRealTimers(); });

it('loads, exposes errors without dropping the last good data, and refreshes', async () => {
  let n = 0;
  const fetcher = vi.fn(async () => { n += 1; if (n === 2) throw new Error('HTTP 503'); return n; });
  const { result } = renderHook(() => useResource(fetcher));
  await waitFor(() => expect(result.current.data).toBe(1));
  expect(result.current.loading).toBe(false);
  await act(() => result.current.refresh());
  expect(result.current.error).toBe('HTTP 503');
  expect(result.current.data).toBe(1); // last good data stays visible
  await act(() => result.current.refresh());
  expect(result.current).toMatchObject({ data: 3, error: null });
});

it('drops a stale response that finishes after a newer one', async () => {
  let resolveFirst: (v: string) => void = () => undefined;
  const calls = [new Promise<string>((r) => { resolveFirst = r; }), Promise.resolve('new')];
  const fetcher = vi.fn(() => calls.shift()!);
  const { result } = renderHook(() => useResource(fetcher));
  await act(() => result.current.refresh());
  expect(result.current.data).toBe('new');
  await act(async () => { resolveFirst('old'); });
  expect(result.current.data).toBe('new');
});

it('polls at the given interval and stops on unmount', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => 'x');
  const { unmount } = renderHook(() => useResource(fetcher, { pollMs: 1000 }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(2000); });
  expect(fetcher).toHaveBeenCalledTimes(3);
  unmount();
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
