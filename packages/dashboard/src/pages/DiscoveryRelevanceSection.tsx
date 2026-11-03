import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RelevanceLabel, type RelevanceQueue } from '../lib/api';
import { ACTION_PERMISSIONS as P, useCan } from '../lib/permissions';
import { Button, Section } from '../components/ui';

const ANSWERS: Array<[RelevanceLabel, string]> = [['relevant', 'Relevant'], ['not_relevant', 'Not relevant'], ['unclear', 'Unclear']];
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/**
 * DI-001 (BENCHMARK §6.3): one blind card at a time — title, note, source and link only. The card never shows a jev verdict,
 * the filter result, the admission state, the sample tier or an earlier label (the server does not send them). Seconds per
 * label are measured from the moment the card is shown to the answer.
 */
export function DiscoveryRelevanceSection() {
  const [data, setData] = useState<RelevanceQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canLabel = useCan(P.labelDiscoveryRelevance);
  const shownAt = useRef(Date.now());
  const load = useCallback(async () => {
    try { setData(await api.getRelevanceQueue(1)); setError(null); shownAt.current = Date.now(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load relevance cards'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const card = data?.cards[0];
  const answer = async (label: RelevanceLabel) => {
    if (!card) return;
    setBusy(true);
    try { await api.labelDiscoveryRelevance(card.ref, card.pass, label, Math.min(3600, (Date.now() - shownAt.current) / 1000)); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Label failed'); }
    finally { setBusy(false); }
  };

  const t = data?.today; const p = data?.progress;
  return (
    <Section id="discovery-relevance" title="Discovery relevance labels (DI-001)" headingClassName="text-lg font-semibold mb-1">
      <p className="text-xs text-foreground-tertiary mb-2">
        Would this discovery plausibly inform a concrete Djimitflo change or gym experiment — an open problem it addresses, or a technique a lane or
        agent could try? <strong>Unclear</strong> is recorded and never counts as a negative. 30 minutes a day, no more.
      </p>
      {t && p && (
        <p className="text-sm text-foreground-secondary mb-2" aria-label="Today's labelling quota">
          Today {t.labels} label{t.labels === 1 ? '' : 's'} · {mmss(t.seconds)} of {mmss(t.target_seconds)}
          {t.median_seconds !== null && <> · median {Math.round(t.median_seconds)} s/label · about {t.est_cards_left} more today</>}
          {t.remaining_seconds === 0 && <strong> · today&apos;s 30 minutes are done</strong>}
          <span className="block text-xs text-foreground-tertiary">Evaluation sample {p.protected.labelled}/{p.protected.total} · re-labels {p.relabel.labelled}/{p.relabel.total} · additional {p.al.labelled}/{p.al.total}</span>
        </p>
      )}
      {error && <p role="alert" className="text-status-error text-sm">{error}</p>}
      {!data && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {data && !card && <p className="text-sm text-foreground-secondary">No card to label.</p>}
      {card && (
        <article className="rounded-lg border border-border p-3 space-y-2" aria-label="Discovery to label">
          <h3 className="font-medium">{card.title}</h3>
          {card.note && <p className="text-sm text-foreground-secondary whitespace-pre-wrap">{card.note}</p>}
          <p className="text-xs text-foreground-tertiary">{card.source} · <a className="underline" href={card.url} target="_blank" rel="noreferrer noopener">{card.url}</a></p>
          <div className="space-x-1">
            {ANSWERS.map(([label, text]) => (
              <Button key={label} needs={canLabel ? undefined : P.labelDiscoveryRelevance} disabled={busy} onClick={() => void answer(label)}>{text}</Button>
            ))}
          </div>
        </article>
      )}
    </Section>
  );
}
