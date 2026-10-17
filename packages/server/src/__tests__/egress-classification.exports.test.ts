import { describe, expect, it } from 'vitest';
import { DataClassification } from '../services/data-classification';
import { dataClassOf, isSelfHostedHost } from '../services/egress-classification';

describe('egress-classification exports — isSelfHostedHost', () => {
  it('returns true for localhost and ::1', () => {
    expect(isSelfHostedHost('localhost')).toBe(true);
    expect(isSelfHostedHost('::1')).toBe(true);
  });

  it('returns true for loopback 127.x.x.x addresses', () => {
    expect(isSelfHostedHost('127.0.0.1')).toBe(true);
    expect(isSelfHostedHost('127.255.255.255')).toBe(true);
  });

  it('returns true for RFC 1918 private ranges', () => {
    expect(isSelfHostedHost('10.0.0.1')).toBe(true);
    expect(isSelfHostedHost('172.16.0.1')).toBe(true);
    expect(isSelfHostedHost('172.31.255.255')).toBe(true);
    expect(isSelfHostedHost('192.168.1.1')).toBe(true);
  });

  it('returns true for the CGNAT/Tailscale 100.64.0.0/10 range', () => {
    expect(isSelfHostedHost('100.64.0.1')).toBe(true);
    expect(isSelfHostedHost('100.127.255.255')).toBe(true);
  });

  it('returns false for public IP addresses outside private ranges', () => {
    expect(isSelfHostedHost('8.8.8.8')).toBe(false);
    expect(isSelfHostedHost('172.32.0.1')).toBe(false);
    expect(isSelfHostedHost('172.15.0.1')).toBe(false);
    expect(isSelfHostedHost('100.63.0.1')).toBe(false);
    expect(isSelfHostedHost('100.128.0.1')).toBe(false);
  });

  it('returns true for .local, .internal, and .ts.net suffixes', () => {
    expect(isSelfHostedHost('myhost.local')).toBe(true);
    expect(isSelfHostedHost('gateway.internal')).toBe(true);
    expect(isSelfHostedHost('node.tail.ts.net')).toBe(true);
  });

  it('returns false for public hostnames', () => {
    expect(isSelfHostedHost('api.openai.com')).toBe(false);
    expect(isSelfHostedHost('example.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isSelfHostedHost('LOCALHOST')).toBe(true);
    expect(isSelfHostedHost('10.0.0.1')).toBe(true);
    expect(isSelfHostedHost('HOST.INTERNAL')).toBe(true);
  });

  it('returns false for malformed IPv4-like strings', () => {
    expect(isSelfHostedHost('999.0.0.1')).toBe(false);
    expect(isSelfHostedHost('1.2.3')).toBe(false);
  });
});

describe('egress-classification exports — dataClassOf', () => {
  it('returns the documented data class for known consumers', () => {
    expect(dataClassOf('frontier_experts')).toBe(DataClassification.PUBLIC);
    expect(dataClassOf('content_safety')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('embeddings')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('panel_review')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('fallback')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('council')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('jev')).toBe(DataClassification.CONFIDENTIAL);
  });

  it('returns INTERNAL for resident: consumers', () => {
    expect(dataClassOf('resident:foo')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('resident:loop-daemon')).toBe(DataClassification.INTERNAL);
  });

  it('defaults to CONFIDENTIAL for unknown consumers', () => {
    expect(dataClassOf('unknown_consumer')).toBe(DataClassification.CONFIDENTIAL);
    expect(dataClassOf('')).toBe(DataClassification.CONFIDENTIAL);
  });
});