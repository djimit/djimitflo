import { useCallback, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, type MissionDetail } from '../lib/api';
import { fmt, fmtDate } from '../lib/format';
import { useResource } from '../hooks/useResource';
import { LoadErrorNotice } from '../components/LoadErrorNotice';
import { PageHeader, panel } from '../components/PageHeader';
import { DataTable, Section } from '../components/ui';

/**
 * Mission detail (read-only): one swarm mission and what the existing records say about it. Every value names the
 * record it came from; a value no record holds reads "unknown", never 0. Reached from Mission Control, not the nav.
 */
export const UNKNOWN = 'unknown — not recorded';

/** Outcome measures with no source in the data yet: listed so their absence is visible, never shown as 0. */
export const UNRECORDED_MEASURES = ['Time to verified outcome', 'Human interruptions', 'Escaped defects', 'Energy per mission'] as const;

export type RelationshipType = 'participation' | 'delegation' | 'agreement' | 'verification' | 'reuse';
export const RELATIONSHIP_TYPES: readonly RelationshipType[] = ['participation', 'delegation', 'agreement', 'verification', 'reuse'];
export type Relationship = { type: RelationshipType; from: string; to: string; detail: string; evidence: string };

/**
 * The relationships the mission's records state, each typed by the record that holds it:
 *   participation — a lease (role, runtime) worked on one of the mission's loop runs (worker_leases.loop_run_id)
 *   verification  — a non-maker lease returned a verdict, on the maker lease it names when it names one
 *   delegation    — a mission task was assigned to a lease (swarm_tasks.assigned_lease_id)
 *   agreement     — a quorum decision recorded on the mission (swarm_decisions, decision_type 'quorum')
 * No record links a mission to reused work, so 'reuse' is never derived here.
 */
export function missionRelationships(detail: Pick<MissionDetail, 'leases' | 'tasks' | 'decisions'>): Relationship[] {
  const out: Relationship[] = [];
  for (const l of detail.leases) out.push({ type: 'participation', from: `lease ${l.id} (${l.role}, ${l.runtime})`, to: `run ${l.loop_run_id}`, detail: l.status, evidence: `worker_leases.loop_run_id#${l.id}` });
  for (const l of detail.leases) {
    if (l.role === 'maker' || !l.verdict) continue;
    out.push({ type: 'verification', from: `lease ${l.id} (${l.role})`, to: l.maker_lease_id ? `maker lease ${l.maker_lease_id}` : `run ${l.loop_run_id} (maker lease not named)`,
      detail: `verdict ${l.verdict}`, evidence: `worker_leases.metadata.verdict#${l.id}` });
  }
  for (const t of detail.tasks) if (t.assigned_lease_id) out.push({ type: 'delegation', from: `task ${t.title}`, to: `lease ${t.assigned_lease_id}`, detail: t.status, evidence: `swarm_tasks.assigned_lease_id#${t.id}` });
  for (const d of detail.decisions) if (d.decision_type === 'quorum') out.push({ type: 'agreement', from: d.actor, to: 'mission', detail: d.decision, evidence: `swarm_decisions#${d.id}` });
  return out;
}

export function tokenText(tokens: MissionDetail['tokens']): string {
  if (!tokens) return 'unknown — no linked loop runs';
  if (tokens.value === null) return tokens.events ? `unknown — none of ${tokens.events} usage records reported tokens` : 'unknown — no usage record';
  return `${fmt(tokens.value)} tokens (${tokens.known} of ${tokens.events} usage records reported${tokens.status === 'partial' ? '; partial — a lower bound' : ''})`;
}

const runLink = (id: string) => <Link to={`/goals-loops?run=${encodeURIComponent(id)}`} className="font-mono text-xs underline">{id}</Link>;

function Fact({ label, children, source }: { label: string; children: ReactNode; source?: string | null }) {
  return (
    <div className="py-1">
      <dt className="text-xs uppercase text-foreground-tertiary">{label}</dt>
      <dd className="text-sm text-foreground">{children}{source && <span className="ml-2 font-mono text-xs text-foreground-tertiary">from {source}</span>}</dd>
    </div>
  );
}

