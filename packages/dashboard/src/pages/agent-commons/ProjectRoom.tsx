import { useEffect, useState, type ReactNode } from 'react';
import { api, type ProjectRoomDossier, type ProjectRoomSummary } from '../../lib/api';

/**
 * Commons "Project room" tab: one goal's engineering dossier — goal and source, architecture findings, the current plan,
 * what actually ran, checks and verdicts, later outcome. Everything is projected from existing records; nothing is decided
 * here. Claims, delivered artifacts and verified outcomes are kept apart, and an unknown is shown as "—" or "unknown",
 * never as a pass or a zero.
 */
function Card({ title, state, children }: { title: string; state?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-background-secondary p-4">
      <div className="flex items-baseline justify-between gap-3"><h2 className="text-sm font-semibold text-foreground">{title}</h2>{state && <span className="text-xs text-foreground-secondary">{state}</span>}</div>
      <div className="mt-3 space-y-2 text-sm text-foreground">{children}</div>
    </section>
  );
}
const Row = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="flex justify-between gap-4"><span className="text-foreground-secondary">{label}</span><span className="text-right">{value}</span></div>
);
const Empty = ({ children }: { children: ReactNode }) => <p className="text-foreground-secondary">{children}</p>;
const yesNo = (v: boolean | null) => (v === null ? 'not measured' : v ? 'yes' : 'no');

export function ProjectRoomBody({ dossier }: { dossier: ProjectRoomDossier }) {
  const { goal, review, plan, execution, gaps } = dossier;
  const leases = execution.flatMap((e) => e.leases.map((l) => ({ ...l, run_id: e.run_id })));
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {gaps.length > 0 && (
        <section role="status" className="rounded-lg border border-border bg-background-secondary p-4 text-sm md:col-span-2">
          <h2 className="font-semibold text-foreground">Missing or blocked</h2>
          <ul className="mt-2 space-y-1">
            {gaps.map((g) => <li key={g.what}><span className="text-status-warning">{g.what}</span>: {g.reason}. <span className="text-foreground-secondary">Next: {g.next_action}.</span></li>)}
          </ul>
        </section>
      )}
      <Card title="Goal" state={`mode ${dossier.mode} · ${dossier.selected ? dossier.variant.replace('_', ' ') : 'direct route'}`}>
        <p>{goal.objective}</p>
        <Row label="Status" value={goal.status} />
        <Row label="Source revision" value={goal.source ? <code>{goal.source.base_commit.slice(0, 12)}</code> : '—'} />
        <Row label="Tokens used by the room" value={goal.max_tokens ? `${goal.tokens_used_by_room} of ${goal.max_tokens}` : `${goal.tokens_used_by_room} (no token budget set)`} />
        {goal.acceptance_criteria.length > 0 && <ul className="list-disc pl-5">{goal.acceptance_criteria.map((c) => <li key={c}>{c}</li>)}</ul>}
        {goal.constraints.length > 0 && <p className="text-foreground-secondary">Constraints: {goal.constraints.join('; ')}</p>}
      </Card>
      <Card title="Architecture findings" state={review ? `version ${review.version} · claims, not verified facts` : undefined}>
        {!review ? <Empty>No architecture review{dossier.variant === 'single' ? ': this goal uses the single-planner route.' : ' yet.'}</Empty> : (
          <>
            <ul className="space-y-1">
              {review.claims.map((c) => (
                <li key={c.id}>
                  {c.claim} <span className="text-foreground-secondary">({c.refs.map((r) => r.path).join(', ') || 'no source'})</span>{' '}
                  <span className={c.refs_resolved ? 'text-status-completed' : 'text-status-warning'}>{c.refs_resolved ? 'source found' : 'source not found'}</span>
                </li>
              ))}
            </ul>
            {review.open_questions.length > 0 && <p className="text-foreground-secondary">Open questions: {review.open_questions.join('; ')}</p>}
          </>
        )}
      </Card>
      <Card title="Plan" state={plan ? `version ${plan.version} of ${plan.versions.length}` : undefined}>
        {!plan ? <Empty>No plan issued.</Empty> : (
          <>
            {plan.decisions.length > 0 && <p>Decisions: {plan.decisions.join('; ')}</p>}
            <ol className="list-decimal space-y-1 pl-5">
              {plan.steps.map((s) => (
                <li key={s.id}>{s.title} <span className="text-foreground-secondary">— {s.scope.join(', ')} · checks: {s.verification.join(', ')}{s.depends_on.length ? ` · after ${s.depends_on.join(', ')}` : ''}</span></li>
              ))}
            </ol>
            {plan.findings_review.length > 0 && <p className="text-foreground-secondary">Findings: {plan.findings_review.map((f) => `${f.claim_id} ${f.status}`).join(', ')}</p>}
            {plan.open_questions.length > 0 && <p className="text-foreground-secondary">Open questions: {plan.open_questions.join('; ')}</p>}
            <details><summary className="cursor-pointer text-foreground-secondary">Inspect</summary><code className="break-all text-xs">{plan.plan_id} · sha256:{plan.digest}</code></details>
          </>
        )}
      </Card>
      <Card title="Execution" state={`${execution.length} run${execution.length === 1 ? '' : 's'}`}>
        {leases.length === 0 ? <Empty>No worker has been started for this goal.</Empty> : leases.map((l) => (
          <div key={l.id} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
            <Row label={`${l.role} · ${l.runtime}${l.superseded ? ' · superseded' : ''}`} value={l.task?.status && l.task.status !== l.status ? `${l.status} (task ${l.task.status})` : l.status} />
            {l.plan && <Row label={`Plan version ${l.plan.version}`} value={`delivered: ${yesNo(l.plan.delivered)} · loaded: ${yesNo(l.plan.loaded)}`} />}
          </div>
        ))}
      </Card>
      <Card title="Checks and verdicts">
        {leases.every((l) => !l.checks && !l.verdict) ? <Empty>No check or verdict recorded yet.</Empty> : leases.filter((l) => l.checks || l.verdict).map((l) => (
          <div key={l.id}>
            {l.checks && <Row label={`${l.role} checks`} value={l.checks.map((c) => `${c.name}: ${c.status}`).join(' · ') || '—'} />}
            {l.verdict && <Row label={`${l.role} verdict`} value={l.verdict} />}
          </div>
        ))}
      </Card>
      <Card title="Outcome and learning">
        {execution.length === 0 ? <Empty>No run yet.</Empty> : execution.map((e) => (
          <div key={e.run_id}>
            <Row label={`Run ${e.run_id.slice(0, 8)} · ${e.status}`} value={e.outcome_verified === null ? 'not settled' : e.outcome_verified ? 'verified' : 'not verified'} />
            <Row label="Survival on main" value={e.survival === 'UNKNOWN' ? 'unknown (no pull request to observe)' : e.survival.toLowerCase()} />
          </div>
        ))}
        {dossier.candidates.length > 0 && <ul className="list-disc pl-5">{dossier.candidates.map((c) => <li key={c.id}>{c.lesson} <span className="text-foreground-secondary">({c.status})</span></li>)}</ul>}
      </Card>
    </div>
  );
}

