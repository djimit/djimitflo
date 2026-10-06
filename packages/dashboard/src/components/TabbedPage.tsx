import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface TabSpec { id: string; label: string; element: ReactNode }

/**
 * Tabs backed by ?tab=, so a merged page keeps deep links (/audit?tab=logs) and the browser back button.
 * UX-25b: WAI-ARIA tabs pattern — tab ↔ tabpanel wiring, roving tabindex, Left/Right/Home/End (automatic activation).
 */
export function TabbedPage({ tabs, param = 'tab' }: { tabs: TabSpec[]; param?: string }) {
  const [params, setParams] = useSearchParams();
  const active = tabs.find((tab) => tab.id === params.get(param)) ?? tabs[0];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabId = (id: string) => `tab-${param}-${id}`;
  const panelId = (id: string) => `panel-${param}-${id}`;
  const select = (id: string) => setParams({ [param]: id }, { replace: false });
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((tab) => tab.id === active.id);
    const next = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  };
  return (
    <div>
      <div role="tablist" className="flex gap-2 border-b border-border px-8 pt-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(el) => { refs.current[tab.id] = el; }}
            id={tabId(tab.id)}
            role="tab"
            aria-selected={tab.id === active.id}
            aria-controls={panelId(tab.id)}
            tabIndex={tab.id === active.id ? 0 : -1}
            onClick={() => select(tab.id)}
            onKeyDown={onKeyDown}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${tab.id === active.id ? 'border border-b-0 border-border bg-background-secondary text-foreground' : 'text-foreground-secondary hover:text-foreground'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId(active.id)} aria-labelledby={tabId(active.id)}>{active.element}</div>
    </div>
  );
}
