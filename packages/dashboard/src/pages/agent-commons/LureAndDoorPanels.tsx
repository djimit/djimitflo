import { useEffect, useState } from 'react';
import { Copy, DoorOpen, Eye, EyeOff, Magnet, ShieldAlert } from 'lucide-react';
import { api, type AgentReputation, type JoinInvite, type JoinRequest, type LureCast, type LureInvitee, type LureStatus } from '../../lib/api';
import { LURE_COLOR, STAGE, time } from './model';

const INVITEE_TONE: Record<LureInvitee['state'], string> = {
  invited: 'border-border text-foreground-tertiary',
  seen: 'border-accent/40 text-accent',
  bit: 'border-status-success/40 bg-status-success/10 text-status-success',
  expired: 'border-border text-foreground-muted line-through',
};
const INVITEE_LABEL: Record<LureInvitee['state'], string> = { invited: 'invited', seen: 'seen', bit: 'bitten', expired: 'expired' };

export function LurePanel({ lures, cast }: { lures: LureStatus | null; cast: LureCast | null }) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); window.setTimeout(() => setCopied(null), 1500); } catch { setCopied(null); }
  }
  return (
    <section className="rounded-xl border border-border bg-background-secondary p-4" style={{ borderTopColor: LURE_COLOR, borderTopWidth: 2 }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground"><Magnet className="h-5 w-5" style={{ color: LURE_COLOR }} /> Lure and honeypot</h2>
          <p className="mt-1 max-w-3xl text-sm text-foreground-secondary">A lure sends every silent agent an invitation on the agent bus with the oldest open knowledge gap as bait, and gives you a one-time runtime token per agent. An agent that picks up the invitation over its token and then sends a heartbeat has bitten. Anyone knocking without a valid key shows up under probes.</p>
        </div>
      </div>

      {cast && cast.invitations.length > 0 && (
        <div className="mt-4 rounded-lg border p-3" style={{ borderColor: LURE_COLOR }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Invitations just sent ({cast.invitations.length}) · tokens expire {time(cast.lure.expires_at)}</h3>
            <button type="button" onClick={() => setReveal((current) => !current)} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">{reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {reveal ? 'hide tokens' : 'show tokens'}</button>
          </div>
          <ul className="mt-3 space-y-2">
            {cast.invitations.map((invitation) => (
              <li key={invitation.agent_id} className="rounded-lg bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-semibold text-foreground">{invitation.name} <span className="font-normal text-foreground-tertiary">({invitation.agent_id})</span></span><button type="button" onClick={() => void copy(invitation.agent_id, invitation.poller_env)} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-foreground-secondary hover:bg-background-elevated"><Copy className="h-3 w-3" /> {copied === invitation.agent_id ? 'copied' : 'copy poller command'}</button></div>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-foreground-secondary">{reveal ? invitation.poller_env : invitation.poller_env.replace(invitation.token, '•'.repeat(24))}</pre>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Lures cast</h3>
          {(lures?.lures || []).map((lure) => (
            <article key={lure.id} className="rounded-lg border border-border bg-background p-3">
              <div className="flex flex-wrap items-start justify-between gap-2"><p className="text-sm text-foreground">{lure.topic}</p><span className="shrink-0 text-xs" style={{ color: LURE_COLOR }}>{lure.bites}/{lure.invitees.length} bitten</span></div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {lure.invitees.map((invitee) => <span key={invitee.agent_id} title={invitee.bit_at ? `bitten ${time(invitee.bit_at)}` : INVITEE_LABEL[invitee.state]} className={`rounded-full border px-2 py-0.5 text-[10px] ${INVITEE_TONE[invitee.state]}`}>{invitee.name} · {INVITEE_LABEL[invitee.state]}{invitee.reach === 'never' ? ' · never connected' : ''}</span>)}
              </div>
              <p className="mt-2 text-xs text-foreground-tertiary">by {lure.created_by} · {time(lure.created_at)} · expires {time(lure.expires_at)} · <code>{lure.topic_ref}</code></p>
            </article>
          ))}
          {!lures?.lures.length && <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-foreground-tertiary">No lure cast yet.</p>}
        </div>
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground"><ShieldAlert className="h-4 w-4 text-status-error" /> Probes <span className="text-xs font-normal text-foreground-tertiary">({lures?.probe_count || 0})</span></h3>
          <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {(lures?.probes || []).map((probe) => <li key={probe.id} className="rounded border border-status-error/20 bg-status-error/5 px-2 py-1.5 text-[10px] text-foreground-secondary"><span className="font-mono text-foreground">{probe.agent_id}</span> · {probe.ip} · {probe.reason} · {time(probe.created_at)}</li>)}
            {!lures?.probes.length && <li className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-foreground-tertiary">Nobody has knocked without a key.</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

const JOIN_TONE: Record<JoinRequest['status'], string> = {
  pending: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  approved: 'border-status-success/40 bg-status-success/10 text-status-success',
  rejected: 'border-border text-foreground-muted',
};
const JOIN_LABEL: Record<JoinRequest['status'], string> = { pending: 'awaiting admission', approved: 'admitted', rejected: 'rejected' };

export function OpenDoorPanel({ requests, invite, onInvite, onDecide, busy }: { requests: JoinRequest[]; invite: JoinInvite | null; onInvite: () => void; onDecide: (agentId: string, approve: boolean) => void; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const [reputations, setReputations] = useState<Record<string, AgentReputation | 'error'>>({});
  const cardUrl = `${window.location.origin}/api/swarm-v2/social-runtime/card`;
  const example = invite ? `curl -X POST ${invite.join_url} -H 'Content-Type: application/json' -d '{"invite_code":"${invite.code}","agent_id":"my-agent","name":"My Agent","capabilities":["research"],"contact":"ops@example.org"}'` : '';
  async function copy() { try { await navigator.clipboard.writeText(example); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } }
  const pending = requests.filter((request) => request.status === 'pending');

  // Advisory-only: fetched for display next to the decide buttons below,
  // never consulted by onDecide — the human makes the actual call.
  useEffect(() => {
    for (const request of pending) {
      if (request.agent_id in reputations) continue;
      api.getAgentReputation(request.agent_id)
        .then((reputation) => setReputations((current) => ({ ...current, [request.agent_id]: reputation })))
        .catch(() => setReputations((current) => ({ ...current, [request.agent_id]: 'error' })));
    }
  }, [pending.map((request) => request.agent_id).join(',')]);

  return (
    <section className="rounded-xl border border-border bg-background-secondary p-4" style={{ borderTopColor: STAGE.asked.color, borderTopWidth: 2 }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground"><DoorOpen className="h-5 w-5" style={{ color: STAGE.asked.color }} /> Open door for external agents</h2>
          <p className="mt-1 max-w-3xl text-sm text-foreground-secondary">Agents elsewhere on the web can knock with an invitation code. They appear here as pending; you admit or reject them, and only then do they fetch a short-lived token themselves. The public description of the protocol is at <a className="text-accent hover:underline" href={cardUrl} target="_blank" rel="noreferrer">{cardUrl.replace(window.location.origin, '')}</a>.</p>
        </div>
        <button type="button" onClick={onInvite} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-background-elevated disabled:opacity-40" style={{ borderColor: STAGE.asked.color, color: STAGE.asked.color }}><DoorOpen className="h-4 w-4" /> Create invitation code</button>
      </div>
      {invite && (
        <div className="mt-4 rounded-lg border p-3" style={{ borderColor: STAGE.asked.color }}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-semibold text-foreground">Code for "{invite.label}" · {invite.max_uses}× uses · expires {time(invite.expires_at)} · shown only now</span><button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-foreground-secondary hover:bg-background-elevated"><Copy className="h-3 w-3" /> {copied ? 'copied' : 'copy knock example'}</button></div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10px] text-foreground-secondary">{example}</pre>
        </div>
      )}
      <div className="mt-4 space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Knocked {pending.length > 0 && <span className="ml-1 rounded-full border border-accent-warning/40 px-2 py-0.5 text-[10px] text-accent-warning">{pending.length} waiting</span>}</h3>
        {requests.map((request) => (
          <article key={request.agent_id} className="rounded-lg border border-border bg-background p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold text-foreground">{request.name}</span><span className="font-mono text-xs text-foreground-tertiary">{request.agent_id}</span><span className={`rounded-full border px-2 py-0.5 text-xs ${JOIN_TONE[request.status]}`}>{JOIN_LABEL[request.status]}</span>{request.status === 'pending' && <ReputationBadge reputation={reputations[request.agent_id]} />}</div>{request.description && <p className="mt-1 text-xs text-foreground-secondary">{request.description}</p>}<p className="mt-1 text-xs text-foreground-tertiary">{request.capabilities.join(', ') || 'no capabilities given'} · via "{request.invite_label}" · {request.ip} · {time(request.requested_at)}{request.contact && <> · {request.contact}</>}{request.decided_by && <> · decided by {request.decided_by}</>}</p></div>
              {request.status === 'pending' && <div className="flex shrink-0 gap-2"><button type="button" onClick={() => onDecide(request.agent_id, true)} disabled={busy} className="rounded-lg border border-status-success/40 px-3 py-1.5 text-xs text-status-success hover:bg-status-success/10 disabled:opacity-40">Admit</button><button type="button" onClick={() => onDecide(request.agent_id, false)} disabled={busy} className="rounded-lg border border-status-error/40 px-3 py-1.5 text-xs text-status-error hover:bg-status-error/10 disabled:opacity-40">Reject</button></div>}
            </div>
          </article>
        ))}
        {!requests.length && <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-foreground-tertiary">Nobody from outside has knocked yet.</p>}
      </div>
    </section>
  );
}

/**
 * Advisory-only: shows a computed signal derived from existing task-history
 * and lure/probe data. Never gates onDecide above — the operator always
 * decides; this is purely one more number to look at first.
 */
function ReputationBadge({ reputation }: { reputation: AgentReputation | 'error' | undefined }) {
  if (reputation === undefined) return <span className="text-xs text-foreground-tertiary">loading reputation...</span>;
  if (reputation === 'error') return null;
  const lowConfidence = reputation.sample_size < 3;
  const color = reputation.score >= 0.65 ? 'text-status-success border-status-success/40' : reputation.score <= 0.35 ? 'text-status-error border-status-error/40' : 'text-foreground-tertiary border-border';
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${color}`} title="Advisory score from task history and lure/probe behaviour; never an automatic decision.">
      reputation {reputation.score.toFixed(2)}{lowConfidence ? ' (little data)' : ''}
    </span>
  );
}
