/**
 * Pipeline Builder — drag-and-drop agent pipeline construction.
 *
 * Uses @xyflow/react for the canvas. Users can drag Goal, Loop, Worker,
 * Checker, and Learning nodes onto the canvas, connect them, and export
 * the design as JSON. Drafts are local to this browser; execution is not supported.
 */

import { useCallback, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeProps,
  Handle,
  Position,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Save, Download, Plus, GitBranch, Target, Wrench, CheckCircle, BrainCircuit, Trash2 } from 'lucide-react';

type NodeType = 'goal' | 'loop' | 'worker' | 'checker' | 'learning';

interface PaletteItem {
  type: NodeType;
  label: string;
  icon: typeof Target;
  color: string;
}

const PALETTE: PaletteItem[] = [
  { type: 'goal', label: 'Goal', icon: Target, color: '#3b82f6' },
  { type: 'loop', label: 'Loop', icon: GitBranch, color: '#8b5cf6' },
  { type: 'worker', label: 'Worker', icon: Wrench, color: '#10b981' },
  { type: 'checker', label: 'Checker', icon: CheckCircle, color: '#f59e0b' },
  { type: 'learning', label: 'Learning', icon: BrainCircuit, color: '#ec4899' },
];

function PipelineNode({ data }: NodeProps) {
  const item = PALETTE.find((p) => p.type === (data as { nodeType: NodeType }).nodeType);
  const color = item?.color || '#6b7280';

  return (
    <div style={{
      padding: '12px 16px',
      borderRadius: '8px',
      border: `2px solid ${color}`,
      background: '#1e293b',
      color: '#e2e8f0',
      minWidth: '140px',
      fontSize: '13px',
      fontWeight: 500,
    }}>
      <Handle type="target" position={Position.Top} style={{ background: color }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        {item && <item.icon size={14} color={color} />}
        <span>{(data as { label: string }).label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: color }} />
    </div>
  );
}

const nodeTypes = { pipeline: PipelineNode };

const DRAFT_KEY = 'djimitflo_pipeline_draft';

function loadDraft(): { name: string; nodes: Node[]; edges: Edge[]; error: string | null } {
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) {
      const draft = JSON.parse(saved);
      if (typeof draft?.name !== 'string' || !Array.isArray(draft.nodes) || !Array.isArray(draft.edges)
        || !draft.nodes.every((node: Node) => node && typeof node.id === 'string' && node.type === 'pipeline'
          && Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y)
          && typeof node.data?.label === 'string' && PALETTE.some(item => item.type === node.data?.nodeType))
        || new Set(draft.nodes.map((node: Node) => node.id)).size !== draft.nodes.length
        || !draft.edges.every((edge: Edge) => edge && typeof edge.id === 'string'
          && draft.nodes.some((node: Node) => node.id === edge.source) && draft.nodes.some((node: Node) => node.id === edge.target))) {
        throw new Error('Invalid draft');
      }
      return { ...draft, error: null };
    }
  } catch {
    return { name: 'Untitled Pipeline', nodes: [], edges: [], error: 'Saved draft could not be loaded. The original remains in browser storage until you save a replacement.' };
  }
  return { name: 'Untitled Pipeline', nodes: [], edges: [], error: null };
}

export function PipelineBuilderPage() {
  const [draft] = useState(loadDraft);
  const [nodes, setNodes] = useState<Node[]>(draft.nodes);
  const [edges, setEdges] = useState<Edge[]>(draft.edges);
  const [pipelineName, setPipelineName] = useState(draft.name);
  const [message, setMessage] = useState<string | null>(draft.error);

  const saveDraft = () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: pipelineName, nodes, edges }));
      setMessage('Draft saved in this browser.');
    } catch {
      setMessage('Draft could not be saved. Export JSON to keep your work.');
    }
  };

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );

  const onConnect: OnConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: '#6366f1' } }, eds)),
    [],
  );

  const addNode = useCallback((type: NodeType) => {
    const item = PALETTE.find((p) => p.type === type)!;
    const newNode: Node = {
      id: crypto.randomUUID(),
      type: 'pipeline',
      position: { x: 100 + Math.random() * 300, y: 100 + Math.random() * 200 },
      data: { label: item.label, nodeType: type },
    };
    setNodes((nds) => [...nds, newNode]);
  }, []);

  const clearCanvas = useCallback(() => {
    setNodes([]);
    setEdges([]);
  }, []);

  const exportPipeline = useCallback(() => {
    const pipeline = {
      name: pipelineName,
      nodes: nodes.map((n) => ({ id: n.id, type: (n.data as { nodeType: NodeType }).nodeType, position: n.position })),
      edges: edges.map((e) => ({ source: e.source, target: e.target })),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(pipeline, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${pipelineName.replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [nodes, edges, pipelineName]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', background: '#0f172a', borderBottom: '1px solid #334155' }}>
        <div style={{ display: 'flex', minWidth: 0, maxWidth: '100%', alignItems: 'center', gap: '12px' }}>
          <GitBranch size={20} color="#6366f1" />
          <input
            value={pipelineName}
            onChange={(e) => setPipelineName(e.target.value)}
            aria-label="Pipeline name"
            style={{ minWidth: 0, width: '100%', background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: '16px', fontWeight: 600, outline: 'none' }}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
          <button onClick={clearCanvas} style={btnStyle('#ef4444')}>
            <Trash2 size={14} /> Clear
          </button>
          <button onClick={exportPipeline} style={btnStyle('#6366f1')}>
            <Download size={14} /> Export
          </button>
          <button onClick={saveDraft} style={btnStyle('#10b981')}>
            <Save size={14} /> Save draft locally
          </button>
        </div>
      </div>

      <p role="status" className="px-5 py-2 text-sm text-foreground-secondary">{message || 'Design and export a pipeline. Drafts stay in this browser; this canvas does not execute agents.'}</p>

      <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
        {/* Palette */}
        <div className="w-full sm:w-44 shrink-0" style={{ background: '#0f172a', borderRight: '1px solid #334155', padding: '16px' }}>
          <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', marginBottom: '12px' }}>
            Nodes
          </div>
          <div className="flex gap-2 overflow-x-auto sm:block">
          {PALETTE.map((item) => (
            <button
              key={item.type}
              onClick={() => addNode(item.type)}
              style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: '8px', padding: '8px 12px', marginBottom: '6px', background: '#1e293b', border: `1px solid ${item.color}33`, borderRadius: '6px', color: '#e2e8f0', cursor: 'pointer', fontSize: '13px' }}
            >
              <Plus size={12} />
              <item.icon size={14} color={item.color} />
              {item.label}
            </button>
          ))}
          </div>
          <div style={{ marginTop: '20px', fontSize: '11px', color: '#64748b' }}>
            Drag nodes onto the canvas and connect them to build your pipeline.
          </div>
        </div>

        {/* Canvas */}
        <div style={{ flex: 1, minHeight: '250px', minWidth: 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            fitView
            style={{ background: '#020617' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1e293b" />
            <Controls />
            <MiniMap nodeColor="#6366f1" maskColor="#0f172a80" />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}

function btnStyle(color: string): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px',
    background: `${color}22`,
    border: `1px solid ${color}44`,
    borderRadius: '6px',
    color: '#e2e8f0',
    cursor: 'pointer',
    fontSize: '13px',
  };
}
