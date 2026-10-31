import { useMemo, useState } from 'react';
import type { SocialAgentPresence } from '../../lib/api';
import { agentHue } from './model';

/** UX-28: the agent list with its capability search; focusing an agent is the page's call. */
export function AgentList({ agents, focusAgent, onFocus }: { agents: SocialAgentPresence[]; focusAgent: string | null; onFocus: (id: string) => void }) {
  const [capabilityQuery, setCapabilityQuery] = useState('');
  const filteredAgents = useMemo(() => {
    const query = capabilityQuery.trim().toLowerCase();
    if (!query) return agents;
    return agents.filter((agent) => agent.capabilities.some((capability) => capability.toLowerCase().includes(query)));
  }, [agents, capabilityQuery]);
  return (
    <>
      <input
        type="text"
        value={capabilityQuery}
        onChange={(event) => setCapabilityQuery(event.target.value)}
        placeholder="Search by capability..."
        className="mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-foreground-tertiary"
      />
      <ul className="mt-2 space-y-1">
        {filteredAgents.map((agent) => (
          <li key={agent.id}><button type="button" onClick={() => onFocus(agent.id)} className={`flex w-full flex-col gap-1 rounded-lg px-2 py-1.5 text-left text-xs ${focusAgent === agent.id ? 'bg-accent/10' : 'hover:bg-background-elevated'}`}>
            <span className="flex w-full items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `hsl(${agentHue(agent.id)} 80% 60%)`, boxShadow: agent.present ? `0 0 8px hsl(${agentHue(agent.id)} 80% 60%)` : 'none', opacity: agent.present ? 1 : 0.4 }} />
              <span className="truncate font-medium text-foreground">{agent.name}</span>
              {!!agent.activity?.length && <span className="truncate text-foreground-tertiary" title={agent.activity.map((a) => a.action).join(', ')}>{agent.activity[0].action}</span>}
              <span className="ml-auto truncate text-foreground-tertiary">{agent.present ? agent.runtime || 'present' : 'silent'}</span>
            </span>
            {!!agent.capabilities?.length && (
              <span className="flex flex-wrap gap-1 pl-4">
                {agent.capabilities.map((capability) => (
                  <span key={capability} className="rounded-full border border-border px-1.5 py-0.5 text-xs text-foreground-tertiary">{capability}</span>
                ))}
              </span>
            )}
          </button></li>
        ))}
        {!filteredAgents.length && !!agents.length && <li className="px-2 py-3 text-xs text-foreground-tertiary">No agent with a capability matching "{capabilityQuery}".</li>}
        {!agents.length && <li className="px-2 py-3 text-xs text-foreground-tertiary">No agent has checked in yet. A runtime checks in with a token-authenticated social-runtime heartbeat and then appears here.</li>}
      </ul>
    </>
  );
}
