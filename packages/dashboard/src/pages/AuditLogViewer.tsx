import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../lib/auth-store';

interface AuditLog {
  id: string;
  organization_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  metadata: string;
  created_at: string;
}

export const AuditLogViewer: React.FC = () => {
  const { token } = useAuthStore();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [limit] = useState<number>(50);
  const [offset, setOffset] = useState<number>(0);
  const [entityType, setEntityType] = useState<string>('');
  const [action, setAction] = useState<string>('');

  useEffect(() => {
    if (!token) return;
    const fetchLogs = async () => {
      const params = new URLSearchParams({
        limit: limit.toString(),
        offset: offset.toString(),
      });
      if (entityType) params.append('entity_type', entityType);
      if (action) params.append('action', action);

      try {
        const res = await fetch(`/api/audit-logs?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setLogs(data);
          }
        }
      } catch {
        // ignore
      }
    };
    fetchLogs();
  }, [token, limit, offset, entityType, action]);

  const handleExport = async (format: 'json' | 'csv') => {
    if (!token) return;
    try {
      const res = await fetch(`/api/audit-logs/export?format=${format}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit-logs.${format}`;
        a.click();
      }
    } catch {
      // ignore
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Audit Log Viewer</h1>

      <div className="mb-4 flex gap-4">
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className="px-3 py-1 border rounded-md"
        >
          <option value="">All Entity Types</option>
          <option value="agent">Agent</option>
          <option value="loop">Loop</option>
          <option value="approval">Approval</option>
        </select>

        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="px-3 py-1 border rounded-md"
        >
          <option value="">All Actions</option>
          <option value="create">Create</option>
          <option value="update">Update</option>
          <option value="delete">Delete</option>
        </select>

        <button
          onClick={() => handleExport('json')}
          className="px-4 py-1 bg-blue-500 text-white rounded-md"
        >
          Export JSON
        </button>
        <button
          onClick={() => handleExport('csv')}
          className="px-4 py-1 bg-green-500 text-white rounded-md"
        >
          Export CSV
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
                <td className="py-2 px-4 border">{log.entity_type}</td>
                <td className="py-2 px-4 border">{log.entity_id}</td>
                <td className="py-2 px-4 border">{log.action}</td>
                <td className="py-2 px-4 border">
                  <pre className="text-xs overflow-hidden">
                    {typeof log.metadata === 'string' ? log.metadata : JSON.stringify(log.metadata, null, 2)}
                  </pre>
                </td>
                <td className="py-2 px-4 border">{new Date(log.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
          className="px-4 py-1 bg-gray-200 rounded-md"
        >
          Next
        </button>
      </div>
    </div>
  );
};