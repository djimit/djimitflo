import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { WebSocketEventType } from '@djimitflo/shared';
import { useWsSubscribe } from '../components/WebSocketProvider';
import { Inbox, RefreshCw } from 'lucide-react';
import { api, type DecisionsInbox, type DraftPrs } from '../lib/api';
import { usePendingApprovals } from '../hooks/usePendingApprovals';
import { ApprovalQueuePage } from './ApprovalQueuePage';
import { ACTION_PERMISSIONS as P, useCan } from '../lib/permissions';
import { Button, DataTable, Section } from '../components/ui';

/** UX-7: the last step of the loop — its draft PRs, how old they are, and whether merge survival has settled them. */
export function DraftPrsSection() {
  const [data, setData] = useState<DraftPrs | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.getDraftPrs().then(setData, (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load draft PRs')); }, []);
  return (
    <Section id="draft-prs" title="Loop draft PRs" headingClassName="text-lg font-semibold mb-1">
      {error && <p role="alert" className="text-status-error text-sm">{error}</p>}
      {!data && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {data && (
        <>
          {data.rows.length > 0 && <p className="text-sm text-foreground-secondary mb-2">{data.total} PRs (n), {data.unsettled} not settled yet — still open, or merged less than 14 days ago; merge survival settles them after 14 days.</p>}
          <DataTable caption="Loop draft PRs and their settlement" rows={data.rows} rowKey={(r) => r.run_id} empty="The loop has opened no draft PR yet." columns={[
            { key: 'pr', label: 'PR', render: (r) => <a className="underline" href={r.pr_url} target="_blank" rel="noreferrer">#{r.pr_number ?? '?'}</a> },
            { key: 'lane', label: 'Lane', render: (r) => r.lane },
            { key: 'age', label: 'Age (days)', render: (r) => r.age_days },
            { key: 'settlement', label: 'Settlement', render: (r) => (r.outcome ? `${r.outcome}${r.survived === null ? '' : r.survived ? ' · survived' : ' · removed'}` : 'not settled') },
          ]} />
        </>
      )}
    </Section>
  );
}

export function DecisionsInboxPage() {
  const [data, setData] = useState<DecisionsInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canMemory = useCan(P.memoryReview); const canRequeue = useCan(P.requeueProposal); const canLabel = useCan(P.labelPrescreen); const canTelegram = useCan(P.telegramIdentity);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [tgId, setTgId] = useState('');
  const [tgUser, setTgUser] = useState('');
  const pending = usePendingApprovals();

  const load = useCallback(async () => {
    setError(null);
    try { setData(await api.getDecisionsInbox()); } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load decisions'); }
  }, []);
  // UX-3: live — poll every 30 s and refetch when an approval changes
  const subscribe = useWsSubscribe();
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 30_000);
    const offs = [WebSocketEventType.APPROVAL_REQUESTED, WebSocketEventType.APPROVAL_GRANTED, WebSocketEventType.APPROVAL_DENIED, WebSocketEventType.APPROVAL_EXPIRED]
      .map((t) => subscribe(t, () => void load()));
    return () => { clearInterval(poll); offs.forEach((off) => off()); };
  }, [load, subscribe]);

  const act = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); setNotice(done); await load(); } catch (err) { setError(err instanceof Error ? err.message : 'Action failed'); } finally { setBusy(null); }
  };

  const addIdentity = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{1,20}$/.test(tgId.trim()) || !tgUser.trim()) { setError('Telegram user id (digits) and Djimitflo user id are required'); return; }
    void act('tg-add', () => api.setTelegramIdentity(tgId.trim(), tgUser.trim()), `Telegram ${tgId.trim()} mapped`).then(() => { setTgId(''); setTgUser(''); });
  };

  const p = data?.prescreen;
  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Inbox className="w-7 h-7" />
        <h1 className="text-2xl font-bold">Decisions inbox</h1>
        <button onClick={() => void load()} className="ml-auto flex items-center gap-2 px-3 py-2 rounded-md border border-border"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>
      <p className="text-sm text-foreground-secondary">
        Everything that waits for an operator decision, starting with{' '}
        <a href="#approvals" className="underline">{pending.count} approval{pending.count === 1 ? '' : 's'} pending</a>.
      </p>
      <section className="rounded-lg border border-border p-4"><ApprovalQueuePage embedded /></section>
      <DraftPrsSection />
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {notice && <p role="status" className="text-status-completed">{notice}</p>}
      {!data && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}

      {data && (
        <>
          <Section id="autonomy" title="Earned autonomy (U1, read-only)" headingClassName="text-lg font-semibold mb-1">
            <p className="text-xs text-foreground-tertiary mb-2">Per action class over 30 days. A class earns autonomy after ≥ 20 human approvals, none denied or expired, and at most one regression. Nothing is auto-approved from this table yet.</p>
            <DataTable caption="Approvals and outcomes per action class (30 d)" rows={data.autonomy} rowKey={(c) => c.cls} empty="No approvals in the last 30 days." columns={[
              { key: 'cls', label: 'Class', render: (c) => c.cls, cellClassName: () => 'font-mono text-xs' },
              { key: 'human', label: 'Human', render: (c) => c.human_approved },
              { key: 'auto', label: 'Auto', render: (c) => c.auto_approved },
              { key: 'denied', label: 'Denied / expired', render: (c) => `${c.denied} / ${c.expired}` },
              { key: 'verified', label: 'Verified', render: (c) => c.verified },
              { key: 'regressed', label: 'Regressed', render: (c) => c.regressed, cellClassName: (c) => (c.regressed > 1 ? 'text-status-error' : undefined) },
              { key: 'status', label: 'Status', render: (c) => c.why, cellClassName: (c) => (c.earned ? 'text-status-completed' : 'text-foreground-secondary') },
            ]} />
          </Section>

          <Section id="memory" title="Memory review" headingClassName="text-lg font-semibold mb-1">
            <p className="text-xs text-foreground-tertiary mb-2">Rules and memories waiting for a human. Promoted engineering rules reach maker assignments and are then kept or dropped by their measured fitness.</p>
            <DataTable caption="Memories waiting for review" rows={data.memory} rowKey={(m) => m.id} rowClassName={() => 'align-top'} empty="Nothing waiting for review." columns={[
              { key: 'memory', label: 'Memory', render: (m) => <><div className="font-medium">{m.title}</div><div className="text-xs text-foreground-secondary whitespace-pre-wrap">{m.content}</div></> },
              { key: 'type', label: 'Type', render: (m) => m.memory_type },
              { key: 'status', label: 'Status', render: (m) => m.status.replace('_', ' ') },
              { key: 'actions', label: 'Actions', cellClassName: () => 'whitespace-nowrap space-x-1', render: (m) => (
                <>
                  <Button needs={canMemory ? undefined : P.memoryReview} disabled={busy !== null} onClick={() => void act(`p-${m.id}`, () => api.promoteMemoryCandidate(m.id), `Promoted '${m.title}'`)}>Promote</Button>
                  <Button needs={canMemory ? undefined : P.memoryReview} disabled={busy !== null} onClick={() => void act(`r-${m.id}`, () => api.rejectMemoryCandidate(m.id), `Rejected '${m.title}'`)}>Reject</Button>
                </>
              ) },
            ]} />
          </Section>

          <Section id="requeue" title="Requeue failed proposals" headingClassName="text-lg font-semibold mb-1">
            <p className="text-xs text-foreground-tertiary mb-2">A requeue creates a new, linked attempt; the original and its outcome stay untouched. Counts against the lane budget.</p>
            <DataTable caption="Regressed or infra-failed proposals (30 d)" rows={data.requeue} rowKey={(r) => r.id} rowClassName={() => 'align-top'} empty="No regressed or infra-failed proposal in the last 30 days." columns={[
              { key: 'proposal', label: 'Proposal', render: (r) => <>{r.title}<div className="text-xs text-foreground-muted">{r.id.slice(0, 8)}</div></> },
              { key: 'status', label: 'Status', render: (r) => r.status },
              { key: 'reason', label: 'Reason', render: (r) => (r.requeued_as ? <span className="text-foreground-muted">requeued as {r.requeued_as.slice(0, 8)}</span> : (
                <input aria-label={`Reason for requeueing ${r.id.slice(0, 8)}`} value={reasons[r.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })}
                  placeholder="why (required)" className="w-full rounded border border-border bg-background px-2 py-0.5" />
              )) },
              { key: 'action', label: 'Action', render: (r) => !r.requeued_as && (
                <Button needs={canRequeue ? undefined : P.requeueProposal} disabled={busy !== null || (reasons[r.id] ?? '').trim().length < 5}
                  onClick={() => void act(r.id, () => api.requeueProposal(r.id, reasons[r.id].trim()), `Requeued ${r.id.slice(0, 8)}`)}>Requeue</Button>
              ) },
            ]} />
          </Section>

          <Section id="prescreen" title="Pre-screen rejections (D5)" headingClassName="text-lg font-semibold mb-1">
            {p && (
              <p className="text-xs text-foreground-tertiary mb-2">
                Label each rejection: <strong>ok</strong> = rejecting was right, <strong>wrong</strong> = it deserved a panel. Labelled {p.labelled}, wrong {p.wrong}
                {p.false_rejection_pct !== null && <> · false-rejection rate <strong>{p.false_rejection_pct}%</strong></>} · enforce when {p.enforce_threshold}.
              </p>
            )}
            <DataTable caption="Pre-screen rejections to label" rows={p?.items ?? []} rowKey={(i) => i.id} rowClassName={() => 'align-top'} empty="No pre-screen rejection to label." columns={[
              { key: 'proposal', label: 'Proposal', render: (i) => i.title },
              { key: 'outcome', label: 'Outcome', render: (i) => i.status },
              { key: 'reason', label: 'Pre-screen reason', render: (i) => i.reason, cellClassName: () => 'text-foreground-secondary' },
              { key: 'label', label: 'Label', cellClassName: () => 'whitespace-nowrap space-x-1', render: (i) => (['ok', 'wrong'] as const).map((label) => (
                <Button key={label} needs={canLabel ? undefined : P.labelPrescreen} aria-pressed={i.label === label} disabled={busy !== null}
                  className={i.label === label ? 'bg-background-tertiary font-semibold' : ''}
                  onClick={() => void act(`${i.id}-${label}`, () => api.labelPrescreen(i.id, label), `Labelled '${label}'`)}>{label}</Button>
              )) },
            ]} />
          </Section>

          <Section id="telegram" title="Telegram allowlist (D3)" headingClassName="text-lg font-semibold mb-1">
            <p className="text-xs text-foreground-tertiary mb-2">Only listed Telegram user ids are recognised; the mapped user&apos;s role decides what they may do. Chat or group membership grants nothing. Needs manage:config.</p>
            <DataTable caption="Recognised Telegram users" rows={data.telegram} rowKey={(t) => t.telegram_user_id} empty="Empty — no Telegram user is recognised." columns={[
              { key: 'id', label: 'Telegram id', render: (t) => t.telegram_user_id },
              { key: 'user', label: 'User', render: (t) => t.email ?? t.user_id },
              { key: 'role', label: 'Role', render: (t) => t.role ?? 'missing user' },
              { key: 'by', label: 'Added by', render: (t) => t.added_by },
              { key: 'action', label: 'Action', render: (t) => (
                <Button needs={canTelegram ? undefined : P.telegramIdentity} disabled={busy !== null} onClick={() => void act(`tg-${t.telegram_user_id}`, () => api.removeTelegramIdentity(t.telegram_user_id), `Removed ${t.telegram_user_id}`)}>Remove</Button>
              ) },
            ]} />
            <form onSubmit={addIdentity} className="flex flex-wrap gap-2 items-end mt-2">
              <label className="text-sm">Telegram user id<input value={tgId} onChange={(e) => setTgId(e.target.value)} inputMode="numeric" className="block rounded border border-border bg-background px-2 py-1" /></label>
              <label className="text-sm">Djimitflo user id<input value={tgUser} onChange={(e) => setTgUser(e.target.value)} className="block rounded border border-border bg-background px-2 py-1" /></label>
              <Button type="submit" needs={canTelegram ? undefined : P.telegramIdentity} disabled={busy !== null}>Add</Button>
            </form>
          </Section>
        </>
      )}
    </div>
  );
}
