import React, { useState, useEffect } from 'react';
import { authenticatedFetch, useAuthStore } from '../lib/auth-store';

interface AuditLog {
  id: string;
  resource_type: string;
  resource_id: string;
  action: string;
  metadata: string;
  timestamp: string;
}

// Values are the resource_type strings writers actually store (DF-04: `loop`
// never matched; loop events are recorded as `loop_run`).
const ENTITY_TYPES = [
  { value: 'agent', label: 'Agent' },
  { value: 'loop_run', label: 'Loop' },
  { value: 'approval', label: 'Approval' },
  { value: 'task', label: 'Task' },
];

// One scope for list and export, so an export never covers different rows than the view.
function filterParams(entityType: string, action: string): URLSearchParams {
  const params = new URLSearchParams();
  if (entityType) params.append('resource_type', entityType);
  if (action) params.append('action', action);
  return params;
}

export const AuditLogViewer: React.FC = () => {
  const { token } = useAuthStore();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [limit] = useState<number>(50);
  const [offset, setOffset] = useState<number>(0);
  const [entityType, setEntityType] = useState<string>('');
  const [action, setAction] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  const filtered = Boolean(entityType || action);

  useEffect(() => {
    if (!token) return;
    const fetchLogs = async () => {
      const params = filterParams(entityType, action);
      params.set('limit', limit.toString());
      params.set('offset', offset.toString());

      try {
        const res = await authenticatedFetch(`/audit-logs?${params.toString()}`);
        if (res.ok) {
          setError(null);
          const data = await res.json();
          const rows: AuditLog[] = Array.isArray(data) ? data : [];
          setLogs(rows);
          const moreHeader = res.headers?.get('x-has-more');
          const totalHeader = res.headers?.get('x-total-count');
          // Older servers send no paging headers: a short page means nothing more.
          setHasMore(moreHeader === null || moreHeader === undefined ? rows.length >= limit : moreHeader === 'true');
          setTotal(totalHeader ? Number(totalHeader) : null);
        } else throw new Error(`Audit request failed (${res.status})`);
      } catch (error) {
        setLogs([]);
        setHasMore(false);
        setError(error instanceof Error ? error.message : 'Audit request failed');
      } finally {
        setLoaded(true);
      }
    };
    fetchLogs();
  }, [token, limit, offset, entityType, action]);

  const changeEntityType = (value: string) => { setEntityType(value); setOffset(0); };
  const changeAction = (value: string) => { setAction(value); setOffset(0); };

  const handleExport = async (format: 'json' | 'csv') => {
    if (!token) return;
    try {
      const params = filterParams(entityType, action);
      params.set('format', format);
      const res = await authenticatedFetch(`/audit-logs/export?${params.toString()}`);
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit-logs${filtered ? '-filtered' : ''}.${format}`;
        a.click();
        URL.revokeObjectURL(url);
      } else throw new Error(`Audit export failed (${res.status})`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Audit export failed');
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Audit Log Viewer</h1>
      {error && <p role="alert">{error}</p>}

      <div className="mb-4 flex gap-4">
        <select
          aria-label="Entity type"
          value={entityType}
          onChange={(e) => changeEntityType(e.target.value)}
          className="px-3 py-1 border rounded-md"
        >
          <option value="">All Entity Types</option>
          {ENTITY_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
        </select>

        <select
          aria-label="Action"
          value={action}
          onChange={(e) => changeAction(e.target.value)}
          className="px-3 py-1 border rounded-md"
        >
          <option value="">All Actions</option>
          {[...new Set([...logs.map(log => log.action), ...(action ? [action] : [])])].map(value => <option key={value} value={value}>{value}</option>)}
        </select>

        <button
          onClick={() => handleExport('json')}
          className="px-4 py-1 bg-blue-500 text-white rounded-md"
        >
          {filtered ? 'Export filtered JSON' : 'Export all JSON'}
        </button>
        <button
          onClick={() => handleExport('csv')}
          className="px-4 py-1 bg-green-500 text-white rounded-md"
        >
          {filtered ? 'Export filtered CSV' : 'Export all CSV'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full bg-white dark:bg-gray-800">
          <thead>
            <tr>
              <th className="py-2 px-4 border">Entity Type</th>
              <th className="py-2 px-4 border">Entity ID</th>
              <th className="py-2 px-4 border">Action</th>
              <th className="py-2 px-4 border">Metadata</th>
              <th className="py-2 px-4 border">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id}>
                <td className="py-2 px-4 border">{log.resource_type}</td>
                <td className="py-2 px-4 border">{log.resource_id}</td>
                <td className="py-2 px-4 border">{log.action}</td>
                <td className="py-2 px-4 border">
                  <pre className="text-xs overflow-hidden">
                    {typeof log.metadata === 'string' ? log.metadata : JSON.stringify(log.metadata, null, 2)}
                  </pre>
                </td>
                <td className="py-2 px-4 border">{new Date(log.timestamp).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loaded && !error && logs.length === 0 && (
          <p className="py-4 text-sm text-gray-500">No audit events match these filters.</p>
        )}
      </div>

      <div className="mt-4 flex gap-4">
        <button
          onClick={() => setOffset(Math.max(0, offset - limit))}
          disabled={offset === 0}
          className="px-4 py-1 bg-gray-200 rounded-md disabled:opacity-50"
        >
          Previous
        </button>
        <button
          onClick={() => setOffset(offset + limit)}
          disabled={!hasMore}
          className="px-4 py-1 bg-gray-200 rounded-md disabled:opacity-50"
        >
          Next
        </button>
        {total !== null && (
          <span className="self-center text-sm text-gray-500">
            {logs.length === 0 ? `0 of ${total}` : `${offset + 1}–${offset + logs.length} of ${total}`}
          </span>
        )}
      </div>
    </div>
  );
};
