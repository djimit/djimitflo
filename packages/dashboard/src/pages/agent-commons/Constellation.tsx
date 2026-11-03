import { LURE_COLOR, STAGE, type ConstellationEdge, type ConstellationNode } from './model';

/** A line joins two agents that took part in the same thread (co-participation) — not a record that they communicated or learned. */
export const CONSTELLATION_LEGEND = 'Lines join agents that took part in the same thread (co-participation), not proof that they communicated or learned from each other. Width = shared threads; colour = furthest stage any shared thread reached.';

const pairLabel = (edge: ConstellationEdge, name: (id: string) => string) =>
  `${name(edge.from)} and ${name(edge.to)}: same thread, ${edge.count} shared ${edge.count === 1 ? 'thread' : 'threads'}, furthest stage ${STAGE[edge.stage].label}`;

/** The constellation's edges as a table (W3C complex-image long description): one row per drawn line. */
export function ConstellationEdgeTable({ nodes, edges }: { nodes: ConstellationNode[]; edges: ConstellationEdge[] }) {
  const name = (id: string) => nodes.find((node) => node.id === id)?.name || id;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-foreground-secondary">Same-thread pairs as a table ({edges.length})</summary>
      {edges.length ? (
        <table className="mt-2 w-full" aria-label="Agent pairs that took part in the same thread">
          <thead><tr className="text-left text-foreground-tertiary"><th scope="col" className="py-1">Agent A</th><th scope="col">Agent B</th><th scope="col" className="text-right">Shared threads</th><th scope="col" className="pl-2">Furthest stage</th></tr></thead>
          <tbody>{edges.map((edge) => (
            <tr key={`${edge.from}:${edge.to}`} className="border-t border-border" data-testid="constellation-pair">
              <td className="py-1 pr-2 text-foreground">{name(edge.from)}</td>
              <td className="py-1 pr-2 text-foreground">{name(edge.to)}</td>
              <td className="py-1 text-right tabular-nums">{edge.count}</td>
              <td className="py-1 pl-2">{STAGE[edge.stage].label}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <p className="mt-2 text-foreground-tertiary">No two agents share a thread yet.</p>}
    </details>
  );
}

export function Constellation({ nodes, edges, focus, highlight, onSelect }: { nodes: ConstellationNode[]; edges: ConstellationEdge[]; focus: string | null; highlight: string[]; onSelect: (id: string) => void }) {
  const name = (id: string) => nodes.find((node) => node.id === id)?.name || id;
  return (
    <svg viewBox="0 0 320 320" role="img" aria-label={`Agent constellation: ${nodes.length} agents, ${edges.length} same-thread pairs. ${CONSTELLATION_LEGEND}`} className="w-full rounded-lg bg-background">
      <defs><radialGradient id="commons-glow"><stop offset="0%" stopColor="rgb(60 120 255)" stopOpacity="0.25" /><stop offset="100%" stopColor="rgb(60 120 255)" stopOpacity="0" /></radialGradient></defs>
      <circle cx="160" cy="160" r="150" fill="url(#commons-glow)" />
      {edges.map((edge) => {
        const lit = highlight.includes(edge.from) && highlight.includes(edge.to);
        const dim = focus && edge.from !== focus && edge.to !== focus;
        return <line key={`${edge.from}:${edge.to}`} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke={STAGE[edge.stage].color} strokeWidth={Math.min(6, 1 + edge.count)} strokeOpacity={dim ? 0.1 : lit ? 0.95 : 0.4} strokeDasharray={lit ? '6 6' : undefined} className={lit ? 'commons-flow' : undefined} strokeLinecap="round"><title>{pairLabel(edge, name)}</title></line>;
      })}
      {nodes.map((node) => {
        const color = `hsl(${node.hue} 80% 60%)`;
        const dim = focus && focus !== node.id;
        return (
          <g key={node.id} onClick={() => onSelect(node.id)} className="cursor-pointer" opacity={dim ? 0.35 : 1}>
            {node.present && <circle cx={node.x} cy={node.y} r={14} fill={color} opacity={0.25} className="commons-pulse" />}
            {node.lured
              ? <circle cx={node.x} cy={node.y} r={9} fill="none" stroke={LURE_COLOR} strokeWidth={2} strokeDasharray="3 3" className="commons-flow" />
              : <circle cx={node.x} cy={node.y} r={8 + Math.min(6, node.threads)} fill={color} stroke="rgb(12 12 14)" strokeWidth={2} />}
            <text x={node.x} y={node.y + 26} textAnchor="middle" fontSize="10" fill="rgb(200 200 205)">{node.name.length > 14 ? `${node.name.slice(0, 13)}...` : node.name}</text>
          </g>
        );
      })}
      {!nodes.length && <text x="160" y="164" textAnchor="middle" fontSize="12" fill="rgb(100 100 115)">still empty</text>}
    </svg>
  );
}
