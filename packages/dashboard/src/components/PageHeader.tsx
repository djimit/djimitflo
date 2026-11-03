import type { ReactNode } from 'react';

/** One title block for every page: h1, one line of what the page is for, and the page's actions. */
export function PageHeader({ title, description, icon, actions }: { title: string; description?: string; icon?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-3 text-3xl font-bold text-foreground">{icon}{title}</h1>
        {description && <p className="mt-2 text-foreground-secondary">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export const primaryButton = 'inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50';
export const panel = 'rounded-lg border border-border bg-background-secondary p-4';
