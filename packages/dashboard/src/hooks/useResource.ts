import { useCallback, useEffect, useRef, useState } from 'react';

export interface Resource<T> { data: T | null; error: string | null; loading: boolean; refresh: () => Promise<void> }

/**
 * W6: one load/error/refresh/poll pattern for read pages instead of a hand-rolled useEffect per page. Stale responses
 * (a slow first call finishing after a newer one) are dropped; an error keeps the last good data visible.
 * `fetcher` should be stable (module function or useCallback) — it is the only dependency.
 */
export function useResource<T>(fetcher: () => Promise<T>, { pollMs }: { pollMs?: number } = {}): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const value = await fetcher();
      if (mine === seq.current) { setData(value); setError(null); }
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void refresh();
    if (!pollMs) return () => { seq.current += 1; };
    const timer = setInterval(() => void refresh(), pollMs);
    return () => { clearInterval(timer); seq.current += 1; };
  }, [refresh, pollMs]);

  return { data, error, loading, refresh };
}
