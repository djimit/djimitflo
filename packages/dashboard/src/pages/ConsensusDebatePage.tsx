/**
 * Consensus Debate Page — real-time multi-agent consensus visualization.
 */

import { useState, useCallback, useEffect } from 'react';
import { MessageSquare, Trophy, Plus, Play } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, primaryButton, panel } from '../components/PageHeader';

interface CouncilSession {
  id: string;
  task_description: string;
  status: string;
  final_output: string | null;
  final_confidence: number | null;
  cost_dollars: number;
  token_usage: number;
  metadata?: { failure?: { message: string; phase: string } };
}

export function ConsensusDebatePage() {
  const [sessions, setSessions] = useState<CouncilSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [independentJudge, setIndependentJudge] = useState(false);
  const [judgeModel, setJudgeModel] = useState('');

  const refresh = useCallback(async () => {
    setSessions(await api.get<CouncilSession[]>('/council/sessions'));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const createDebate = useCallback(async () => {
    if (!topic.trim()) return;
    const session = await api.post<CouncilSession>('/council/sessions', {
      task_description: topic, mode: 'council', independent_judge: independentJudge,
      ...(judgeModel.trim() ? { judge_model: judgeModel.trim() } : {}),
    });
    setSessions((current) => [session, ...current]);
    setSelected(session.id);
    setTopic('');
  }, [topic, independentJudge, judgeModel]);

  const execute = useCallback(async (id: string) => {
    await api.post(`/council/sessions/${id}/execute`);
    await refresh();
  }, [refresh]);

  const activeDebate = sessions.find((session) => session.id === selected);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Consensus Debates"
        icon={<MessageSquare className="h-7 w-7 text-accent" />}
        description="Several models answer the same question, review each other and a synthesis is produced. A failed debate shows the phase and the reason."
      />

      <div className="flex gap-2">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Enter debate topic..."
          aria-label="Debate topic"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-foreground"
        />
        <button onClick={createDebate} className={primaryButton}><Plus className="h-4 w-4" /> Create</button>
      </div>
      <div className="flex items-center gap-3 text-sm text-foreground-secondary">
        <label className="flex items-center gap-2"><input type="checkbox" checked={independentJudge} onChange={event => setIndependentJudge(event.target.checked)} /> Independent judge</label>
        {independentJudge && <input value={judgeModel} onChange={event => setJudgeModel(event.target.value)} placeholder="Optional judge model" aria-label="Judge model" className="rounded-lg border border-border bg-background px-3 py-1.5 text-foreground" />}
      </div>

      <div className="grid gap-6 md:grid-cols-[300px_1fr]">
        <div className="space-y-2">
          {sessions.map((debate) => (
            <button
              key={debate.id}
              onClick={() => setSelected(debate.id)}
              className={`w-full rounded-lg border p-3 text-left transition-colors ${selected === debate.id ? 'border-accent bg-accent/10' : 'border-border bg-background-secondary hover:bg-background-elevated'}`}
            >
              <div className="text-sm font-medium text-foreground">{debate.task_description.slice(0, 40)}</div>
              <div className={`mt-1 text-xs ${debate.status === 'failed' ? 'text-status-error' : 'text-foreground-tertiary'}`}>{debate.status}</div>
            </button>
          ))}
          {sessions.length === 0 && (
            <div className="p-6 text-center text-sm text-foreground-muted">No debates yet. Create one above.</div>
          )}
        </div>

        <div>
          {activeDebate ? (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-foreground">{activeDebate.task_description}</h2>
              {activeDebate.status === 'failed' && (
                <p role="alert" className="text-status-error">
                  Failed{activeDebate.metadata?.failure ? ` in ${activeDebate.metadata.failure.phase}: ${activeDebate.metadata.failure.message}` : ' (no reason recorded — created before failure logging)'}
                </p>
              )}
              {!activeDebate.final_output && (
                <button onClick={() => void execute(activeDebate.id)} className={primaryButton}><Play className="h-4 w-4" /> Run council</button>
              )}
              {activeDebate.final_output && (
                <div className={panel}>
                  <div className="mb-2 flex gap-2 text-foreground">
                    <Trophy className="h-4 w-4 text-status-paused" />
                    <strong>{Math.round((activeDebate.final_confidence || 0) * 100)}% confidence</strong>
                    <span className="ml-auto text-foreground-secondary">{activeDebate.token_usage} tokens · ${activeDebate.cost_dollars.toFixed(4)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-foreground-secondary">{activeDebate.final_output}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="p-12 text-center text-foreground-muted">Select a debate to view details</div>
          )}
        </div>
      </div>
    </div>
  );
}
