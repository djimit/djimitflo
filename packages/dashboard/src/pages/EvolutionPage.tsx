import type { ReactNode } from 'react';
import { Dna } from 'lucide-react';
import { api, type EvolutionEvidence, type GateState } from '../lib/api';
import { useResource } from '../hooks/useResource';
import { LoadErrorNotice } from '../components/LoadErrorNotice';

const fetchEvidence = () => api.getEvolutionEvidence();
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`);
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d));
const ci = (c: [number, number] | null | undefined, asPct = false) => (c ? `[${asPct ? pct(c[0]) : num(c[0])}, ${asPct ? pct(c[1]) : num(c[1])}]` : '—');
const GATE_TEXT: Record<GateState, string> = { green: 'text-status-completed', red: 'text-status-error', unknown: 'text-foreground-secondary' };
const GATE_NAME: Record<'A' | 'B' | 'C' | 'D', string> = { A: 'evaluator can see', B: 'gold labels exist', C: 'human queue drains', D: 'forecasters are decision-grade' };

/** UX-9: the evolution loop's evidence in one read-only page — Realm Gates first, then each measured source with its n. */
export function EvolutionPage() {
  const { data, error } = useResource(fetchEvidence, { pollMs: 60_000 });
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Dna className="w-7 h-7" />
        <h1 className="text-2xl font-bold">Evolution</h1>
      </div>
      <p className="text-sm text-foreground-secondary">
        What the evolution loop has measured: trials, gym difficulty, model choice, forecasters, the checker oracle and Commons yield. Read-only; shadow values never acted.
      </p>
      {error && <LoadErrorNotice failed={[`evolution evidence: ${error}`]} />}
      {!data && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {data && <EvolutionBody data={data} />}
    </div>
  );
}

const Shadow = () => <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-xs text-foreground-tertiary">shadow — did not act</span>;
function Section({ title, shadow, children }: { title: string; shadow?: boolean; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{title}{shadow && <Shadow />}</h2>
      {children}
    </section>
  );
}
const Empty = ({ text }: { text: string }) => <p className="text-sm text-foreground-secondary">{text}</p>;
function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-foreground-tertiary">{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border">{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function EvolutionBody({ data }: { data: EvolutionEvidence }) {
  const gymByTier = new Map<string, { kind: string; tier: number | null; ok: number; n: number }>();
  for (const g of data.gym) {
    if (g.status === 'discarded' || g.status === null) continue; // not scored
    const key = `${g.kind}:${g.tier ?? '-'}`;
    const row = gymByTier.get(key) ?? { kind: g.kind, tier: g.tier, ok: 0, n: 0 };
    row.n += g.n; if (g.status === 'success') row.ok += g.n;
    gymByTier.set(key, row);
  }
  const o = data.oracle;
  const f = data.forecasts_v2;
  const c = data.commons;
  return (
    <div className="space-y-8">
      <section aria-labelledby="gates">
        <h2 id="gates" className="text-lg font-semibold mb-2">Realm Gates</h2>
        <ul className="grid gap-3 md:grid-cols-2">
          {(['A', 'B', 'C', 'D'] as const).map((k) => (
            <li key={k} className="rounded-lg border border-border p-3">
              <p className="font-medium">Gate {k} — {GATE_NAME[k]}: <span className={GATE_TEXT[data.gates[k].state]}>{data.gates[k].state}</span></p>
              <p className="text-sm text-foreground-secondary">{data.gates[k].reason}</p>
            </li>
          ))}
        </ul>
      </section>

      <Section title="Genome trials">
        <p className="text-sm text-foreground-secondary">Holdouts: mined {data.genomes.holdout.mined ?? '—'}, mutant {data.genomes.holdout.mutant ?? '—'} tasks.</p>
        {/* §16 step 7: how often each current frozen epoch has been used; a reuse risk asks the operator for a fresh epoch */}
        {data.holdout_exposure?.epochs.filter((e) => e.current).map((e) => (
          <p key={`${e.holdout}-${e.epoch}`} className={`text-sm ${e.reuse_risk ? 'text-status-error' : 'text-foreground-secondary'}`}>
            {`${e.holdout} epoch ${e.epoch}: ${e.candidates} candidates (limit ${data.holdout_exposure.limit})${e.reuse_risk ? ' — reuse risk, introduce a fresh epoch' : ''}`}; {e.decisions} decisions, {e.evaluations} evaluations on {e.tasks} tasks.
          </p>
        ))}
        {!data.trials.recent.length ? <Empty text="No settled trial has diagnostics yet." /> : (
          <Table head={['Trial', 'Tiers', 'Deciding tasks', 'Parent failures', 'Wins / losses', 'p', 'Power', 'State']}
            rows={data.trials.recent.map((t) => [t.trial_id, t.tier_set, `n = ${t.deciding_n}`, t.f_parent_failures, `${t.b} / ${t.c}`, num(t.p, 3), pct(t.power_q8_l05), t.state])} />
        )}
      </Section>

      <Section title="Gym by kind and tier">
        {!gymByTier.size ? <Empty text="No gym attempts in the window." /> : (
          <Table head={['Kind', 'Tier', 'Scored', 'Pass rate']}
            rows={[...gymByTier.values()].map((g) => [g.kind, g.tier ?? '—', `n = ${g.n}`, pct(g.ok / g.n)])} />
        )}
      </Section>

      <Section title={`Model selector (mode ${data.models.mode})`} shadow={data.models.mode !== 'enforce'}>
        {Object.entries(data.models.would_pick).map(([consumer, pick]) => <p key={consumer} className="text-sm">{consumer}: would pick {pick ?? '—'}</p>)}
        {!data.models.rows.length ? <Empty text="No model calls recorded yet." /> : (
          <Table head={['Consumer', 'Model', 'Calls', 'Usable', 'Agree', 'Median latency', 'Cost weight']}
            rows={data.models.rows.map((m) => [m.consumer, m.model, `n = ${m.n}`, pct(m.ok_rate), pct(m.agree_rate), m.median_latency_ms === null ? '—' : `${(m.median_latency_ms / 1000).toFixed(1)} s`, m.cost_weight])} />
        )}
      </Section>

      <Section title="Forecasters (scoring V2)" shadow>
        {!f.scored ? <Empty text="No forecaster scored yet." /> : (
          <p className="text-sm">n = {f.scored} forecasters: {f.decision_grade} decision-grade ({f.decision_grade_skilled} with skill CI above 0), {f.insufficient} insufficient.</p>
        )}
      </Section>

      <Section title="Checker oracle (jev second opinion)" shadow>
        {!o.n ? <Empty text="No checker second opinions yet." /> : (
          <div className="text-sm space-y-1">
            <p>n = {o.n} makers · kappa {num(o.kappa)} {ci(o.kappa_ci)} · agreement {pct(o.agreement.all)} (confidence ≥ 0.6: {pct(o.agreement.conf_ge_06)}, below: {pct(o.agreement.conf_lt_06)})</p>
            <p>Against the run outcome (n = {o.accuracy.n}): jev {pct(o.accuracy.jev)}, checker {pct(o.accuracy.checker)} · kappa(jev, outcome) {num(o.kappa_jev_outcome)} {ci(o.kappa_jev_outcome_ci)}</p>
            <p>Eligible to enforce: {o.enforce_eligible ? 'yes' : 'no'}</p>
          </div>
        )}
      </Section>

      <Section title="Commons yield">
        {!c.n ? <Empty text="No Commons child attempted yet." /> : (
          <p className="text-sm">n = {c.n} children, {c.k} verified ({pct(c.rate)} {ci(c.ci, true)}) vs refinement base rate {pct(c.base_rate)} {ci(c.base_ci, true)} (n = {c.base_n}) — {c.verdict}</p>
        )}
      </Section>

      <Section title="Production outcomes the species is not to blame for">
        {!data.outcomes_tagged.some((t) => t.tagged > 0) ? <Empty text="No tagged production outcomes yet." /> : null}
        {data.outcomes_tagged.length > 0 && (
          <Table head={['Maker skill', 'Outcomes', 'Failures', 'Tagged (infra / no change / evolve loser)', 'Share']}
            rows={data.outcomes_tagged.map((t) => [t.skill, `n = ${t.total}`, t.failures, t.tagged, pct(t.share)])} />
        )}
      </Section>

      <Section title="Loop draft PRs">
        <p className="text-sm">n = {data.drafts.unsettled_open_or_recent} open or merged under 14 days · median age {data.drafts.age_days_p50 ?? '—'} d · oldest {data.drafts.age_days_max ?? '—'} d · settled {data.merge.merge_outcomes ?? 0}</p>
      </Section>

      {data.auto_merge && data.auto_merge.mode !== 'off' && (
        <Section title={`Test-only auto-merge (mode ${data.auto_merge.mode})`} shadow={data.auto_merge.mode === 'shadow'}>
          <p className="text-sm">
            Class <strong className={data.auto_merge.class.state === 'revoked' ? 'text-status-error' : undefined}>{data.auto_merge.class.state}</strong>
            {data.auto_merge.class.state === 'revoked' && <> — {data.auto_merge.class.reason ?? 'no reason recorded'}; an operator re-enables it</>}
          </p>
          <p className="text-sm">n = {data.auto_merge.counts.merged} merged ({data.auto_merge.counts.merged_24h} in 24 h, cap {data.auto_merge.max_per_day}) · {data.auto_merge.counts.would_merge} would merge (shadow) · {data.auto_merge.counts.audit_samples_open} audit sample(s) open · {data.auto_merge.counts.ineligible} ineligible</p>
        </Section>
      )}

      <Section title="Flags">
        {!data.flags.length ? <Empty text="No evolution flags reported." /> : (
          <Table head={['Flag', 'Value', 'Acting']} rows={data.flags.map((fl) => [fl.name, fl.value ?? 'unset', fl.acting ? 'yes' : 'no'])} />
        )}
      </Section>
    </div>
  );
}
