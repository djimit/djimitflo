/**
 * Spec Compliance Widget — displays SDD v1.1.0 compliance metrics
 * with expandable detail view per spec.
 *
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
  const [expandedSpec, setExpandedSpec] = useState<string | null>(null);

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
            <div key={spec.specName} className="bg-gray-900 rounded overflow-hidden">
              <button
                onClick={() => setExpandedSpec(expandedSpec === spec.specName ? null : spec.specName)}
                className="w-full flex items-center gap-3 p-2 hover:bg-gray-800 transition-colors text-left"
              >
                <span className="text-xs text-gray-400 flex-1 truncate">{spec.specName}</span>
                <div className="flex gap-0.5">
                  {spec.layers.map(layer => (
                    <span
                      key={layer.layer}
                      className={`w-3 h-3 rounded-sm ${layer.present ? 'bg-green-500' : 'bg-red-500'}`}
                      title={`${layer.layer}: ${layer.name}`}
                    />
                  ))}
                </div>
                <span className={`text-xs font-mono min-w-[3rem] text-right ${spec.fullCompliance ? 'text-green-400' : spec.score >= 3 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {spec.score}/7
                </span>
              </button>

              {expandedSpec === spec.specName && (
                <div className="border-t border-gray-700 p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <span className="px-2 py-0.5 rounded bg-gray-700">{spec.lifecycleState}</span>
                    <span className="truncate">{spec.path}</span>
                  </div>
                  <div className="grid grid-cols-1 gap-1">
                    {spec.layers.map(layer => (
                      <div key={layer.layer} className="flex items-center gap-2 text-xs">
                        <span className={`w-2 h-2 rounded-full ${layer.present ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className="text-gray-400 w-6">{layer.layer}</span>
                        <span className={layer.present ? 'text-gray-300' : 'text-red-400'}>{layer.name}</span>
                        {!layer.present && (
                          <span className="text-yellow-500 ml-auto">Missing</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {!spec.fullCompliance && (
                    <div className="mt-2 p-2 bg-yellow-900/30 border border-yellow-700/50 rounded text-xs text-yellow-300">
                      <strong>Action required:</strong> Add missing layers to achieve full SDD compliance. Missing: {spec.layers.filter(l => !l.present).map(l => l.layer).join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {report.specs.length === 0 && (
        <div className="text-center text-gray-500 py-4 text-sm">
          No specs found in specs/ directory
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