export function MissionDetailView({ detail }: { detail: MissionDetail }) {
  const { mission, execution, goal, runs, blocker, next_action: nextAction } = detail;
  const relationships = missionRelationships(detail);
  const recordedTypes = new Set(relationships.map((r) => r.type));
  const notRecorded = RELATIONSHIP_TYPES.filter((t) => !recordedTypes.has(t));
  const attributed = runs.filter((r) => r.attribution);
  const classes = Object.entries(attributed.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.attribution!.outcome]: (acc[r.attribution!.outcome] ?? 0) + 1 }), {}));
  return (
    <div className="space-y-6">
      <section className={panel} aria-label="Mission status">
        <dl className="grid gap-x-6 sm:grid-cols-2">
          <Fact label="Intended result" source={`swarm_missions#${mission.id}`}>{mission.title}{mission.description && <span className="block text-foreground-secondary">{mission.description}</span>}</Fact>
          <Fact label="Planning status (advisory, never auto-transitioned)">{mission.planning_status} · risk {mission.risk_class} · created {fmtDate(mission.created_at)}</Fact>
          <Fact label="Linked goal" source={goal ? `goals#${goal.id}` : null}>
            {goal ? <>{goal.status} · {goal.objective}</> : `unknown — ${execution.lineage === 'no_goal' ? 'no goal linked' : 'linked goal not found'}`}
          </Fact>
          <Fact label="Current blocker" source={blocker?.source}>{blocker ? blocker.text : 'unknown — no blocker recorded'}</Fact>
          <Fact label="Next action" source={nextAction?.source}>{nextAction ? nextAction.items.join('; ') : 'unknown — no next action recorded'}</Fact>
          <Fact label="Resource use (cost-ledger usage events of the mission's runs)">{tokenText(detail.tokens)}</Fact>
        </dl>
      </section>

      <Section id="mission-runs" title="Loop runs">
        <DataTable caption="Loop runs of the mission's goal, newest first" rows={runs} rowKey={(r) => r.id}
          empty={goal ? 'No loop run recorded for the linked goal.' : 'No linked goal, so no loop runs.'}
          columns={[
            { key: 'id', label: 'Run', render: (r) => runLink(r.id) },
            { key: 'loop', label: 'Loop', render: (r) => r.loop_name },
            { key: 'status', label: 'Status', render: (r) => r.status },
            { key: 'created', label: 'Started', render: (r) => fmtDate(r.created_at) },
            { key: 'gates', label: 'Failed gates', render: (r) => (r.failed_gates.length ? r.failed_gates.join(', ') : 'none recorded') },
            { key: 'closure', label: 'Learning closure', render: (r) => (r.closure ? `closed · eval ${r.closure.eval_run_id}` : 'no closure recorded') },
            { key: 'attribution', label: 'Attribution class', render: (r) => (r.attribution ? r.attribution.outcome : UNKNOWN) },
          ]} />
      </Section>

      <Section id="mission-outcome" title="Outcome">
        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground-secondary">
          <li>Closures: {execution.execution ? (execution.execution.closed_runs === null ? 'unknown — closures table not readable' : `${execution.execution.closed_runs} of ${execution.execution.loop_runs} runs closed`) : 'unknown — no linked runs'}</li>
          <li>Attribution: {attributed.length ? `${classes.map(([k, n]) => `${k} ${n}`).join(' · ')} (${attributed.length} of ${runs.length} runs attributed)` : `${UNKNOWN} for any run`}</li>
        </ul>
        <div className="mt-3">
          <DataTable caption="Outcome measures without a source yet" captionVisible rows={[...UNRECORDED_MEASURES]} rowKey={(m) => m}
            columns={[{ key: 'measure', label: 'Measure', render: (m) => m }, { key: 'value', label: 'Value', render: () => UNKNOWN }]} />
        </div>
      </Section>

      <Section id="mission-relationships" title="Relationships">
        <p className="mb-2 text-sm text-foreground-secondary">
          Each row is one recorded link, typed by the record that holds it. Not recorded for this mission: {notRecorded.length ? notRecorded.join(', ') : 'none'}.
        </p>
        <DataTable caption="Recorded relationships of the mission" rows={relationships} rowKey={(r) => `${r.type}|${r.evidence}`} empty="No relationship recorded for this mission."
          columns={[
            { key: 'type', label: 'Relationship', render: (r) => r.type },
            { key: 'from', label: 'From', render: (r) => r.from },
            { key: 'to', label: 'To', render: (r) => r.to },
            { key: 'detail', label: 'Detail', render: (r) => r.detail },
            { key: 'evidence', label: 'Evidence', render: (r) => <code className="break-all text-xs">{r.evidence}</code> },
          ]} />
      </Section>

      <Section id="mission-provenance" title="Provenance edges">
        <p className="mb-2 text-sm text-foreground-secondary">Lineage from the provenance DAG (proposal → run → PR → survival) touching this mission's runs; edge types are the DAG's own.</p>
        <DataTable caption="Provenance edges touching the mission's runs" rows={detail.provenance} rowKey={(e) => `${e.edge_type}|${e.source.id}|${e.target.id}`}
          empty="No provenance edge touches this mission's runs (no run is linked to a proposal)."
          columns={[
            { key: 'type', label: 'Edge', render: (e) => e.edge_type },
            { key: 'source', label: 'Source', render: (e) => `${e.source.kind} ${e.source.id}` },
            { key: 'target', label: 'Target', render: (e) => `${e.target.kind} ${e.target.id}` },
            { key: 'evidence', label: 'Evidence', render: (e) => <code className="break-all text-xs">{e.evidence_ref}</code> },
          ]} />
      </Section>

      <Section id="mission-decisions" title="Decisions">
        <DataTable caption="Decisions recorded on the mission, newest first" rows={detail.decisions} rowKey={(d) => d.id} empty="No decision recorded on this mission."
          columns={[
            { key: 'at', label: 'When', render: (d) => fmtDate(d.created_at) },
            { key: 'type', label: 'Type', render: (d) => d.decision_type },
            { key: 'decision', label: 'Decision', render: (d) => d.decision },
            { key: 'actor', label: 'Actor', render: (d) => d.actor },
            { key: 'blocked', label: 'Blocked reasons', render: (d) => (d.blocked_reasons.length ? d.blocked_reasons.join('; ') : 'none') },
          ]} />
      </Section>
    </div>
  );
}

export function MissionDetailPage() {
  const { missionId = '' } = useParams<{ missionId: string }>();
  const fetchDetail = useCallback(() => api.request<MissionDetail>(`/swarms/intelligence/missions/${encodeURIComponent(missionId)}/execution`), [missionId]);
  const { data, error, loading } = useResource(fetchDetail);
  return (
    <div className="space-y-6 p-6">
      <Link to="/swarm-mission-control" className="inline-flex items-center gap-2 text-sm text-foreground-secondary hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to Mission Control</Link>
      <PageHeader title={data?.mission.title ?? 'Mission detail'} description="Read-only. Every value names its record; what no record holds reads unknown, never 0." />
      <LoadErrorNotice failed={error ? [`mission: ${error}`] : []} />
      {loading && !data && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {data && <MissionDetailView detail={data} />}
    </div>
  );
}
