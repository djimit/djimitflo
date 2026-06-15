import { Activity, ExternalLink, Lock, Network, Server, ShieldCheck, Terminal } from 'lucide-react';

type Reachability = 'ok' | 'auth' | 'redirect' | 'not-found' | 'unavailable' | 'tcp' | 'not-probed';
type Exposure = 'LAN' | 'Localhost' | 'System' | 'Internal';

interface WorkstationEndpoint {
  port: string;
  service: string;
  type: string;
  exposure: Exposure;
  endpoint: string;
  health?: string;
  reachability: Reachability;
  detail: string;
}

interface ListenerFinding {
  bind: string;
  ports: string;
  detail: string;
}

const workstationHost = '192.168.1.28';
const registryUpdated = '2026-06-12';
const verifiedAt = '2026-06-14 17:12 UTC';

const primaryEndpoints: WorkstationEndpoint[] = [
  {
    port: '4000',
    service: 'LiteLLM Proxy',
    type: 'AI gateway',
    exposure: 'LAN',
    endpoint: `http://${workstationHost}:4000/v1`,
    health: `http://${workstationHost}:4000/health`,
    reachability: 'auth',
    detail: 'Main OpenAI-compatible base URL. Health probe returned 401, which matches the registry expectation for auth-protected access.',
  },
  {
    port: '11434',
    service: 'Ollama',
    type: 'AI inference',
    exposure: 'LAN',
    endpoint: `http://${workstationHost}:11434`,
    health: `http://${workstationHost}:11434/api/version`,
    reachability: 'ok',
    detail: 'Local model endpoint. Health probe returned 200.',
  },
  {
    port: '6333',
    service: 'Qdrant HTTP',
    type: 'Vector DB',
    exposure: 'LAN',
    endpoint: `http://${workstationHost}:6333`,
    health: `http://${workstationHost}:6333/collections`,
    reachability: 'auth',
    detail: 'Vector database HTTP API. Probe returned 401, so auth is required.',
  },
  {
    port: '8007',
    service: 'Knowledge MCP',
    type: 'MCP',
    exposure: 'LAN',
    endpoint: `http://${workstationHost}:8007`,
    health: `http://${workstationHost}:8007/health`,
    reachability: 'auth',
    detail: 'Knowledge service. Probe returned 401, so auth is required.',
  },
];

