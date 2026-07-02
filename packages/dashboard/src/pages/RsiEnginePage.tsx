import { useEffect, useState } from 'react';

interface Proposal {
  id: string;
  targetService: string;
  proposalType: string;
  description: string;
  risk: string;
}

interface SafetyStatus {
  enabled: boolean;
  mutationsToday: number;
  mutationsLimit: number;
  frozenComponents: string[];
}

export function RsiEnginePage() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [safety, setSafety] = useState<SafetyStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/swarms/rsi/proposals').then(r => r.json()).catch(() => []),
      fetch('/api/swarms/rsi/safety').then(r => r.json()).catch(() => null),
    ]).then(([proposalsData, safetyData]) => {
      setProposals(Array.isArray(proposalsData) ? proposalsData : []);
      setSafety(safetyData);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="p-8">Loading RSI Engine...</div>;

  return (
    <div className="p-8 space-y-8">
      <h1 className="text-3xl font-bold">RSI Engine</h1>
      <p className="text-foreground-secondary">Recursive Self-Improvement Engine status and proposals.</p>

      {safety && (
        <div className="border rounded-lg p-4 space-y-2">
          <h2 className="text-xl font-semibold">Safety Status</h2>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <span className="text-sm text-foreground-tertiary">Status</span>
              <p className={safety.enabled ? 'text-green-600' : 'text-red-600'}>
                {safety.enabled ? 'Enabled' : 'Disabled'}
              </p>
            </div>
            <div>
              <span className="text-sm text-foreground-tertiary">Mutations Today</span>
              <p>{safety.mutationsToday} / {safety.mutationsLimit}</p>
            </div>
            <div>
              <span className="text-sm text-foreground-tertiary">Frozen Components</span>
              <p>{safety.frozenComponents.length}</p>
            </div>
          </div>
        </div>
      )}

      <div className="border rounded-lg p-4 space-y-2">
        <h2 className="text-xl font-semibold">Refactoring Proposals</h2>
        {proposals.length === 0 ? (
          <p className="text-foreground-tertiary">No pending proposals.</p>
        ) : (
          <div className="space-y-2">
            {proposals.map(p => (
              <div key={p.id} className="border rounded p-3 flex justify-between items-center">
                <div>
                  <p className="font-medium">{p.targetService}</p>
                  <p className="text-sm text-foreground-secondary">{p.description}</p>
                </div>
                <span className={`text-xs px-2 py-1 rounded ${p.risk === 'high' ? 'bg-red-100 text-red-700' : p.risk === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>
                  {p.risk}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
