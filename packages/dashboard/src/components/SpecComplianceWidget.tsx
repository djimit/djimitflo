/**
 * Spec Compliance Widget — displays SDD v11.0 compliance metrics.
 * Constitution v1.1.0 — Specification Quality Gates
 */
import { useState, useEffect, useCallback } from 'react';

interface LayerCompliance {
  layer: string;
  name: string;
  present: boolean;
  evidence: string;
}

interface SpecComplianceResult {
  specName: string;
  path: string;
  lifecycleState: string;
  layers: LayerCompliance[];
  score: number;
  fullCompliance: boolean;
}

interface ComplianceReport {
  generatedAt: string;
  totalSpecs: number;
  fullComplianceCount: number;
  partialCount: number;
  noneCount: number;
  specs: SpecComplianceResult[];
}

export function SpecComplianceWidget() {
  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/compliance/specs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  if (loading) return <div className="text-gray-400 text-sm">Scanning specs...</div>;
  if (error) return <div className="text-red-400 text-sm">Error: {error}</div>;
  if (!report) return null;

  return (
    <div className="bg-gray-800 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">SDD Compliance</h3>
        <button
          onClick={fetchReport}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <MetricCard label="Total Specs" value={report.totalSpecs} color="blue" />
        <MetricCard label="Full Compliance" value={report.fullComplianceCount} color="green" />
        <MetricCard label="Partial" value={report.partialCount} color="yellow" />
        <MetricCard label="Non-Compliant" value={report.noneCount} color="red" />
      </div>

      {report.specs.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-300">Per-Spec Score</h4>
          {report.specs.map(spec => (
            <div key={spec.specName} className="flex items-center gap-3 bg-gray-900 rounded p-2">
              <span className="text-xs text-gray-400 flex-1 truncate">{spec.specName}</span>
              <div className="flex gap-0.5">
                {spec.layers.map(layer => (
                  <span
                    key={layer.layer}
                    className={`w-3 h-3 rounded-sm ${layer.present ? 'bg-green-500' : 'bg-red-500'}`}
                    title={`${layer.layer}: ${layer.name} — ${layer.present ? 'Present' : 'Missing'}`}
                  />
                ))}
              </div>
              <span className={`text-xs font-mono ${spec.fullCompliance ? 'text-green-400' : 'text-yellow-400'}`}>
                {spec.score}/7
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: number; color: string }) {
  const colors: Record<string, string> = {
    blue: 'text-blue-400', green: 'text-green-400', yellow: 'text-yellow-400', red: 'text-red-400',
  };
  return (
    <div className="text-center">
      <div className={`text-xl font-bold ${colors[color]}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
