import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, RefreshCw } from 'lucide-react';
import { api, type DecisionsInbox } from '../lib/api';
import { usePendingApprovals } from '../hooks/usePendingApprovals';

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
  useEffect(() => { void load(); }, [load]);

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
        Everything that waits for an operator decision.{' '}
        <Link to="/approvals" className="underline">{pending.count} approval{pending.count === 1 ? '' : 's'} pending</Link> in the approval queue.
      </p>
      {error && <p role="alert" className="text-status-error">{error}</p>}
      {notice && <p role="status" className="text-status-completed">{notice}</p>}
      {!data && !error && <p className="text-sm text-foreground-secondary">Loading…</p>}

      {data && (
        <>
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
