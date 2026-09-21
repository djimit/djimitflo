import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface TabSpec { id: string; label: string; element: ReactNode }

/** Tabs backed by ?tab=, so a merged page keeps deep links (/audit?tab=logs) and the browser back button. */
export function TabbedPage({ tabs, param = 'tab' }: { tabs: TabSpec[]; param?: string }) {
  const [params, setParams] = useSearchParams();
  const active = tabs.find((tab) => tab.id === params.get(param)) ?? tabs[0];
  return (
    <div>
      <div role="tablist" className="flex gap-2 border-b border-border px-8 pt-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active.id}
            onClick={() => setParams({ [param]: tab.id }, { replace: false })}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${tab.id === active.id ? 'border border-b-0 border-border bg-background-secondary text-foreground' : 'text-foreground-secondary hover:text-foreground'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active.element}
    </div>
  );
}
