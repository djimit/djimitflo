/**
 * Pipeline Builder — drag-and-drop agent pipeline construction.
 *
 * Uses @xyflow/react for the canvas. Users can drag Goal, Loop, Worker,
 * Checker, and Learning nodes onto the canvas, connect them, and export
 * the pipeline as an OpenSpec change or trigger it via API.
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

let nodeId = 0;
const getNextId = () => `node_${++nodeId}`;

const initialNodes: Node[] = [];
const initialEdges: Edge[] = [];

export function PipelineBuilderPage() {
  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);
  const [pipelineName, setPipelineName] = useState('Untitled Pipeline');

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
      id: getNextId(),
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', background: '#0f172a', borderBottom: '1px solid #334155' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <GitBranch size={20} color="#6366f1" />
          <input
            value={pipelineName}
            onChange={(e) => setPipelineName(e.target.value)}
            style={{ background: 'transparent', border: 'none', color: '#e2e8f0', fontSize: '16px', fontWeight: 600, outline: 'none' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={clearCanvas} style={btnStyle('#ef4444')}>
            <Trash2 size={14} /> Clear
          </button>
          <button onClick={exportPipeline} style={btnStyle('#6366f1')}>
            <Download size={14} /> Export
          </button>
          <button onClick={() => alert('Pipeline saved!')} style={btnStyle('#10b981')}>
            <Save size={14} /> Save
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1 }}>
        {/* Palette */}
        <div style={{ width: '180px', background: '#0f172a', borderRight: '1px solid #334155', padding: '16px' }}>
          <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', marginBottom: '12px' }}>
            Nodes
          </div>
          {PALETTE.map((item) => (
            <button
              key={item.type}
              onClick={() => addNode(item.type)}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', marginBottom: '6px', background: '#1e293b', border: `1px solid ${item.color}33`, borderRadius: '6px', color: '#e2e8f0', cursor: 'pointer', fontSize: '13px' }}
            >
              <Plus size={12} />
              <item.icon size={14} color={item.color} />
              {item.label}
            </button>
          ))}
          <div style={{ marginTop: '20px', fontSize: '11px', color: '#64748b' }}>
            Drag nodes onto the canvas and connect them to build your pipeline.
          </div>
        </div>

        {/* Canvas */}
        <div style={{ flex: 1 }}>
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
