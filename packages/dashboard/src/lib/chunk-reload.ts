// After a deploy the hashed lazy-route chunks of the previous build are gone; a tab opened before the deploy then fails
// with "Importing a module script failed" (Safari) / "Failed to fetch dynamically imported module" (Chromium).
// React.lazy caches the rejected import, so only a full reload (new index.html → new chunk names) recovers.
const CHUNK_ERROR = /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS/i;
const KEY = 'djimitflo:chunk-reload-at';
const MIN_INTERVAL_MS = 10_000;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return CHUNK_ERROR.test(message);
}

/** Reloads the page unless it already reloaded for this reason in the last 10 s (prevents a loop when the server is down). */
export function reloadOnceForChunkError(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession(), reload = () => window.location.reload(), now = Date.now()): boolean {
  try {
    const last = Number(storage?.getItem(KEY) ?? 0);
    if (now - last < MIN_INTERVAL_MS) return false;
    storage?.setItem(KEY, String(now));
  } catch { /* storage blocked: reload anyway, the interval guard is best-effort */ }
  reload();
  return true;
}

function safeSession(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}
