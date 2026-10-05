import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { WebSocketEventType } from '@djimitflo/shared';
import { useWsSubscribe } from '../components/WebSocketProvider';
import { Inbox, RefreshCw } from 'lucide-react';
import { api, type DecisionsInbox, type DraftPrs } from '../lib/api';
import { usePendingApprovals } from '../hooks/usePendingApprovals';
import { ApprovalQueuePage } from './ApprovalQueuePage';

/** UX-7: the last step of the loop — its draft PRs, how old they are, and whether merge survival has settled them. */
export function DraftPrsSection() {
  const [data, setData] = useState<DraftPrs | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.getDraftPrs().then(setData, (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load draft PRs')); }, []);
  return (
    <section aria-labelledby="draft-prs">
      <h2 id="draft-prs" className="text-lg font-semibold mb-1">Loop draft PRs</h2>
      {error && <p role="alert" className="text-status-error text-sm">{error}</p>}
      {!data && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}
      {data && (data.rows.length === 0 ? <p className="text-sm text-foreground-secondary">The loop has opened no draft PR yet.</p> : (
        <>
          <p className="text-sm text-foreground-secondary mb-2">{data.total} PRs (n), {data.unsettled} not settled yet — still open, or merged less than 14 days ago; merge survival settles them after 14 days.</p>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-foreground-tertiary"><th>PR</th><th>Lane</th><th>Age (days)</th><th>Settlement</th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <tr key={r.run_id} className="border-t border-border">
                <td><a className="underline" href={r.pr_url} target="_blank" rel="noreferrer">#{r.pr_number ?? '?'}</a></td>
                <td>{r.lane}</td><td>{r.age_days}</td>
                <td>{r.outcome ? `${r.outcome}${r.survived === null ? '' : r.survived ? ' · survived' : ' · removed'}` : 'not settled'}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      ))}
    </section>
  );
}

const button = 'rounded border border-border px-2 py-0.5 text-sm hover:bg-background-tertiary disabled:opacity-50';

export function DecisionsInboxPage() {
  const [data, setData] = useState<DecisionsInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
          <section aria-labelledby="autonomy">
            <h2 id="autonomy" className="text-lg font-semibold mb-1">Earned autonomy (U1, read-only)</h2>
            <p className="text-xs text-foreground-tertiary mb-2">Per action class over 30 days. A class earns autonomy after ≥ 20 human approvals, none denied or expired, and at most one regression. Nothing is auto-approved from this table yet.</p>
            {data.autonomy.length === 0 ? <p className="text-sm text-foreground-secondary">No approvals in the last 30 days.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>Class</th><th>Human</th><th>Auto</th><th>Denied / expired</th><th>Verified</th><th>Regressed</th><th>Status</th></tr></thead>
                <tbody>{data.autonomy.map((c) => (
                  <tr key={c.cls} className="border-t border-border">
                    <td className="font-mono text-xs">{c.cls}</td><td>{c.human_approved}</td><td>{c.auto_approved}</td><td>{c.denied} / {c.expired}</td>
                    <td>{c.verified}</td><td className={c.regressed > 1 ? 'text-status-error' : ''}>{c.regressed}</td>
                    <td className={c.earned ? 'text-status-completed' : 'text-foreground-secondary'}>{c.why}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="memory">
            <h2 id="memory" className="text-lg font-semibold mb-1">Memory review</h2>
            <p className="text-xs text-foreground-tertiary mb-2">Rules and memories waiting for a human. Promoted engineering rules reach maker assignments and are then kept or dropped by their measured fitness.</p>
            {data.memory.length === 0 ? <p className="text-sm text-foreground-secondary">Nothing waiting for review.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>Memory</th><th>Type</th><th>Status</th><th /></tr></thead>
                <tbody>{data.memory.map((m) => (
                  <tr key={m.id} className="border-t border-border align-top">
                    <td><div className="font-medium">{m.title}</div><div className="text-xs text-foreground-secondary whitespace-pre-wrap">{m.content}</div></td>
                    <td>{m.memory_type}</td><td>{m.status.replace('_', ' ')}</td>
                    <td className="whitespace-nowrap space-x-1">
                      <button type="button" className={button} disabled={busy !== null} onClick={() => void act(`p-${m.id}`, () => api.promoteMemoryCandidate(m.id), `Promoted '${m.title}'`)}>Promote</button>
                      <button type="button" className={button} disabled={busy !== null} onClick={() => void act(`r-${m.id}`, () => api.rejectMemoryCandidate(m.id), `Rejected '${m.title}'`)}>Reject</button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="requeue">
            <h2 id="requeue" className="text-lg font-semibold mb-1">Requeue failed proposals</h2>
            <p className="text-xs text-foreground-tertiary mb-2">A requeue creates a new, linked attempt; the original and its outcome stay untouched. Counts against the lane budget.</p>
            {data.requeue.length === 0 ? <p className="text-sm text-foreground-secondary">No regressed or infra-failed proposal in the last 30 days.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>Proposal</th><th>Status</th><th>Reason</th><th /></tr></thead>
                <tbody>{data.requeue.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td>{r.title}<div className="text-xs text-foreground-muted">{r.id.slice(0, 8)}</div></td>
                    <td>{r.status}</td>
                    <td>{r.requeued_as ? <span className="text-foreground-muted">requeued as {r.requeued_as.slice(0, 8)}</span> : (
                      <input aria-label={`Reason for requeueing ${r.id.slice(0, 8)}`} value={reasons[r.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })}
                        placeholder="why (required)" className="w-full rounded border border-border bg-background px-2 py-0.5" />
                    )}</td>
                    <td>{!r.requeued_as && (
                      <button type="button" className={button} disabled={busy !== null || (reasons[r.id] ?? '').trim().length < 5}
                        onClick={() => void act(r.id, () => api.requeueProposal(r.id, reasons[r.id].trim()), `Requeued ${r.id.slice(0, 8)}`)}>Requeue</button>
                    )}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="prescreen">
            <h2 id="prescreen" className="text-lg font-semibold mb-1">Pre-screen rejections (D5)</h2>
            {p && (
              <p className="text-xs text-foreground-tertiary mb-2">
                Label each rejection: <strong>ok</strong> = rejecting was right, <strong>wrong</strong> = it deserved a panel. Labelled {p.labelled}, wrong {p.wrong}
                {p.false_rejection_pct !== null && <> · false-rejection rate <strong>{p.false_rejection_pct}%</strong></>} · enforce when {p.enforce_threshold}.
              </p>
            )}
            {p && p.items.length === 0 ? <p className="text-sm text-foreground-secondary">No pre-screen rejection to label.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-foreground-tertiary"><th>Proposal</th><th>Outcome</th><th>Pre-screen reason</th><th>Label</th></tr></thead>
                <tbody>{p?.items.map((i) => (
                  <tr key={i.id} className="border-t border-border align-top">
                    <td>{i.title}</td><td>{i.status}</td><td className="text-foreground-secondary">{i.reason}</td>
                    <td className="whitespace-nowrap space-x-1">
                      {(['ok', 'wrong'] as const).map((label) => (
                        <button key={label} type="button" aria-pressed={i.label === label} disabled={busy !== null}
                          className={`${button} ${i.label === label ? 'bg-background-tertiary font-semibold' : ''}`}
                          onClick={() => void act(`${i.id}-${label}`, () => api.labelPrescreen(i.id, label), `Labelled '${label}'`)}>{label}</button>
                      ))}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="telegram">
            <h2 id="telegram" className="text-lg font-semibold mb-1">Telegram allowlist (D3)</h2>
            <p className="text-xs text-foreground-tertiary mb-2">Only listed Telegram user ids are recognised; the mapped user&apos;s role decides what they may do. Chat or group membership grants nothing. Needs manage:config.</p>
            {data.telegram.length === 0 ? <p className="text-sm text-foreground-secondary">Empty — no Telegram user is recognised.</p> : (
              <table className="w-full text-sm mb-2">
                <thead><tr className="text-left text-foreground-tertiary"><th>Telegram id</th><th>User</th><th>Role</th><th>Added by</th><th /></tr></thead>
                <tbody>{data.telegram.map((t) => (
                  <tr key={t.telegram_user_id} className="border-t border-border">
                    <td>{t.telegram_user_id}</td><td>{t.email ?? t.user_id}</td><td>{t.role ?? 'missing user'}</td><td>{t.added_by}</td>
                    <td><button type="button" className={button} disabled={busy !== null} onClick={() => void act(`tg-${t.telegram_user_id}`, () => api.removeTelegramIdentity(t.telegram_user_id), `Removed ${t.telegram_user_id}`)}>Remove</button></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <form onSubmit={addIdentity} className="flex flex-wrap gap-2 items-end">
              <label className="text-sm">Telegram user id<input value={tgId} onChange={(e) => setTgId(e.target.value)} inputMode="numeric" className="block rounded border border-border bg-background px-2 py-1" /></label>
              <label className="text-sm">Djimitflo user id<input value={tgUser} onChange={(e) => setTgUser(e.target.value)} className="block rounded border border-border bg-background px-2 py-1" /></label>
              <button type="submit" className={button} disabled={busy !== null}>Add</button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
