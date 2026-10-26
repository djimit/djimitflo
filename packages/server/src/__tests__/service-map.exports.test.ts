import { describe, expect, it } from 'vitest';
import { integrationState } from '../services/service-map';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

describe('integrationState', () => {
  it('returns DISABLED when a disabled reason is supplied', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'llm_model_calls', ok_at: ago(60_000), fail_at: null }, NOW, 'TYPESAFE_API_KEY not set: jev is off');
    expect(r.state).toBe('DISABLED');
    expect(r.state_evidence).toBe('TYPESAFE_API_KEY not set: jev is off');
  });

  it('returns FAILED when the probe got no HTTP answer', () => {
    const r = integrationState({ http: null, error: 'ECONNREFUSED' }, { source: null, ok_at: null, fail_at: null }, NOW);
    expect(r.state).toBe('FAILED');
    expect(r.state_evidence).toContain('probe failed');
    expect(r.state_evidence).toContain('ECONNREFUSED');
  });

  it('uses "unreachable" in evidence when probe error is null', () => {
    const r = integrationState({ http: null, error: null }, { source: null, ok_at: null, fail_at: null }, NOW);
    expect(r.state).toBe('FAILED');
    expect(r.state_evidence).toContain('unreachable');
  });

  it('returns DEGRADED for a 5xx probe regardless of business evidence', () => {
    const r = integrationState({ http: 503, error: null }, { source: 'llm_model_calls', ok_at: ago(60_000), fail_at: null }, NOW);
    expect(r.state).toBe('DEGRADED');
    expect(r.state_evidence).toContain('HTTP 503');
  });

  it('returns DEGRADED for a 500 probe (boundary)', () => {
    const r = integrationState({ http: 500, error: null }, { source: null, ok_at: null, fail_at: null }, NOW);
    expect(r.state).toBe('DEGRADED');
  });

  it('returns DEGRADED when a recent business failure is the last event, even with a 2xx probe', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'llm_model_calls', ok_at: ago(5 * H), fail_at: ago(H) }, NOW);
    expect(r.state).toBe('DEGRADED');
    expect(r.state_evidence).toContain('last business failure');
  });

  it('does not return DEGRADED when the business failure is older than 24h', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'llm_model_calls', ok_at: ago(2 * H), fail_at: ago(25 * H) }, NOW);
    expect(r.state).toBe('HEALTHY');
  });

  it('returns CONFIGURED for a 404 probe even with a recent business success', () => {
    const r = integrationState({ http: 404, error: null }, { source: 'llm_model_calls', ok_at: ago(60_000), fail_at: null }, NOW);
    expect(r.state).toBe('CONFIGURED');
    expect(r.state_evidence).toContain('HTTP 404');
  });

  it('returns CONFIGURED for a 3xx probe', () => {
    const r = integrationState({ http: 302, error: null }, { source: null, ok_at: null, fail_at: null }, NOW);
    expect(r.state).toBe('CONFIGURED');
  });

  it('returns HEALTHY when a 2xx probe has a recent success and no later failure', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'llm_model_calls', ok_at: ago(H), fail_at: null }, NOW);
    expect(r.state).toBe('HEALTHY');
    expect(r.state_evidence).toContain('last business success');
    expect(r.state_evidence).toContain(ago(H));
  });

  it('returns HEALTHY when the success is exactly at the 24h boundary', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'registry_agents', ok_at: ago(24 * H), fail_at: null }, NOW);
    expect(r.state).toBe('HEALTHY');
  });

  it('returns CONNECTED when the 2xx probe has a success older than 24h', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'llm_model_calls', ok_at: ago(25 * H), fail_at: null }, NOW);
    expect(r.state).toBe('CONNECTED');
  });

  it('returns CONNECTED when there is a 2xx probe but no business evidence source', () => {
    const r = integrationState({ http: 200, error: null }, { source: null, ok_at: null, fail_at: null }, NOW);
    expect(r.state).toBe('CONNECTED');
    expect(r.state_evidence).toContain('UNKNOWN');
  });

  it('returns CONNECTED when there is a source but no business operation in the lookback', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'event_outbox', ok_at: null, fail_at: null }, NOW);
    expect(r.state).toBe('CONNECTED');
    expect(r.state_evidence).toContain('no business operation in 7 d');
  });

  it('returns HEALTHY when a success follows a failure (both recent)', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'llm_model_calls', ok_at: ago(H), fail_at: ago(3 * H) }, NOW);
    expect(r.state).toBe('HEALTHY');
  });

  it('default disabled argument is null so no disabled reason is applied', () => {
    const r = integrationState({ http: 200, error: null }, { source: 'llm_model_calls', ok_at: ago(H), fail_at: null }, NOW);
    expect(r.state).toBe('HEALTHY');
  });
});