export function CommonsProjectRoom() {
  const [rooms, setRooms] = useState<ProjectRoomSummary[] | null>(null);
  const [mode, setMode] = useState('off');
  const [selected, setSelected] = useState<string | null>(null);
  const [dossier, setDossier] = useState<ProjectRoomDossier | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  useEffect(() => { api.getProjectRooms().then((r) => { setRooms(r.rooms); setMode(r.mode); setSelected((s) => s ?? r.rooms[0]?.id ?? null); }).catch(fail); }, []);
  useEffect(() => { if (!selected) return; setDossier(null); api.getProjectRoom(selected).then(setDossier).catch(fail); }, [selected]);
  if (error) return <p role="alert" className="p-8 text-sm text-status-error">Project room unavailable: {error}</p>;
  if (!rooms) return <p className="p-8 text-sm text-foreground-secondary">Loading project rooms…</p>;
  if (rooms.length === 0) return (
    <p className="p-8 text-sm text-foreground-secondary">
      No goal uses the project room yet (mode {mode}). A goal selects it with <code>metadata.task_profile = &quot;project_room&quot;</code>; every other goal keeps the direct route.
    </p>
  );
  return (
    <div className="space-y-4 p-8">
      <label className="block text-sm text-foreground-secondary">Goal{' '}
        <select className="ml-2 rounded border border-border bg-background px-2 py-1 text-foreground" value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.objective.slice(0, 80)} — {r.status}{r.plan_version ? ` · plan v${r.plan_version}` : ' · no plan'}</option>)}
        </select>
      </label>
      {dossier ? <ProjectRoomBody dossier={dossier} /> : <p className="text-sm text-foreground-secondary">Loading dossier…</p>}
    </div>
  );
}
