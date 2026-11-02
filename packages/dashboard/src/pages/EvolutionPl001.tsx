import type { Pl001Evidence, Pl001Paired } from '../lib/api';

/**
 * PL-001 (services/pl-001.ts): one read-only card — the procedure and its digest, the frozen task set, pairs done / target,
 * per-arm outcomes, the verdict state, the procedure's lifecycle state and links to the runs. A value the server did not
 * compute reads "unknown" / "not computed", never 0.
 */
const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'unknown' : `${Math.round(v * 100)} %`);
const short = (h: string | null | undefined) => (h ? `${h.slice(0, 12)}…` : 'unknown');
const STATUS: Record<Pl001Evidence['status'], string> = {
  not_frozen: 'not frozen', invalid_manifest: 'manifest invalid — no analysis', waiting_start: 'frozen, waiting for the start condition',
  collecting: 'collecting pairs', exhausted: 'no attempt left to serve; the verdict waits for day 14', stopped: 'stopped',
};

function paired(label: string, p: Pl001Paired | null) {
  if (!p) return `${label}: no completed pair yet`;
  return `${label}: ${p.n_pairs} pairs — B only ${p.b_only_B}, A only ${p.c_only_A}, both ${p.both_verified}, neither ${p.neither}; verified A ${pct(p.rate_A)}, B ${pct(p.rate_B)}; one-sided exact McNemar p ${p.p_one_sided === null ? 'not computed' : p.p_one_sided.toPrecision(3)}`;
}

export function Pl001Card({ data: d }: { data: Pl001Evidence }) {
  const m = d.manifest;
  const life = d.procedure.lifecycle;
  return (
    <div className="space-y-2 text-sm" data-testid="pl-001-card">
      <p>
        Procedure <span className="font-mono">{d.procedure.id}</span> v{d.procedure.version ?? 'unknown'} · lines digest <span className="font-mono">{short(d.procedure.lines_sha256)}</span>
        {d.procedure.digest_matches === false ? <span className="text-status-error"> — not the protocol digest {short(d.procedure.protocol_lines_sha256)}</span> : d.procedure.digest_matches ? ' (protocol digest)' : ' (procedure not seeded yet)'}
        {' '}· mode {d.mode} · {STATUS[d.status]}
      </p>
      <p>
        Lifecycle: <strong>{d.procedure.status ?? 'unknown'}</strong>
        {life?.verdict ? ` — ${life.verdict} on ${life.decided_at?.slice(0, 10) ?? 'unknown date'}: ${life.reason ?? ''}` : ' — no verdict recorded'}
        {life?.negative_evidence ? ` · ${life.negative_evidence}` : ''}
      </p>
      {d.freeze_refused && <p className="text-status-error">Freeze refused ({d.freeze_refused.at.slice(0, 16)}): {d.freeze_refused.reason}</p>}
      {m ? (
        <p>
          Frozen set: {m.tasks} tasks ({m.by_kind.mutant} mutant, {m.by_kind.mined} mined; tiers {Object.entries(m.by_tier).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none'}) frozen {m.frozen_at.slice(0, 16)}, manifest <span className="font-mono">{short(m.sha256)}</span>
          {m.valid ? '' : <span className="text-status-error"> — invalid: {m.reason}</span>}; first arm A {m.first_arm.A} / B {m.first_arm.B}; {m.species}, max-steps {m.step_budget}
        </p>
      ) : <p>Frozen set: none yet (the first claim from a worker announcing prod_gates and procedure_lines freezes it once PL_001_MODE is on).</p>}
      <p>
        Pairs: {d.pairs ? `${d.pairs.done} done / target ${d.pairs.target}${d.pairs.invalid_tasks ? `, ${d.pairs.invalid_tasks} invalid tasks` : ''}` : 'unknown (not frozen)'}
        {' '}· start condition {d.start_condition.rule} ({d.start_condition.genomes.map((g) => `${g.id} ${g.status ?? 'absent'}`).join(', ')}; cap share {d.start_condition.cap_share})
        {d.selector_check ? ` · selector check ${d.selector_check.does_not_apply}/${d.selector_check.n} unfit tasks rejected${d.selector_check.ok ? '' : ` — FAILED: ${d.selector_check.applies.join(', ')}`}` : ''}
      </p>
      {d.arms.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="text-left text-foreground-tertiary">{['Arm', 'Verified / observed', 'Censored', 'Pending', 'Attempts (infra, VOID)', 'Tokens (known / unknown)', 'Maker time median', 'Out of scope / hack'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {d.arms.map((a) => (
                <tr key={a.arm} className="border-t border-border">
                  <td>{a.arm} — {a.name}</td>
                  <td>{a.verified} / {a.observations}</td>
                  <td>{a.infra_censored}</td>
                  <td>{a.pending}</td>
                  <td>{a.physical_attempts} ({a.infra_attempts}, {a.void_attempts}){a.infra_rate === null ? '' : ` · infra ${pct(a.infra_rate)}`}</td>
                  <td>{a.tokens.mean_known === null ? 'unknown' : `mean ${a.tokens.mean_known}`} ({a.tokens.known} / {a.tokens.unknown})</td>
                  <td>{a.maker_ms_median === null ? 'unknown' : `${Math.round(a.maker_ms_median / 1000)} s`}</td>
                  <td>{a.out_of_scope_or_hack}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>{paired('Primary (ITT)', d.primary)}</p>
      <p className="text-foreground-secondary">{paired('Sensitivity (no censored arm)', d.sensitivity)}</p>
      <p>
        Verdict: <strong>{d.verdict ?? 'none yet'}</strong>
        {d.stop?.reason ? ` — ${d.stop.reason}` : ''}
        {d.stop?.day_limit_at ? ` · day ${d.targets.max_days} at ${d.stop.day_limit_at.slice(0, 16)}` : ''}
        {d.harm ? ` · harm e-value ${d.harm.e_value === null ? 'not computed' : d.harm.e_value} (stop at ${d.harm.threshold})${d.harm.canary_solved === null ? '' : `, canaries solved ${d.harm.canary_solved}`}` : ''}
      </p>
      {d.runs.length > 0 && (
        <details>
          <summary className="cursor-pointer text-foreground-secondary">Runs ({d.runs.length} latest)</summary>
          <ul className="list-disc pl-5 py-1">
            {d.runs.map((r) => (
              <li key={`${r.run_id}-${r.at}`}>
                <a href={`/goals-loops?run=${encodeURIComponent(r.run_id)}`} className="font-mono text-xs underline">{r.run_id.slice(0, 8)}</a>
                {' '}{r.arm} · {r.task_key.slice(0, 48)} · {r.status}{r.void ? ` · VOID: ${r.void}` : r.verified ? ' · verified' : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
