import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type E1LabelQueue } from '../lib/api';
import { ACTION_PERMISSIONS as P, useCan } from '../lib/permissions';
import { Button, Section } from '../components/ui';

/**
 * E1 (docs/research/eco/E1-RRF_PROTOCOL.md): one blind retrieval task at a time — a real logged query and the frozen
 * candidates in a per-task shuffled order, title and excerpt only. The server never sends source, score or trust tier.
 * Tick every candidate that helps answer the query, or answer "None relevant". One label per task.
 */
export function E1RetrievalLabelSection() {
  const [data, setData] = useState<E1LabelQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const canLabel = useCan(P.labelE1Retrieval);
  const shownAt = useRef(Date.now());
  const load = useCallback(async () => {
    try { setData(await api.getE1LabelQueue()); setTicked(new Set()); setError(null); shownAt.current = Date.now(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load retrieval tasks'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const task = data?.task;
  const submit = async (relevant: string[]) => {
    if (!task) return;
    setBusy(true);
    try { await api.labelE1Retrieval(task.task_id, relevant, Math.min(3600, (Date.now() - shownAt.current) / 1000)); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Label failed'); }
    finally { setBusy(false); }
  };
  const toggle = (handle: string) => setTicked((prev) => { const next = new Set(prev); if (next.has(handle)) next.delete(handle); else next.add(handle); return next; });

  const p = data?.progress;
  return (
    <Section id="e1-retrieval-labels" title="Retrieval relevance labels (E1)" headingClassName="text-lg font-semibold mb-1">
      <p className="text-xs text-foreground-tertiary mb-2">
        Which of these retrieved items would help someone working on this request? Tick every relevant one, or answer <strong>None relevant</strong>.
        Items are shuffled and shown without where they came from or how they scored.
      </p>
      {p && <p className="text-sm text-foreground-secondary mb-2" aria-label="E1 labelling progress">{p.labelled}/{p.target} labelled · {p.tasks} tasks</p>}
      {error && <p role="alert" className="text-status-error text-sm">{error}</p>}
      {!data && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {data && !task && <p className="text-sm text-foreground-secondary">{p?.tasks ? 'Every task is labelled.' : 'No tasks yet — an operator with manage:config generates them.'}</p>}
      {task && (
        <article className="rounded-lg border border-border p-3 space-y-2" aria-label="Retrieval task to label">
          <h3 className="font-medium whitespace-pre-wrap">{task.query}</h3>
          <ul className="space-y-2">
            {task.candidates.map((c) => (
              <li key={c.handle}>
                <label className="flex gap-2 items-start">
                  <input type="checkbox" checked={ticked.has(c.handle)} disabled={busy || !canLabel} onChange={() => toggle(c.handle)} aria-label={c.title || c.excerpt.slice(0, 60)} />
                  <span>
                    {c.title && <span className="font-medium block">{c.title}</span>}
                    <span className="text-sm text-foreground-secondary whitespace-pre-wrap">{c.excerpt}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="space-x-1">
            <Button needs={canLabel ? undefined : P.labelE1Retrieval} disabled={busy || ticked.size === 0} onClick={() => void submit([...ticked])}>Save {ticked.size} relevant</Button>
            <Button needs={canLabel ? undefined : P.labelE1Retrieval} disabled={busy || ticked.size > 0} onClick={() => void submit([])}>None relevant</Button>
          </div>
        </article>
      )}
    </Section>
  );
}
