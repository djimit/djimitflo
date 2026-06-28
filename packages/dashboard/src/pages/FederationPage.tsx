import { useEffect, useState } from 'react';
import { Network, Plus, Globe } from 'lucide-react';
import { api } from '../lib/api';

interface Peer {
  id: string;
  url: string;
  trust_level: string;
  registered_at: string;
  last_seen: string;
  metadata: Record<string, unknown>;
}

export function FederationPage() {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [capabilities, setCapabilities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRegister, setShowRegister] = useState(false);
  const [peerUrl, setPeerUrl] = useState('');
  const [trustLevel, setTrustLevel] = useState('medium');

  const loadData = () => {
    Promise.all([
      api.request('/federation/peers').catch(() => ({ peers: [] })),
      api.request('/federation/capabilities').catch(() => ({ capabilities: [] })),
    ]).then(([peersRes, capsRes]: any) => {
      setPeers(peersRes.peers || []);
      setCapabilities(capsRes.capabilities || []);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  const handleRegister = async () => {
    try {
      await api.request('/federation/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: peerUrl, trust_level: trustLevel }),
      });
      setShowRegister(false);
      setPeerUrl('');
      loadData();
    } catch (e) { console.error('Register failed:', e); }
  };

  if (loading) return <div className="p-8 text-foreground-tertiary">Loading federation data...</div>;

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
            <Network className="w-8 h-8 text-accent" /> Federation
          </h1>
          <p className="text-foreground-secondary mt-2">Peer discovery, claim sharing, and work distribution across DjimFlo instances</p>
        </div>
        <button onClick={() => setShowRegister(true)} className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90">
          <Plus className="w-4 h-4" /> Register Peer
        </button>
      </div>

      {showRegister && (
        <div className="bg-background-secondary border border-accent/20 rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold text-foreground">Register New Peer</h2>
          <input type="text" value={peerUrl} onChange={(e) => setPeerUrl(e.target.value)} placeholder="http://192.168.1.X:3007" className="w-full px-3 py-2 bg-background rounded border border-border text-foreground text-sm" />
          <select value={trustLevel} onChange={(e) => setTrustLevel(e.target.value)} className="px-3 py-2 bg-background rounded border border-border text-foreground text-sm">
            <option value="low">Low Trust</option>
            <option value="medium">Medium Trust</option>
            <option value="high">High Trust</option>
          </select>
          <div className="flex gap-2">
            <button onClick={handleRegister} className="px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90">Register</button>
            <button onClick={() => setShowRegister(false)} className="px-4 py-2 bg-background border border-border rounded-lg">Cancel</button>
          </div>
        </div>
      )}

      {/* Peers */}
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold text-foreground mb-4">Known Peers ({peers.length})</h2>
        {peers.length === 0 ? (
          <div className="text-center py-8 text-foreground-muted">No peers registered yet</div>
        ) : (
          <div className="space-y-3">
            {peers.map((peer) => (
              <div key={peer.id} className="flex items-center gap-4 p-4 bg-background-elevated rounded-lg border border-border">
                <Globe className="w-5 h-5 text-accent-secondary" />
                <div className="flex-1">
                  <div className="font-mono text-sm text-foreground">{peer.url}</div>
                  <div className="text-xs text-foreground-tertiary">Registered: {new Date(peer.registered_at).toLocaleDateString()}</div>
                </div>
                <span className={`px-2 py-1 rounded-full text-xs ${peer.trust_level === 'high' ? 'bg-status-active/10 text-status-active' : peer.trust_level === 'medium' ? 'bg-status-paused/10 text-status-paused' : 'bg-status-error/10 text-status-error'}`}>{peer.trust_level}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Capabilities */}
      <div className="bg-background-secondary border border-border rounded-lg p-6">
        <h2 className="text-xl font-semibold text-foreground mb-4">Local Capabilities ({capabilities.length})</h2>
        {capabilities.length === 0 ? (
          <div className="text-center py-8 text-foreground-muted">No capabilities available for sync</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {capabilities.map((cap: any) => (
              <div key={cap.id} className="p-4 bg-background-elevated rounded-lg border border-border">
                <div className="font-mono text-sm text-foreground">{cap.id.slice(0, 20)}</div>
                <div className="text-xs text-foreground-tertiary mt-1">Status: {cap.status} · Kind: {cap.kind}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
