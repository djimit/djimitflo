import { useEffect, useState } from 'react';

interface SwarmResult {
  id: string;
  topic: string;
  domains: string[];
  verdict: { score: number; confidence: number; verification_status: string };
  knowledge_updated: boolean;
  duration_ms: number;
}

export function ExpertSwarmPage() {
  const [history, setHistory] = useState<SwarmResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/swarms/expert/history')
      .then(r => r.json())
      .then(data => { setHistory(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8">Loading Expert Swarm...</div>;

  return (
    <div className="p-8 space-y-8">
      <h1 className="text-3xl font-bold">Expert Swarm</h1>
      <p className="text-foreground-secondary">Knowledge acquisition and evaluation history.</p>

      <div className="border rounded-lg p-4 space-y-2">
        <h2 className="text-xl font-semibold">Swarm History</h2>
        {history.length === 0 ? (
          <p className="text-foreground-tertiary">No expert swarm runs yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map(s => (
              <div key={s.id} className="border rounded p-3">
                <div className="flex justify-between">
                  <p className="font-medium">{s.topic}</p>
                  <span className={`text-xs px-2 py-1 rounded ${s.verdict.score >= 70 ? 'bg-green-100 text-green-700' : s.verdict.score >= 50 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}>
                    Score: {s.verdict.score}
                  </span>
                </div>
                <p className="text-sm text-foreground-secondary">
                  Domains: {s.domains.join(', ')} | Confidence: {s.verdict.confidence.toFixed(2)} | Status: {s.verdict.verification_status}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
