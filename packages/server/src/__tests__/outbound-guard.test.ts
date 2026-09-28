import { afterEach, expect, it, vi } from 'vitest';
import { installOutboundGuard, isDenied, deniedHosts } from '../utils/outbound-guard';

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

it('refuses denied hosts before any request is made and lets others through', async () => {
  const inner = vi.fn(async () => new Response('ok'));
  globalThis.fetch = inner as never;
  const logs: string[] = [];
  expect(installOutboundGuard({ OUTBOUND_DENY_HOSTS: '100.81.133.48, workstation.tail , [fd7a:115c:a1e0::9d37:8530]' }, (m) => logs.push(m))).toBe(true);
  await expect(fetch('http://100.81.133.48:8095/health')).rejects.toThrow('OUTBOUND_DENIED: 100.81.133.48');
  await expect(fetch(new URL('http://WORKSTATION.tail/x'))).rejects.toThrow('OUTBOUND_DENIED');
  await expect(fetch('http://[fd7a:115c:a1e0::9d37:8530]:6333/')).rejects.toThrow('OUTBOUND_DENIED');
  await expect(fetch(new Request('http://100.81.133.48:6333/collections'))).rejects.toThrow('OUTBOUND_DENIED');
  expect(await (await fetch('http://100.77.58.72:6333/')).text()).toBe('ok');
  expect(inner).toHaveBeenCalledTimes(1);
  expect(logs).toHaveLength(4);
  expect(installOutboundGuard({ OUTBOUND_DENY_HOSTS: '100.81.133.48' })).toBe(false); // idempotent
});

it('is off without a deny list', () => {
  expect(installOutboundGuard({})).toBe(false);
  expect(isDenied('http://x/', deniedHosts({}))).toBeNull();
});
