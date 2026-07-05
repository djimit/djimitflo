/**
 * Consensus Debate Page — real-time multi-agent consensus visualization.
 */

import { useState, useCallback } from 'react';
import { MessageSquare, ThumbsUp, ThumbsDown, Trophy, Plus } from 'lucide-react';

interface Debate {
  id: string;
  topic: string;
  status: string;
  proposals: Array<{ id: string; agentId: string; content: string; score: number }>;
}

export function ConsensusDebatePage() {
  const [debates, setDebates] = useState<Debate[]>([]);
  const [selectedDebate, setSelectedDebate] = useState<string | null>(null);
  const [topic, setTopic] = useState('');

  const createDebate = useCallback(async () => {
    if (!topic.trim()) return;
    const response = await fetch('/api/agi/consensus/debates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, context: 'Dashboard-created debate' }),
    });
    if (response.ok) {
      const debate = await response.json();
      setDebates((prev) => [...prev, { ...debate, proposals: [] }]);
      setTopic('');
    }
  }, [topic]);

  const activeDebate = debates.find((d) => d.id === selectedDebate);

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
          {debates.map((debate) => (
            <div
              key={debate.id}
              onClick={() => setSelectedDebate(debate.id)}
              style={{
                padding: '12px', borderRadius: '6px', cursor: 'pointer',
                background: selectedDebate === debate.id ? '#eef2ff' : '#f8fafc',
                border: `1px solid ${selectedDebate === debate.id ? '#6366f1' : '#e2e8f0'}`,
              }}
            >
              <div style={{ fontWeight: 500, fontSize: '14px' }}>{debate.topic.slice(0, 40)}</div>
              <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{debate.status}</div>
            </div>
          ))}
          {debates.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
              No debates yet. Create one above.
            </div>
          )}
        </div>

        {/* Debate Detail */}
        <div>
          {activeDebate ? (
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '16px' }}>{activeDebate.topic}</h2>
              {activeDebate.proposals.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>
                  No proposals yet. Agents will submit proposals.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {activeDebate.proposals.map((proposal) => (
                    <div key={proposal.id} style={{ padding: '16px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                        <span style={{ fontWeight: 500, fontSize: '13px' }}>{proposal.agentId}</span>
                        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <Trophy size={14} color="#f59e0b" />
                          <span style={{ fontWeight: 600 }}>{(proposal.score * 100).toFixed(0)}%</span>
                        </span>
                      </div>
                      <p style={{ margin: 0, fontSize: '14px', color: '#374151' }}>{proposal.content}</p>
                      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
                        <button style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 12px', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
                          <ThumbsUp size={12} /> Agree
                        </button>
                        <button style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>
                          <ThumbsDown size={12} /> Disagree
                        </button>
                      </div>
                    </div>
                  ))}
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
