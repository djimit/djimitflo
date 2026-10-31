import { ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CommonsChildOutcomes, CommonsProposalPolicy, CommonsRuntimeReadiness, SocialAgentPresence } from '../../lib/api';
import { time } from './model';

const READINESS_TONE: Record<CommonsRuntimeReadiness['state'], string> = {
  ready: 'border-status-success/40 text-status-success',
  degraded: 'border-status-warning/40 text-status-warning',
  offline: 'border-status-error/40 text-status-error',
  unknown: 'border-border text-foreground-tertiary',
};

/** AC-01: heartbeat, last successful reply and last failed attempt per agent, never collapsed into "present". */
export function ReadinessTable({ agents }: { agents: SocialAgentPresence[] }) {
  return (
    <>
      <table className="mt-3 w-full text-xs" aria-label="Runtime readiness per agent">
        <thead><tr className="text-left text-foreground-tertiary"><th className="py-1">Agent</th><th>Readiness</th><th>Last heartbeat</th><th>Last successful reply</th><th>Last failed attempt</th></tr></thead>
        <tbody>{agents.map((agent) => {
          const readiness = agent.readiness;
          const state = readiness?.state ?? 'unknown';
          const failed = readiness?.last_failed_attempt;
          return <tr key={agent.id} className="border-t border-border align-top">
            <td className="py-1 pr-2 font-medium text-foreground">{agent.name}</td>
            <td className="py-1 pr-2"><span className={`rounded-full border px-2 py-0.5 ${READINESS_TONE[state]}`}>{state}</span><div className="mt-1 text-foreground-tertiary">{readiness?.reason ?? 'server sent no readiness'}</div></td>
            <td className="py-1 pr-2 text-foreground-secondary">{agent.last_heartbeat_at ? time(agent.last_heartbeat_at) : 'never'}</td>
            <td className="py-1 pr-2 text-foreground-secondary">{readiness?.last_successful_reply_at ? time(readiness.last_successful_reply_at) : 'none recorded'}</td>
            <td className="py-1 text-foreground-secondary">{failed ? <>{time(failed.at)} · claim lapsed without reply <code className="break-all text-foreground-tertiary">{failed.message_id}</code></> : 'none recorded'}</td>
          </tr>;
        })}</tbody>
      </table>
      <p className="mt-2 text-xs text-foreground-tertiary">Runtime error class: failures not reported. Pollers keep child errors in their own logs; the server only sees a claimed message whose lease lapsed without a reply. Ready = heartbeat under 20 min and a successful reply within 24 h with no lapse after it.</p>
    </>
  );
}

const CHILD_OUTCOME_LABELS: Array<[keyof CommonsChildOutcomes['outcomes'], string]> = [
  ['technical_failure', 'technical review failure'], ['needs_evidence', 'missing evidence'], ['blocked', 'opposed / blocked'],
  ['backlog', 'backlog'], ['pending', 'pending panel'], ['goal', 'goal'],
];

/** AC-03: grounded children → goals with the panel outcome split; a technical review failure is not an idea rejection. */
export function GroundedChildOutcomes({ outcomes: o }: { outcomes: CommonsChildOutcomes }) {
  return (
    <div className="mt-2 space-y-1 text-xs text-foreground-secondary" aria-label="What the panels of grounded children said">
      <p><strong>{o.grounded_proposals}</strong> grounded proposals ({o.no_refinement} no refinement) → <strong>{o.children}</strong> grounded children → <strong>{o.outcomes.goal}</strong> goals</p>
      <div className="flex flex-wrap gap-2">
        {CHILD_OUTCOME_LABELS.map(([key, label]) => <span key={key} className="rounded border border-border px-2 py-0.5">{label} <strong>{o.outcomes[key]}</strong></span>)}
      </div>
      {o.outcomes.technical_failure > 0 && <p>{o.outcomes.technical_failure} of {o.children} panels hold only model-failure fallbacks ({o.legacy_fallback_reviews} legacy unparseable reviews): a technical failure, not a rejected idea. Current panel reliability: <Link to="/#guardrails" className="text-accent underline">panel attempt metrics</Link>.</p>}
    </div>
  );
}

const WORKER_LABEL: Record<string, string> = { commons_proposal_review: 'Commons proposal review', grounding_agenda: 'grounding agenda', grounding_apply: 'grounding apply', failure_agenda: 'failure agenda' };
const POLICY_HEADLINE: Record<CommonsProposalPolicy['state'], string> = {
  disabled: 'Reflection recorded; proposal generation disabled by policy',
  exhausted: 'Reflection proposals: rate limit reached for the rolling window',
  open: 'Reflection proposals admitted up to the cap',
  uncapped: 'Reflection proposals: no cap set',
};

/** AC-10: the effective admission policy, read from the server — not a claim about why any one historical message has no proposal. */
export function ProposalPolicyBanner({ policy }: { policy: CommonsProposalPolicy }) {
  const stopped = policy.state === 'disabled' || policy.state === 'exhausted';
  return (
    <section role="status" aria-label="Proposal admission policy" className={`rounded-xl border p-4 text-sm ${stopped ? 'border-status-warning/30 bg-status-warning/10' : 'border-border bg-background-secondary'}`}>
      <p className="flex items-center gap-2 font-semibold text-foreground">{stopped && <ShieldAlert className="h-4 w-4 text-status-warning" />}{POLICY_HEADLINE[policy.state]}</p>
      <p className="mt-1 text-xs text-foreground-secondary"><code>{policy.env}={policy.cap ?? 'unset'}</code> · scope {policy.scope} · source {policy.source} · window rolling {policy.window_hours} h · {policy.created_in_window} created in the window{policy.remaining !== null && policy.state !== 'disabled' ? ` · ${policy.remaining} remaining` : ''}</p>
      {policy.state === 'disabled' && <p className="mt-1 text-xs text-foreground-secondary">Conversations still record reflections, but ordinary ideas cannot currently enter the proposal queue through this route.</p>}
      <p className="mt-1 text-xs text-foreground-tertiary">The cap is shared by every reflection producer ({policy.shared_producers.join(', ')}); raising it is not a Commons-only change.</p>
      {!!policy.workers.length && <div className="mt-2 flex flex-wrap gap-2 text-xs text-foreground-secondary" aria-label="Commons workers">{policy.workers.map((w) => <span key={w.id} className="rounded border border-border px-2 py-0.5" title={w.env}>{WORKER_LABEL[w.id] ?? w.id} <strong>{w.enabled ? 'on' : 'off'}</strong></span>)}</div>}
    </section>
  );
}
