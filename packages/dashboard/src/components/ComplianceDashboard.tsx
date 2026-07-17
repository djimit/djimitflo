import { useState, useCallback } from 'react';

interface Finding {
  ruleId: string;
  article: string;
  name: string;
  status: 'pass' | 'warn' | 'fail';
  severity: string;
  fix_hint: string;
}

interface ScanResult {
  scan_id: string;
  timestamp: string;
  total_checks: number;
  passed: number;
  warnings: number;
  failed: number;
  compliance_score: number;
  findings: Finding[];
}

const STATUS_COLORS = {
  pass: 'bg-green-500',
  warn: 'bg-yellow-500',
  fail: 'bg-red-500',
};

const SEVERITY_ICONS = {
  info: '○',
  warning: '△',
  error: '✕',
  critical: '⚠',
};

export function ComplianceDashboard() {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanPath, setScanPath] = useState('/Users/dlandman/djimitflo/packages/server/src');

  const triggerScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/v1/eu-ai-act/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: scanPath }),
      });
      if (!res.ok) throw new Error(`Scan failed: ${res.statusText}`);
      const data = await res.json();
      setScanResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [scanPath]);

  const byArticle = scanResult?.findings.reduce((acc, f) => {
    if (!acc[f.article]) acc[f.article] = { pass: 0, warn: 0, fail: 0 };
    acc[f.article][f.status]++;
    return acc;
  }, {} as Record<string, { pass: number; warn: number; fail: number }>);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">EU AI Act Compliance</h1>
        <div className="flex gap-3">
          <input
            type="text"
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-gray-300 w-96"
            placeholder="Codebase path..."
          />
          <button
            onClick={triggerScan}
            disabled={loading}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded text-sm font-medium"
          >
            {loading ? 'Scanning...' : 'Run Scan'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-900/50 border border-red-700 rounded text-red-300 text-sm">
          {error}
        </div>
      )}

      {scanResult && (
        <>
          {/* Score Overview */}
          <div className="grid grid-cols-4 gap-4">
            <ScoreCard label="Compliance Score" value={`${(scanResult.compliance_score * 100).toFixed(0)}%`} color="blue" />
            <ScoreCard label="Passed" value={scanResult.passed} color="green" />
            <ScoreCard label="Warnings" value={scanResult.warnings} color="yellow" />
            <ScoreCard label="Failed" value={scanResult.failed} color="red" />
          </div>

          {/* Per-Article Breakdown */}
          {byArticle && (
            <div className="bg-gray-800 rounded-lg p-4">
              <h2 className="text-lg font-semibold text-white mb-3">Per Article</h2>
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                {Object.entries(byArticle).map(([article, counts]) => (
                  <div key={article} className="bg-gray-900 rounded p-3">
                    <div className="text-sm font-medium text-gray-300 mb-2">{article}</div>
                    <div className="flex gap-2">
                      <span className="text-green-400 text-xs">{counts.pass} pass</span>
                      {counts.warn > 0 && <span className="text-yellow-400 text-xs">{counts.warn} warn</span>}
                      {counts.fail > 0 && <span className="text-red-400 text-xs">{counts.fail} fail</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Findings List */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-lg font-semibold text-white mb-3">Findings</h2>
            <div className="space-y-2">
              {scanResult.findings.filter(f => f.status !== 'pass').map((f) => (
                <div key={f.ruleId} className="bg-gray-900 rounded p-3 flex items-start gap-3">
                  <span className={`mt-0.5 w-2 h-2 rounded-full ${STATUS_COLORS[f.status]}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 font-mono">{f.ruleId}</span>
                      <span className="text-xs text-gray-500">{f.article}</span>
                      <span className="text-xs">{SEVERITY_ICONS[f.severity as keyof typeof SEVERITY_ICONS] || '○'}</span>
                    </div>
                    <div className="text-sm text-gray-200 mt-0.5">{f.name}</div>
                    {f.fix_hint && (
                      <div className="text-xs text-gray-400 mt-1">Fix: {f.fix_hint}</div>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    f.status === 'fail' ? 'bg-red-900 text-red-300' : 'bg-yellow-900 text-yellow-300'
                  }`}>{f.status}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {!scanResult && !loading && (
        <div className="text-center text-gray-500 py-12">
          Click "Run Scan" to start a compliance scan
        </div>
      )}
    </div>
  );
}

function ScoreCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  const colorMap: Record<string, string> = {
    blue: 'text-blue-400',
    green: 'text-green-400',
    yellow: 'text-yellow-400',
    red: 'text-red-400',
  };
  return (
    <div className="bg-gray-800 rounded-lg p-4 text-center">
      <div className={`text-3xl font-bold ${colorMap[color]}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-1">{label}</div>
    </div>
  );
}
