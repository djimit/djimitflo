import { useCallback, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

/**
 * UX-25: one accessible dialog instead of window.confirm / window.prompt (no focus management, no labels, no
 * styling, blocks the tab). Radix handles the focus trap, Escape and returning focus to the trigger.
 * Usage: const dialog = useDialog(); … if (!(await dialog.confirm('Title', 'Message'))) return; … {dialog.element}
 */
export interface DialogField { name: string; label: string; options?: string[]; required?: boolean; multiline?: boolean }
interface Request { title: string; message?: string; fields?: DialogField[]; confirmLabel?: string; resolve: (values: Record<string, string> | null) => void; returnFocus?: HTMLElement | null }

export function useDialog() {
  const [request, setRequest] = useState<Request | null>(null);
  const ask = useCallback((r: Omit<Request, 'resolve' | 'returnFocus'>) => new Promise<Record<string, string> | null>((resolve) =>
    setRequest({ ...r, resolve, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null })), []);
  const confirm = useCallback((title: string, message?: string, confirmLabel = 'Confirm') => ask({ title, message, confirmLabel }).then((v) => v !== null), [ask]);
  // the dialog unmounts on close, so Radix cannot return focus itself: give it back to whatever opened the dialog
  const close = (values: Record<string, string> | null) => { const back = request?.returnFocus; request?.resolve(values); setRequest(null); setTimeout(() => back?.focus(), 0); };
  const element = request ? <ConfirmDialog request={request} onClose={close} /> : null;
  return { ask, confirm, element };
}

function ConfirmDialog({ request, onClose }: { request: Request; onClose: (values: Record<string, string> | null) => void }) {
  const fields = request.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, ''])));
  const missing = fields.some((f) => f.required && !values[f.name]?.trim());
  const submit = (event: FormEvent) => { event.preventDefault(); if (!missing) onClose(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]))); };
  const input = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background-elevated p-5 shadow-xl">
          <form onSubmit={submit} className="space-y-4">
            <Dialog.Title className="text-base font-semibold text-foreground">{request.title}</Dialog.Title>
            {request.message ? <Dialog.Description className="text-sm text-foreground-secondary">{request.message}</Dialog.Description> : <Dialog.Description className="sr-only">{request.title}</Dialog.Description>}
            {fields.map((f) => (
              <label key={f.name} className="block space-y-1 text-sm text-foreground">
                <span>{f.label}{f.required ? ' (required)' : ''}</span>
                {f.options ? (
                  <select className={input} value={values[f.name]} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                    <option value="">Choose…</option>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.multiline ? (
                  <textarea className={input} rows={3} value={values[f.name]} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
                ) : (
                  <input className={input} value={values[f.name]} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
                )}
              </label>
            ))}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild><button type="button" className="rounded border border-border px-3 py-1.5 text-sm text-foreground-secondary hover:bg-background">Cancel</button></Dialog.Close>
              <button type="submit" disabled={missing} className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{request.confirmLabel ?? 'Confirm'}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
