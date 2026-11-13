import type { Cv001Evidence, Cv001Paired } from '../lib/api';

/**
 * CV-001 (services/cv-001.ts): one read-only card — the treatment (aliases, vector digest, scale), the quiet window, the frozen
 * set, pairs done / target, per-arm clean / plain outcomes, the four-rule decision and the verdict. A value the server did not
 * compute reads "unknown" / "not computed", never 0.
 */
const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'unknown' : `${Math.round(v * 100)} %`);
const short = (h: string | null | undefined) => (h ? `${h.slice(0, 12)}…` : 'unknown');
const STATUS: Record<Cv001Evidence['status'], string> = {
  not_frozen: 'not frozen', invalid_manifest: 'manifest invalid — no analysis', waiting_window: 'frozen, waiting for the quiet window',
  collecting: 'collecting pairs', exhausted: 'no slot left to serve; the verdict waits for day 28', stopped: 'stopped',
};
const RULES: Record<string, string> = {
  clean_plus_10_and_significant: 'clean +10 pt, p < 0.05', plain_drop_at_most_5: 'plain drop ≤ 5 pt', degenerate_rise_at_most_2: 'degenerate rise ≤ 2 pt', timeouts_not_higher: 'timeouts not higher',
};

function paired(label: string, p: Cv001Paired | null) {
  if (!p) return `${label}: no completed pair yet`;
  return `${label}: ${p.n_pairs} pairs — clean B only ${p.b_only_B}, A only ${p.c_only_A}, both ${p.both_clean}; clean A ${pct(p.clean_rate_A)}, B ${pct(p.clean_rate_B)}; plain A ${pct(p.plain_rate_A)}, B ${pct(p.plain_rate_B)}; one-sided exact McNemar p ${p.p_one_sided === null ? 'not computed' : p.p_one_sided.toPrecision(3)}`;
}

export function Cv001Card({ data: d }: { data: Cv001Evidence }) {
  const m = d.manifest;
  return (
    <div className="space-y-2 text-sm" data-testid="cv-001-card">
      <p>
        A <span className="font-mono">{d.treatment.aliases.A}</span> vs B <span className="font-mono">{d.treatment.aliases.B}</span> (vector <span className="font-mono">{short(d.treatment.vector_sha256)}</span> × {d.treatment.scale})
        {' '}· mode {d.mode} · {STATUS[d.status]}
      </p>
      <p>
        Window {d.serving.window} UTC: {d.serving.open ? 'open now' : `closed — ${d.serving.reason ?? 'unknown'}`} · remote maker jobs waiting {d.serving.maker_jobs ?? 'unknown'}
      </p>
      {d.freeze_refused && <p className="text-status-error">Freeze refused ({d.freeze_refused.at.slice(0, 16)}): {d.freeze_refused.reason}</p>}
      {m ? (
        <p>
          Frozen set: {m.tasks} tasks × {d.targets.repeats} repeats = {m.units} units (tiers {Object.entries(m.by_tier).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none'}) frozen {m.frozen_at.slice(0, 16)}, manifest <span className="font-mono">{short(m.sha256)}</span>
          {m.valid ? '' : <span className="text-status-error"> — invalid: {m.reason}</span>}; blocks of {d.targets.block_size}; {m.species}
        </p>
      ) : <p>Frozen set: none yet (the first claim from a worker announcing prod_gates and model_override freezes it once CV_001_MODE is on).</p>}
      <p>Pairs: {d.pairs ? `${d.pairs.done} done / target ${d.pairs.target}, ${d.pairs.open} open${d.pairs.invalid_units ? `, ${d.pairs.invalid_units} invalid units` : ''}` : 'unknown (not frozen)'}</p>
      {d.arms.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="text-left text-foreground-tertiary">{['Arm', 'Clean / plain / observed', 'Timeouts', 'Degenerate', 'Loops', 'Post-pass edits', 'Censored', 'Pending', 'Attempts (infra, VOID)', 'Maker time median'].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>
              {d.arms.map((a) => (
                <tr key={a.arm} className="border-t border-border">
                  <td>{a.arm} — {a.name}</td>
                  <td>{a.clean} / {a.plain} / {a.observations}</td>
                  <td>{a.timeouts}</td>
                  <td>{a.degenerate}</td>
                  <td>{a.loops}</td>
                  <td>{a.post_pass_edits}</td>
                  <td>{a.censored}</td>
                  <td>{a.pending}</td>
                  <td>{a.physical_attempts} ({a.infra_attempts}, {a.void_attempts})</td>
                  <td>{a.maker_ms_median === null ? 'unknown' : `${Math.round(a.maker_ms_median / 1000)} s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>{paired('Primary (ITT)', d.primary)}</p>
      <p className="text-foreground-secondary">{paired('Sensitivity (no censored slot)', d.sensitivity)} · {paired('Repeat 1 only', d.repeat1)}</p>
      <p>
        Decision rules: {d.primary?.rules ? Object.entries(d.primary.rules).map(([k, v]) => `${RULES[k] ?? k} ${v ? 'holds' : 'fails'}`).join(' · ') : 'not computed'}
      </p>
      <p>
        Verdict: <strong>{d.verdict ?? 'none yet'}</strong>
        {d.stop?.reason ? ` — ${d.stop.reason}` : ''}
        {d.stop?.day_limit_at ? ` · day ${d.targets.max_days} at ${d.stop.day_limit_at.slice(0, 16)}` : ''}
      </p>
      {d.runs.length > 0 && (
        <details>
          <summary className="cursor-pointer text-foreground-secondary">Runs ({d.runs.length} latest)</summary>
          <ul className="list-disc pl-5 py-1">
            {d.runs.map((r) => (
              <li key={`${r.run_id}-${r.at}`}>
                <a href={`/goals-loops?run=${encodeURIComponent(r.run_id)}`} className="font-mono text-xs underline">{r.run_id.slice(0, 8)}</a>
                {' '}{r.arm}#{r.repeat} · {r.task_key.slice(0, 48)} · {r.status}{r.void ? ` · VOID: ${r.void}` : r.clean ? ' · clean' : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
