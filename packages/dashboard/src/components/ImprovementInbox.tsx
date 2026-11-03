import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ImprovementProposal, type SpecialistPanelRecord } from '../lib/api';
import { useAuthStore } from '../lib/auth-store';

type InboxTab = 'proposed' | 'needs_more_evidence';

export function ImprovementInbox() {
  const canGovern = useAuthStore((state) => state.hasPermission('write:governance'));
  const [tab, setTab] = useState<InboxTab>('proposed');
  const [proposals, setProposals] = useState<ImprovementProposal[]>([]);
  const [panels, setPanels] = useState<Map<string, SpecialistPanelRecord>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [proposalResult, panelResult] = await Promise.all([
        api.getImprovementProposals(tab),
        api.getSpecialistPanels(100),
      ]);
      setProposals(proposalResult.proposals ?? []);
      setPanels(new Map((panelResult.panels ?? []).map((panel) => [panel.id, panel])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load proposals');
    }
  }, [tab]);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (proposal: ImprovementProposal, action: 'approve' | 'reject') => {
    setBusy(proposal.id);
    setError(null);
    try {
      if (action === 'approve') await api.approveImprovementProposal(proposal.id);
      else await api.rejectImprovementProposal(proposal.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-background-secondary p-4 space-y-4" aria-labelledby="improvement-inbox-title">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="improvement-inbox-title" className="text-lg font-semibold text-foreground">Self-improvement inbox</h2>
          <p className="text-sm text-foreground-secondary">Proposals remain inert until specialist consensus and your approval.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-border text-sm">
            <button
              onClick={() => setTab('proposed')}
              className={`px-3 py-1 ${tab === 'proposed' ? 'bg-background-tertiary text-foreground' : 'text-foreground-secondary'}`}
            >Proposed</button>
            <button
              onClick={() => setTab('needs_more_evidence')}
              className={`px-3 py-1 ${tab === 'needs_more_evidence' ? 'bg-background-tertiary text-foreground' : 'text-foreground-secondary'}`}
            >Needs more evidence</button>
          </div>
          <button onClick={() => void refresh()} className="rounded border border-border px-3 py-1 text-sm text-foreground hover:bg-background">Refresh</button>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {proposals.length === 0 ? <p className="text-sm text-foreground-secondary">{tab === 'proposed' ? 'No pending proposals.' : 'No proposals currently need more evidence.'}</p> : (
        <div className="space-y-3">
          {proposals.map((proposal) => {
            const panel = proposal.panelId ? panels.get(proposal.panelId) : undefined;
            const ready = panel?.status === 'consensus_ready' && panel.consensus.decision === 'goal';
            return (
              <article key={proposal.id} className="rounded border border-border bg-background p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium text-foreground">{proposal.title}</h3>
                    <p className="mt-1 text-sm text-foreground-secondary">{proposal.description}</p>
                    <p className="mt-2 text-xs text-foreground-tertiary">Rationale: {proposal.rationale}</p>
                    {proposal.evidenceRefs.length > 0 && <p className="mt-1 text-xs font-mono text-foreground-tertiary">Evidence: {proposal.evidenceRefs.join(', ')}</p>}
                    {(panel?.consensus.dissent?.length ?? 0) > 0 && (
                      <div className="mt-2 space-y-1 rounded border border-border/60 bg-background-secondary p-2">
                        <p className="text-xs font-medium text-foreground-secondary">Why reviewers didn't approve this:</p>
                        {panel!.consensus.dissent.map((d, i) => (
                          <p key={i} className="text-xs text-foreground-tertiary">
                            <span className="font-medium">{d.specialist_title}</span> ({d.stance}): {d.limitations || 'No details given.'}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="rounded bg-background-tertiary px-2 py-1 text-xs text-foreground-secondary">priority {proposal.priority.toFixed(2)}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-foreground-secondary">
                  <span>{proposal.source}</span>
                  <span>{proposal.evidenceRefs.length} evidence ref(s)</span>
                  <span>panel: {panel?.status ?? 'loading'}</span>
                  {proposal.panelId && <Link to={`/swarm-resources#panel-${proposal.panelId}`} className="text-accent hover:underline">Review panel</Link>}
                  {proposal.status !== 'proposed' ? (
                    <span className="ml-auto italic">
                      {proposal.refinedAt ? 'Refinement in progress' : 'Awaiting refinement'}
                    </span>
                  ) : canGovern ? <div className="ml-auto flex gap-2">
                    <button onClick={() => void act(proposal, 'reject')} disabled={busy === proposal.id} className="rounded border border-red-500/40 px-3 py-1 text-red-400 disabled:opacity-50">Reject</button>
                    <button onClick={() => void act(proposal, 'approve')} disabled={!ready || busy === proposal.id} title={ready ? 'Create one governed goal' : panel?.consensus.decision === 'backlog' ? 'Project this panel to backlog first' : 'Complete independent specialist consensus first'} className="rounded border border-accent/40 px-3 py-1 text-accent disabled:opacity-50">Approve goal</button>
                  </div> : <span className="ml-auto">Admin approval required</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
