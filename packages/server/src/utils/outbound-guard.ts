/**
 * Operator rule (2026-09-29): the VPS never calls the workstation — the workstation only pulls (gym worker, remote maker,
 * kb-sync, publishers). One choke point: every fetch() in this process is checked against OUTBOUND_DENY_HOSTS (comma-
 * separated hostnames/IPs, e.g. the workstation's Tailscale and LAN addresses; names also match their subdomains / MagicDNS
 * names, see deniedMatch) and refused before a socket is opened.
 * Covers Node's global fetch only (not child processes); the network-level guarantee is a Tailscale ACL / host firewall.
 */
import type { Database } from 'better-sqlite3';
import { hourBucket, recordPolicyViolation } from '../services/policy-violations';

export function deniedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.OUTBOUND_DENY_HOSTS || '').split(',').map((h) => h.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
}

export function isDenied(input: unknown, denied: Set<string>): string | null {
  if (!denied.size) return null;
  let host: string;
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url?: string })?.url ?? '';
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch { return null; }
  return deniedMatch(host, denied) ? host : null;
}

/**
 * Exact host, or a subdomain of a denied domain (`gpu.tail1234.ts.net` denies `ollama.gpu.tail1234.ts.net`), or — for a bare
 * name without dots (`workstation`) — any name whose first label is it, so the MagicDNS name `workstation.<tailnet>.ts.net`
 * and LAN names like `workstation.lan` are refused too. IP entries match exactly only.
 */
function deniedMatch(host: string, denied: Set<string>): boolean {
  if (denied.has(host)) return true;
  for (const d of denied) {
    if (d.includes(':') || /^[0-9.]+$/.test(d)) continue;
    if (d.includes('.') ? host.endsWith(`.${d}`) : host.split('.')[0] === d) return true;
  }
  return false;
}

/** §16 step 8 (shadow, POLICY_VIOLATION_LOG): one policy_violations row per denied host per hour; the refusal itself is unchanged. */
export function outboundViolation(db: Database, host: string, env: NodeJS.ProcessEnv = process.env): void {
  recordPolicyViolation(db, { kind: 'outbound_denied', actor: 'server', severity: 'medium', dedupe_key: `${host}:${hourBucket()}`,
    evidence_ref: `outbound_guard:${host}`, description: `refused an outbound request to ${host} (OUTBOUND_DENY_HOSTS)` }, env);
}

export function installOutboundGuard(env: NodeJS.ProcessEnv = process.env, log: (msg: string) => void = (m) => console.warn(m),
  onDenied: (host: string) => void = () => {}): boolean {
  const denied = deniedHosts(env);
  if (!denied.size || (globalThis.fetch as { __outboundGuard?: boolean }).__outboundGuard) return false;
  const original = globalThis.fetch;
  const guarded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = isDenied(input, denied);
    if (host) {
      log(`[outbound-guard] refused a request to ${host} (OUTBOUND_DENY_HOSTS: this host never calls it)`);
      try { onDenied(host); } catch { /* recording never changes the refusal */ }
      return Promise.reject(Object.assign(new TypeError(`OUTBOUND_DENIED: ${host}`), { cause: { code: 'OUTBOUND_DENIED' } }));
    }
    return original(input, init);
  }) as typeof fetch & { __outboundGuard?: boolean };
  guarded.__outboundGuard = true;
  globalThis.fetch = guarded;
  return true;
}
