import { useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { ACTION_PERMISSIONS as P, needsText, useCan } from '../lib/permissions';

type Entry = { name: string; value: string; masked: boolean; group: string };

const fetchConfig = () => api.getRuntimeConfig();
const skip = () => Promise.resolve(null);

export function ConfigurationPage() {
  const allowed = useCan(P.runtimeConfig);
  const { data, error } = useResource(allowed ? fetchConfig : skip);
  const entries: Entry[] | null = data?.entries ?? null;
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = new Map<string, Entry[]>();
    for (const e of entries ?? []) {
      if (q && !e.name.toLowerCase().includes(q) && !(!e.masked && e.value.toLowerCase().includes(q))) continue;
      out.set(e.group, [...(out.get(e.group) ?? []), e]);
    }
    return [...out.entries()];
  }, [entries, query]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <SlidersHorizontal className="w-7 h-7" />
        <h1 className="text-2xl font-bold">Runtime configuration</h1>
      </div>
      <p className="text-sm text-foreground-secondary">
        What the running server is configured with (read-only). Secrets are masked and never shown. Changes still go through runtime.env with a backup and a restart.
      </p>
      {!allowed && <p role="alert" className="text-sm text-foreground-secondary">{needsText(P.runtimeConfig)} to view the running configuration.</p>}
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {allowed && !entries && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {entries && (
        <>
          <input aria-label="Filter settings" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or value…"
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm" />
          <p className="text-xs text-foreground-tertiary">{entries.length} settings, {entries.filter((e) => e.masked).length} masked.</p>
          {groups.length === 0 ? <p className="text-sm text-foreground-secondary">No setting matches “{query}”.</p> : groups.map(([group, rows]) => (
            <section key={group} aria-label={group}>
              <h2 className="text-sm font-semibold mt-3 mb-1 text-foreground-tertiary">{group}</h2>
              <table className="w-full text-sm">
                <tbody>{rows.map((e) => (
                  <tr key={e.name} className="border-t border-border">
                    <td className="py-1 pr-4 font-mono whitespace-nowrap align-top">{e.name}</td>
                    <td className={`py-1 font-mono break-all ${e.masked ? 'text-foreground-muted italic' : ''}`}>{e.value}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