const serviceEndpoints: WorkstationEndpoint[] = [
  { port: '22', service: 'SSH', type: 'System', exposure: 'System', endpoint: `ssh://djimit@${workstationHost}:22`, reachability: 'tcp', detail: 'SSH alias: workstation.' },
  { port: '25', service: 'Postfix', type: 'System', exposure: 'System', endpoint: `smtp://${workstationHost}:25`, reachability: 'tcp', detail: 'Registry marks this as local-only mail handling despite a system listener.' },
  { port: '80', service: 'Caddy od-proxy', type: 'Reverse proxy', exposure: 'LAN', endpoint: `http://${workstationHost}`, reachability: 'not-probed', detail: 'Open Design proxy from the live registry.' },
  { port: '443', service: 'Tailscale', type: 'VPN', exposure: 'LAN', endpoint: `https://${workstationHost}`, reachability: 'not-probed', detail: 'Tailscale-bound service from the live registry.' },
  { port: '631', service: 'CUPS', type: 'System', exposure: 'System', endpoint: `ipp://${workstationHost}:631`, reachability: 'tcp', detail: 'Printer service listener.' },
  { port: '2026', service: 'DeerFlow', type: 'Web UI', exposure: 'LAN', endpoint: `http://${workstationHost}:2026`, health: `http://${workstationHost}:2026/api/health`, reachability: 'auth', detail: 'Health probe returned 401.' },
  { port: '2718', service: 'Marimo Notebooks', type: 'Data science', exposure: 'Localhost', endpoint: 'http://127.0.0.1:2718', reachability: 'ok', detail: 'Probe from workstation localhost returned 200.' },
  { port: '3000', service: 'Open-WebUI', type: 'Web UI', exposure: 'LAN', endpoint: `http://${workstationHost}:3000`, reachability: 'ok', detail: 'LAN probe returned 200.' },
  { port: '3001', service: 'Presenton UI', type: 'UI', exposure: 'LAN', endpoint: `http://${workstationHost}:3001`, reachability: 'ok', detail: 'Registry marks this localhost-only, but the live listener and LAN probe show it is reachable; probe returned 200.' },
  { port: '3002', service: 'Ruflo MCP Bridge', type: 'API', exposure: 'LAN', endpoint: `http://${workstationHost}:3002`, reachability: 'not-found', detail: 'LAN probe returned 404 on root.' },
  { port: '3010', service: 'Langfuse', type: 'Observability', exposure: 'LAN', endpoint: `http://${workstationHost}:3010`, health: `http://${workstationHost}:3010/api/health`, reachability: 'not-found', detail: 'Registry health path returned 404 during probe.' },
  { port: '4000', service: 'LiteLLM Proxy', type: 'AI gateway', exposure: 'LAN', endpoint: `http://${workstationHost}:4000/v1`, health: `http://${workstationHost}:4000/health`, reachability: 'auth', detail: 'OpenAI-compatible base URL. Health probe returned 401.' },
  { port: '5432', service: 'PostgreSQL LangGraph', type: 'Database', exposure: 'LAN', endpoint: `postgresql://${workstationHost}:5432`, reachability: 'tcp', detail: 'TCP database endpoint; not HTTP-probed.' },
  { port: '5434', service: 'RuVector Postgres', type: 'Database', exposure: 'Localhost', endpoint: 'postgresql://127.0.0.1:5434', reachability: 'tcp', detail: 'Localhost-only database endpoint.' },
  { port: '5678', service: 'n8n', type: 'Automation', exposure: 'LAN', endpoint: `http://${workstationHost}:5678`, health: `http://${workstationHost}:5678/healthz`, reachability: 'ok', detail: 'LAN health probe returned 200.' },
  { port: '5680', service: 'Grafana', type: 'Monitoring', exposure: 'Localhost', endpoint: 'http://127.0.0.1:5680', reachability: 'unavailable', detail: 'Registry has this service, but localhost probe did not return a response.' },
  { port: '6333', service: 'Qdrant HTTP', type: 'Vector DB', exposure: 'LAN', endpoint: `http://${workstationHost}:6333`, health: `http://${workstationHost}:6333/collections`, reachability: 'auth', detail: 'Probe returned 401.' },
  { port: '6334', service: 'Qdrant gRPC', type: 'Vector DB', exposure: 'LAN', endpoint: `grpc://${workstationHost}:6334`, reachability: 'tcp', detail: 'gRPC endpoint; not HTTP-probed.' },
  { port: '6379', service: 'Redis Langfuse', type: 'Cache', exposure: 'Internal', endpoint: 'redis://127.0.0.1:6379', reachability: 'tcp', detail: 'Registry marks this as container-internal.' },
  { port: '7474', service: 'Neo4j HTTP', type: 'Graph DB', exposure: 'LAN', endpoint: `http://${workstationHost}:7474`, reachability: 'ok', detail: 'LAN probe returned 200.' },
  { port: '7687', service: 'Neo4j Bolt', type: 'Graph DB', exposure: 'LAN', endpoint: `bolt://${workstationHost}:7687`, reachability: 'tcp', detail: 'Bolt endpoint; not HTTP-probed.' },
  { port: '8000', service: 'Research Agent', type: 'AI', exposure: 'LAN', endpoint: `http://${workstationHost}:8000`, health: `http://${workstationHost}:8000/health`, reachability: 'ok', detail: 'LAN health probe returned 200.' },
  { port: '8001', service: 'DeerFlow Gateway', type: 'API', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8001', reachability: 'unavailable', detail: 'Registry has this service, but localhost probe did not return a response.' },
  { port: '8002', service: 'Presenton API', type: 'API', exposure: 'LAN', endpoint: `http://${workstationHost}:8002`, reachability: 'unavailable', detail: 'Registry has this service, but LAN probe did not return a response.' },
  { port: '8007', service: 'Knowledge MCP', type: 'MCP', exposure: 'LAN', endpoint: `http://${workstationHost}:8007`, health: `http://${workstationHost}:8007/health`, reachability: 'auth', detail: 'Probe returned 401.' },
  { port: '8009', service: 'Presenton MCP', type: 'MCP', exposure: 'LAN', endpoint: `http://${workstationHost}:8009`, reachability: 'not-found', detail: 'LAN probe returned 404 on root.' },
  { port: '8010', service: 'AG2 Core', type: 'AI', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8010', health: 'http://127.0.0.1:8010/metrics', reachability: 'ok', detail: 'Registry marks this LAN-bound, but live listener scan found localhost-only; local metrics probe returned 200.' },
  { port: '8011', service: 'AG2 Gateway', type: 'API', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8011', reachability: 'not-found', detail: 'Workstation-local root probe returned 404.' },
  { port: '8030', service: 'Agentic Reports', type: 'AI', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8030', health: 'http://127.0.0.1:8030/health', reachability: 'not-found', detail: 'Registry health path returned 404.' },
  { port: '8080', service: 'SearXNG', type: 'Search', exposure: 'LAN', endpoint: `http://${workstationHost}:8080`, health: `http://${workstationHost}:8080/healthz`, reachability: 'not-probed', detail: 'Registry marks this as external.' },
  { port: '8081', service: 'llama.cpp Server', type: 'AI local', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8081/v1', health: 'http://127.0.0.1:8081/v1/models', reachability: 'unavailable', detail: 'Registry has this service, but localhost probe did not return a response.' },
  { port: '8082', service: 'OpenClaw', type: 'AI', exposure: 'LAN', endpoint: `http://${workstationHost}:8082`, reachability: 'not-probed', detail: 'Registry notes this as a process listener.' },
  { port: '8090', service: 'Codex App Server', type: 'AI', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8090', reachability: 'auth', detail: 'Workstation-local root probe returned 400.' },
  { port: '8091', service: 'LiteLLM Alert Fwd', type: 'Alert', exposure: 'LAN', endpoint: `http://${workstationHost}:8091`, reachability: 'not-found', detail: 'Registry marks this localhost-only, but live listener scan found a LAN bind; LAN root probe returned 404.' },
  { port: '8123', service: 'ClickHouse HTTP / CRG MCP', type: 'Database / MCP', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8123', reachability: 'not-found', detail: 'Registry documents a ClickHouse/CRG port conflict; CRG is localhost-only.' },
  { port: '8711', service: 'CrewAI API', type: 'AI', exposure: 'LAN', endpoint: `http://${workstationHost}:8711`, reachability: 'not-found', detail: 'LAN root probe returned 404.' },
  { port: '8720', service: 'LangGraph API', type: 'AI', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8720', reachability: 'ok', detail: 'Workstation-local root probe returned 200.' },
  { port: '8790', service: 'Ruflo Shell', type: 'Shell', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8790', reachability: 'unavailable', detail: 'Registry has this service, but localhost probe did not return a response.' },
  { port: '8900', service: 'Overwatch Agent', type: 'Monitor', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8900', health: 'http://127.0.0.1:8900/metrics', reachability: 'unavailable', detail: 'Registry has this service, but metrics probe did not return a response.' },
  { port: '8901', service: 'Overwatch Monitor', type: 'Monitor', exposure: 'Localhost', endpoint: 'http://127.0.0.1:8901', health: 'http://127.0.0.1:8901/metrics', reachability: 'unavailable', detail: 'Registry has this service, but metrics probe did not return a response.' },
  { port: '9090', service: 'Prometheus', type: 'Monitoring', exposure: 'Localhost', endpoint: 'http://127.0.0.1:9090', health: 'http://127.0.0.1:9090/-/healthy', reachability: 'ok', detail: 'Workstation-local health probe returned 200.' },
  { port: '9091', service: 'MinIO Console', type: 'Storage', exposure: 'Localhost', endpoint: 'http://127.0.0.1:9091', reachability: 'not-probed', detail: 'Registry marks this as localhost-only.' },
  { port: '9092', service: 'WordPress', type: 'Web', exposure: 'LAN', endpoint: `http://${workstationHost}:9092`, reachability: 'redirect', detail: 'LAN root probe returned 301.' },
  { port: '9100', service: 'Node Exporter', type: 'Metrics', exposure: 'Localhost', endpoint: 'http://127.0.0.1:9100', health: 'http://127.0.0.1:9100/metrics', reachability: 'ok', detail: 'Workstation-local metrics probe returned 200.' },
  { port: '9119', service: 'Hermes Dashboard', type: 'AI', exposure: 'Localhost', endpoint: 'http://127.0.0.1:9119', reachability: 'ok', detail: 'Workstation-local root probe returned 200.' },
  { port: '11434', service: 'Ollama', type: 'AI', exposure: 'LAN', endpoint: `http://${workstationHost}:11434`, health: `http://${workstationHost}:11434/api/version`, reachability: 'ok', detail: 'LAN version probe returned 200.' },
  { port: '18789', service: 'OpenClaw', type: 'AI', exposure: 'Localhost', endpoint: 'http://127.0.0.1:18789', reachability: 'ok', detail: 'Workstation-local root probe returned 200.' },
  { port: '18792', service: 'Hermes MCP', type: 'AI', exposure: 'LAN', endpoint: `http://${workstationHost}:18792/mcp`, reachability: 'ok', detail: 'MCP probe returned an HTTP response on the LAN endpoint.' },
];

const listenerFindings: ListenerFinding[] = [
  { bind: 'LAN', ports: '1455, 5000, 8084, 8087, 8095, 8902, 9095-9097', detail: 'Currently listening on 0.0.0.0 but not present in the 2026-06-12 registry excerpt.' },
  { bind: 'Wildcard', ports: '3003', detail: 'Currently listening on wildcard bind but not present in the registry excerpt.' },
  { bind: 'Localhost', ports: '5679, 8093, 8094, 8787, 9093, 18793', detail: 'Currently listening on 127.0.0.1 but not present in the registry excerpt.' },
  { bind: 'Registry drift', ports: '3001, 8010, 8091', detail: 'Registered bind scope differs from the live listener scan; endpoint rows use the verified live behavior.' },
];

export function WorkstationUrlsPage() {
  const lanCount = serviceEndpoints.filter((endpoint) => endpoint.exposure === 'LAN').length;
  const localCount = serviceEndpoints.filter((endpoint) => endpoint.exposure === 'Localhost').length;
  const reachableCount = serviceEndpoints.filter((endpoint) => ['ok', 'auth', 'redirect'].includes(endpoint.reachability)).length;

  return (
    <div className="p-8 space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Workstation URLs</h1>
          <p className="text-foreground-secondary mt-2 max-w-3xl">
            Live workstation endpoint map for {workstationHost}. Source: SSH read of
            {' '}<code>~/workspace/poort.md</code>, listener scan, and read-only HTTP probes.
          </p>
        </div>
        <div className="bg-background-secondary border border-border rounded-lg px-4 py-3 text-sm text-foreground-secondary">
          <div>Registry: {registryUpdated}</div>
          <div>Verified: {verifiedAt}</div>
        </div>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard icon={<Network className="w-5 h-5 text-accent-secondary" />} label="Workstation" value={workstationHost} />
        <MetricCard icon={<ExternalLink className="w-5 h-5 text-status-active" />} label="LAN endpoints" value={lanCount.toString()} />
        <MetricCard icon={<Lock className="w-5 h-5 text-status-paused" />} label="Localhost-only" value={localCount.toString()} />
        <MetricCard icon={<ShieldCheck className="w-5 h-5 text-status-running" />} label="Responding probes" value={reachableCount.toString()} />
      </section>

      <section className="bg-background-secondary border border-border rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <Server className="w-5 h-5 text-accent" />
          <h2 className="text-xl font-semibold text-foreground">Primary AI Endpoints</h2>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {primaryEndpoints.map((endpoint) => (
            <EndpointCard key={`${endpoint.service}-${endpoint.port}`} endpoint={endpoint} highlight={endpoint.service === 'LiteLLM Proxy'} />
          ))}
        </div>
      </section>

      <section className="bg-background-secondary border border-border rounded-lg p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-6">
          <div className="flex items-center gap-3">
            <Terminal className="w-5 h-5 text-accent" />
            <h2 className="text-xl font-semibold text-foreground">All Registered Workstation Endpoints</h2>
          </div>
          <div className="text-sm text-foreground-tertiary">
            Localhost entries require SSH or an on-host browser.
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-foreground-tertiary">
                <th className="py-3 pr-4 font-medium">Port</th>
                <th className="py-3 pr-4 font-medium">Service</th>
                <th className="py-3 pr-4 font-medium">Type</th>
                <th className="py-3 pr-4 font-medium">Scope</th>
                <th className="py-3 pr-4 font-medium">Endpoint</th>
                <th className="py-3 pr-4 font-medium">Probe</th>
                <th className="py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {serviceEndpoints.map((endpoint) => (
                <tr key={`${endpoint.port}-${endpoint.service}`} className="border-b border-border/60 align-top">
                  <td className="py-3 pr-4 font-mono text-foreground">{endpoint.port}</td>
                  <td className="py-3 pr-4 font-medium text-foreground">{endpoint.service}</td>
                  <td className="py-3 pr-4 text-foreground-secondary whitespace-nowrap">{endpoint.type}</td>
                  <td className="py-3 pr-4">
                    <ExposureBadge exposure={endpoint.exposure} />
                  </td>
                  <td className="py-3 pr-4 min-w-[260px]">
                    <EndpointLink endpoint={endpoint.endpoint} />
                    {endpoint.health && (
                      <div className="text-xs text-foreground-muted mt-1">
                        health: <EndpointLink endpoint={endpoint.health} compact />
                      </div>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <ReachabilityBadge reachability={endpoint.reachability} />
                  </td>
                  <td className="py-3 text-foreground-secondary min-w-[260px]">{endpoint.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-background-secondary border border-border rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <Activity className="w-5 h-5 text-status-paused" />
          <h2 className="text-xl font-semibold text-foreground">Live Listener Findings</h2>
        </div>
        <p className="text-sm text-foreground-secondary mb-4">
          These were visible in <code>ss -ltn</code> during verification but are not in the registry excerpt above.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {listenerFindings.map((finding) => (
            <div key={finding.bind} className="bg-background-elevated border border-border rounded-lg p-4">
              <div className="text-sm text-foreground-tertiary mb-2">{finding.bind}</div>
              <div className="font-mono text-foreground mb-3">{finding.ports}</div>
              <div className="text-sm text-foreground-secondary">{finding.detail}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

interface MetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function MetricCard({ icon, label, value }: MetricCardProps) {
  return (
    <div className="bg-background-secondary border border-border rounded-lg p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-foreground-secondary">{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold text-foreground">{value}</div>
    </div>
  );
}

interface EndpointCardProps {
  endpoint: WorkstationEndpoint;
  highlight?: boolean;
}

function EndpointCard({ endpoint, highlight = false }: EndpointCardProps) {
  return (
    <div className={`border rounded-lg p-5 ${highlight ? 'bg-accent/10 border-accent/40' : 'bg-background-elevated border-border'}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-foreground-tertiary">{endpoint.type}</div>
          <h3 className="text-lg font-semibold text-foreground mt-1">{endpoint.service}</h3>
        </div>
        <ReachabilityBadge reachability={endpoint.reachability} />
      </div>
      <div className="mt-4 space-y-2">
        <div>
          <div className="text-xs text-foreground-tertiary mb-1">URL</div>
          <EndpointLink endpoint={endpoint.endpoint} />
        </div>
        {endpoint.health && (
          <div>
            <div className="text-xs text-foreground-tertiary mb-1">Health</div>
            <EndpointLink endpoint={endpoint.health} />
          </div>
        )}
      </div>
      <p className="text-sm text-foreground-secondary mt-4">{endpoint.detail}</p>
    </div>
  );
}

interface EndpointLinkProps {
  endpoint: string;
  compact?: boolean;
}

function EndpointLink({ endpoint, compact = false }: EndpointLinkProps) {
  const isHttp = endpoint.startsWith('http://') || endpoint.startsWith('https://');
  const className = `${compact ? 'text-xs' : 'text-sm'} font-mono break-all text-accent-secondary hover:text-accent`;

  if (!isHttp) {
    return <span className={`${compact ? 'text-xs' : 'text-sm'} font-mono break-all text-foreground-secondary`}>{endpoint}</span>;
  }

  return (
    <a className={className} href={endpoint} target="_blank" rel="noreferrer">
      {endpoint}
    </a>
  );
}

interface ExposureBadgeProps {
  exposure: Exposure;
}

function ExposureBadge({ exposure }: ExposureBadgeProps) {
  const classes: Record<Exposure, string> = {
    LAN: 'bg-status-active/10 text-status-active border-status-active/20',
    Localhost: 'bg-status-paused/10 text-status-paused border-status-paused/20',
    System: 'bg-foreground-muted/10 text-foreground-tertiary border-border',
    Internal: 'bg-accent/10 text-accent-secondary border-accent/20',
  };

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${classes[exposure]}`}>
      {exposure}
    </span>
  );
}

interface ReachabilityBadgeProps {
  reachability: Reachability;
}

function ReachabilityBadge({ reachability }: ReachabilityBadgeProps) {
  const labels: Record<Reachability, string> = {
    ok: '200 OK',
    auth: 'Auth required',
    redirect: 'Redirect',
    'not-found': '404',
    unavailable: 'No response',
    tcp: 'TCP only',
    'not-probed': 'Not probed',
  };
  const classes: Record<Reachability, string> = {
    ok: 'bg-status-active/10 text-status-active border-status-active/20',
    auth: 'bg-status-running/10 text-status-running border-status-running/20',
    redirect: 'bg-accent/10 text-accent-secondary border-accent/20',
    'not-found': 'bg-status-paused/10 text-status-paused border-status-paused/20',
    unavailable: 'bg-status-error/10 text-status-error border-status-error/20',
    tcp: 'bg-foreground-muted/10 text-foreground-tertiary border-border',
    'not-probed': 'bg-background-tertiary text-foreground-tertiary border-border',
  };

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${classes[reachability]}`}>
      {labels[reachability]}
    </span>
  );
}
