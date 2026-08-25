/**
 * Consensus Debate Page — real-time multi-agent consensus visualization.
 */

import { useState, useCallback, useEffect } from 'react';
import { MessageSquare, Trophy, Plus, Play } from 'lucide-react';
import { api } from '../lib/api';

interface CouncilSession {
  id: string;
  task_description: string;
  status: string;
  final_output: string | null;
  final_confidence: number | null;
  cost_dollars: number;
  token_usage: number;
}

export function ConsensusDebatePage() {
  const [sessions, setSessions] = useState<CouncilSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [topic, setTopic] = useState('');

  const refresh = useCallback(async () => {
    setSessions(await api.get<CouncilSession[]>('/council/sessions'));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const createDebate = useCallback(async () => {
    if (!topic.trim()) return;
    const session = await api.post<CouncilSession>('/council/sessions', { task_description: topic, mode: 'council' });
    setSessions((current) => [session, ...current]);
    setSelected(session.id);
    setTopic('');
  }, [topic]);

  const execute = useCallback(async (id: string) => {
    await api.post(`/council/sessions/${id}/execute`);
    await refresh();
  }, [refresh]);

  const activeDebate = sessions.find((session) => session.id === selected);

  return (
    <div style={{ padding: '24px', maxWidth: '1200px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <MessageSquare size={28} color="#6366f1" />
        <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Consensus Debates</h1>
      </div>

      {/* Create Debate */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Enter debate topic..."
          style={{ flex: 1, padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '6px' }}
        />
        <button onClick={createDebate} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', background: '#6366f1', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
          <Plus size={14} /> Create
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '24px' }}>
        {/* Debate List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {sessions.map((debate) => (
            <div
              key={debate.id}
              onClick={() => setSelected(debate.id)}
              style={{
                padding: '12px', borderRadius: '6px', cursor: 'pointer',
                background: selected === debate.id ? '#eef2ff' : '#f8fafc',
                border: `1px solid ${selected === debate.id ? '#6366f1' : '#e2e8f0'}`,
              }}
            >
              <div style={{ fontWeight: 500, fontSize: '14px' }}>{debate.task_description.slice(0, 40)}</div>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{debate.status}</div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
              No debates yet. Create one above.
            </div>
          )}
        </div>

        {/* Debate Detail */}
        <div>
          {activeDebate ? (
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>{activeDebate.task_description}</h2>
              {!activeDebate.final_output && (
                <button onClick={() => void execute(activeDebate.id)} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', background: '#6366f1', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
                  <Play size={14} /> Run council
                </button>
              )}
              {activeDebate.final_output && (
                <div style={{ padding: '16px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0', marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                    <Trophy size={14} color="#f59e0b" />
                    <strong>{Math.round((activeDebate.final_confidence || 0) * 100)}% confidence</strong>
                    <span style={{ marginLeft: 'auto' }}>{activeDebate.token_usage} tokens · ${activeDebate.cost_dollars.toFixed(4)}</span>
                  </div>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{activeDebate.final_output}</p>
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: '48px', textAlign: 'center', color: '#94a3b8' }}>
              Select a debate to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
