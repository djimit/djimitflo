import type { ExploreArchitectureDiagramProps } from '@djimitflo/shared';

export function ExploreArchitectureDiagram({ nodes, edges }: ExploreArchitectureDiagramProps) {
  if (nodes.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-slate-400">
        No architecture graph available for this repository.
      </div>
    );
  }

  const width = 800;
  const height = 400;
  const radius = 28;
  const cx = width / 2;
  const cy = height / 2;
  const angleStep = (2 * Math.PI) / Math.max(nodes.length, 1);

  const positions = nodes.map((node, i) => {
    const angle = i * angleStep - Math.PI / 2;
    const distance = node.kind === 'hub' ? 120 : node.kind === 'bridge' ? 180 : 240;
    return {
      ...node,
      x: cx + Math.cos(angle) * distance,
      y: cy + Math.sin(angle) * distance,
    };
  });

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 md:p-8">
      <h2 className="text-xl font-semibold text-slate-100">Architecture</h2>
      <p id="architecture-summary" className="mt-1 text-sm text-slate-400">
        Constellation view of code communities, hub nodes, and bridge connections.
      </p>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-4 w-full"
        role="img"
        aria-describedby="architecture-summary"
      >
        <rect width={width} height={height} fill="#0f172a" rx="16" />

        {edges.map((edge, i) => {
          const from = positions.find((p) => p.id === edge.from);
          const to = positions.find((p) => p.id === edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={i}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={edge.surprising ? '#fbbf24' : '#6366f1'}
              strokeWidth={edge.surprising ? 2 : 1}
              strokeDasharray={edge.surprising ? '6 4' : undefined}
            />
          );
        })}

        {positions.map((node) => (
          <g key={node.id}>
            <circle
              cx={node.x}
              cy={node.y}
              r={node.kind === 'hub' ? radius + 8 : node.kind === 'bridge' ? radius + 4 : radius}
              fill={node.kind === 'hub' ? '#6366f1' : node.kind === 'bridge' ? '#8b5cf6' : '#1e293b'}
              stroke={node.kind === 'bridge' ? '#fbbf24' : '#6366f1'}
              strokeWidth={node.kind === 'bridge' ? 3 : 2}
            />
            <text
              x={node.x}
              y={node.y + 5}
              textAnchor="middle"
              fill="#f1f5f9"
              fontSize="12"
              fontWeight={node.kind === 'hub' ? '600' : '400'}
            >
              {node.label.slice(0, 3).toUpperCase()}
            </text>
            <text
              x={node.x}
              y={node.y + radius + 20}
              textAnchor="middle"
              fill="#94a3b8"
              fontSize="11"
            >
              {node.label}
            </text>
          </g>
        ))}
      </svg>

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-indigo-500" />
          <span>Hub node</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full border-2 border-amber-400 bg-violet-500" />
          <span>Bridge node</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-0.5 w-4 bg-amber-400" />
          <span>Surprising connection</span>
        </div>
      </div>
    </section>
  );
}
