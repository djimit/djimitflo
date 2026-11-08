import type { FitnessContractRow, FitnessContractsReport, FitnessStatus } from '../lib/api';

/**
 * Fitness contracts (services/fitness-contracts.ts): which components can learn. A component learns only when an
 * independent executed outcome scores it against a fair comparison and a decision rule acts on it (closed_loop). Static
 * and read-only: the registry declares what the code does; nothing here changes behaviour.
 */
const STATUS_ORDER: FitnessStatus[] = ['closed_loop', 'measured_no_selection', 'circular', 'unmeasured'];
const STATUS_TEXT: Record<FitnessStatus, string> = {
  closed_loop: 'closed loop', measured_no_selection: 'measured, no selection', circular: 'circular outcome', unmeasured: 'unmeasured',
};
const STATUS_CLASS: Record<FitnessStatus, string> = {
  closed_loop: 'text-status-completed', measured_no_selection: 'text-foreground', circular: 'text-status-error', unmeasured: 'text-foreground-secondary',
};
const cmp = (c: FitnessContractRow) => (c.comparison.kind === 'none' ? 'none' : `${c.comparison.kind} (${c.comparison.ref ?? 'unnamed'})`);
const cost = (c: FitnessContractRow) => {
  const parts = ([['tokens', c.cost.tokens], ['kWh', c.cost.kwh], ['operator min', c.cost.operator_minutes]] as const).filter(([, s]) => s).map(([k]) => k);
  return parts.length ? parts.join(', ') : 'not recorded';
};

export function FitnessContractsCard({ data: r }: { data: FitnessContractsReport }) {
  const rows = [...r.contracts].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  return (
    <div className="space-y-2 text-sm" data-testid="fitness-contracts">
      <p>
        {r.total} components: {STATUS_ORDER.map((s) => `${r.by_status[s]} ${STATUS_TEXT[s]}`).join(' · ')}.
        {' '}Acting flags: {r.coverage.mapped} under a contract, {r.coverage.exempt} exempt (infrastructure or plumbing)
        {r.coverage.unmapped.length ? <span className="text-status-error">, {r.coverage.unmapped.length} without a contract: {r.coverage.unmapped.join(', ')}</span> : ', none without a contract'}.
      </p>
      {r.violations.length > 0 && <p className="text-status-error">Registry violations: {r.violations.join('; ')}</p>}
      <details>
        <summary className="cursor-pointer text-foreground-secondary">Contracts per component</summary>
        <div className="overflow-x-auto py-2">
          <table className="w-full">
            <thead><tr className="text-left text-foreground-tertiary">{['Component', 'Status', 'Outcome', 'Comparison', 'Decision rule', 'Cost recorded', 'Ledger'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.component} data-fitness={c.component} className="border-t border-border align-top">
                  <td className="font-medium" title={c.note}>{c.name}</td>
                  <td className={STATUS_CLASS[c.status]}>{STATUS_TEXT[c.status]}</td>
                  <td>{c.outcome.independence === 'none' ? 'none' : `${c.outcome.metric} (${c.outcome.independence})`}</td>
                  <td>{cmp(c)}</td>
                  <td>{c.decision_rule ?? 'none'}</td>
                  <td>{cost(c)}</td>
                  <td>{c.ledger_status ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="text-foreground-secondary">{r.note}</p>
    </div>
  );
}
