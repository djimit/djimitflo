import { useMemo, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { api, type RuntimeConfigEntry as Entry } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { ACTION_PERMISSIONS as P, needsText, useCan } from '../lib/permissions';

// DF-08: task areas in the order the server assigns them (runtime-config-view.ts CONFIG_AREAS)
const AREAS = ['models/routing', 'budgets/caps', 'schedulers', 'experiments', 'integrations', 'security/auth', 'knowledge', 'other'];
const SOURCE_LABEL: Record<Entry['source'], string> = { env: 'env', default: 'code default', unset: 'unset' };
const short = (sha: string) => sha.slice(0, 12);

const fetchConfig = () => api.getRuntimeConfig();
const skip = () => Promise.resolve(null);

export function ConfigurationPage() {
  const allowed = useCan(P.runtimeConfig);
  const { data, error } = useResource(allowed ? fetchConfig : skip);
  const entries: Entry[] | null = data?.entries ?? null;
  const build = data?.build ?? null;
  const [query, setQuery] = useState('');
  const [area, setArea] = useState('');
  const [overriddenOnly, setOverriddenOnly] = useState(false);
  const [raw, setRaw] = useState(false);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = new Map<string, Entry[]>(raw ? [] : AREAS.map((a) => [a, []]));
    for (const e of entries ?? []) {
      if (q && !e.name.toLowerCase().includes(q) && !(!e.masked && e.value !== null && e.value.toLowerCase().includes(q))) continue;
      // raw = exactly what process.env holds, grouped by prefix (the S3 view); task view adds registry keys and filters
      if (raw ? e.source !== 'env' : (area && e.area !== area) || (overriddenOnly && e.overridden !== true)) continue;
      const key = raw ? e.group : e.area;
      out.set(key, [...(out.get(key) ?? []), e]);
    }
    return [...out.entries()].filter(([, rows]) => rows.length > 0);
  }, [entries, query, raw, area, overriddenOnly]);

  const staleCommit = entries?.find((e) => e.name === 'DJIMITFLO_COMMIT_SHA' && e.stale);
  const areaCount = (a: string) => (entries ?? []).filter((e) => e.area === a).length;

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
      {build && (
        <p data-testid="running-build" className="text-sm">
          <span className="font-semibold">Running artifact: </span>
          {build.built_commit
            ? <><span className="font-mono">{short(build.built_commit)}</span>{build.build_time ? ` · built ${build.build_time}` : ''}{build.build_source ? ` · ${build.build_source}` : ''}</>
            : <span className="text-foreground-secondary">unknown (no baked build commit); DJIMITFLO_COMMIT_SHA from the environment is not proof of what runs</span>}
        </p>
      )}
      {staleCommit && build?.built_commit && (
        <p role="alert" className="text-sm text-status-warning">
          DJIMITFLO_COMMIT_SHA in the environment ({short(staleCommit.value ?? '')}) differs from the running build {short(build.built_commit)}: it is a leftover setting, not provenance for this artifact.
        </p>
      )}
      {entries && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input aria-label="Filter settings" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name or value…"
              className="flex-1 min-w-[12rem] rounded border border-border bg-background px-3 py-2 text-sm" />
            {!raw && (
              <>
                <select aria-label="Area" value={area} onChange={(e) => setArea(e.target.value)} className="rounded border border-border bg-background px-2 py-2 text-sm">
                  <option value="">All areas</option>
                  {AREAS.map((a) => <option key={a} value={a}>{a} ({areaCount(a)})</option>)}
                </select>
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" aria-label="Overridden only" checked={overriddenOnly} onChange={(e) => setOverriddenOnly(e.target.checked)} />
                  Overridden only
                </label>
              </>
            )}
            <div className="flex rounded border border-border text-sm" role="group" aria-label="View">
              <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)} className={`px-3 py-1 ${!raw ? 'bg-background-secondary font-semibold' : ''}`}>By task</button>
              <button type="button" aria-pressed={raw} onClick={() => setRaw(true)} className={`px-3 py-1 ${raw ? 'bg-background-secondary font-semibold' : ''}`}>Raw</button>
            </div>
          </div>
          <p className="text-xs text-foreground-tertiary">
            {entries.length} settings, {entries.filter((e) => e.source === 'env').length} set in the environment, {entries.filter((e) => e.overridden).length} overridden, {entries.filter((e) => e.masked).length} masked.
            {' '}Defaults are the documented code defaults (runbook); every value takes effect on restart: process.env is read when the container starts.
          </p>
          {groups.length === 0 ? <p className="text-sm text-foreground-secondary">No setting matches “{query}”.</p> : groups.map(([group, rows]) => (
            <section key={group} aria-label={group}>
              <h2 className="text-sm font-semibold mt-3 mb-1 text-foreground-tertiary">{group}</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  {!raw && (
                    <thead><tr className="text-left text-xs text-foreground-tertiary">
                      <th className="py-1 pr-4 font-normal">Name</th><th className="py-1 pr-4 font-normal">Value</th><th className="py-1 pr-4 font-normal">Source</th>
                      <th className="py-1 pr-4 font-normal">Default</th><th className="py-1 pr-4 font-normal">Override</th><th className="py-1 font-normal">Takes effect</th>
                    </tr></thead>
                  )}
                  <tbody>{rows.map((e) => (
                    <tr key={e.name} className="border-t border-border">
                      <td className="py-1 pr-4 font-mono whitespace-nowrap align-top">
                        {e.name}{e.stale && <span className="ml-2 rounded bg-status-warning/10 px-1 text-xs text-status-warning">stale</span>}
                      </td>
                      <td className={`py-1 pr-4 font-mono break-all align-top ${e.masked || e.value === null ? 'text-foreground-muted italic' : ''}`}>{e.value ?? '(unset)'}</td>
                      {!raw && (
                        <>
                          <td className="py-1 pr-4 whitespace-nowrap align-top">{SOURCE_LABEL[e.source]}</td>
                          <td className="py-1 pr-4 font-mono break-all align-top text-foreground-secondary">{e.default ?? '—'}</td>
                          <td className="py-1 pr-4 whitespace-nowrap align-top" title={e.overridden === null ? 'no comparable default (or masked)' : undefined}>
                            {e.overridden === true ? <span className="font-semibold">overridden</span> : e.overridden === false ? 'default' : '—'}
                          </td>
                          <td className="py-1 whitespace-nowrap align-top">{e.takes_effect}</td>
                        </>
                      )}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
