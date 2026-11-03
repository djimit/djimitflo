import { describe, expect, it } from 'vitest';
import { DataClassification } from '../services/data-classification';
import { isSelfHostedHost, dataClassOf, CONSUMER_DATA_CLASS } from '../services/egress-classification';

describe('isSelfHostedHost', () => {
  it('recognizes localhost and IPv6 loopback literal', () => {
    expect(isSelfHostedHost('localhost')).toBe(true);
    expect(isSelfHostedHost('Localhost')).toBe(true); // case-insensitive
    expect(isSelfHostedHost('::1')).toBe(true);
  });

  it('recognizes mDNS / local-internal / tailsync suffixes', () => {
    expect(isSelfHostedHost('printer.local')).toBe(true);
    expect(isSelfHostedHost('host.internal')).toBe(true);
    expect(isSelfHostedHost('machine.tailnet.ts.net')).toBe(true);
    expect(isSelfHostedHost('not.ts.net.example.com')).toBe(false); // does not end with .ts.net
  });

  it('recognizes RFC 1918 private ranges and the CGNAT tailnet range', () => {
    expect(isSelfHostedHost('10.0.0.1')).toBe(true);
    expect(isSelfHostedHost('172.16.0.1')).toBe(true);
    expect(isSelfHostedHost('172.31.255.255')).toBe(true);
    expect(isSelfHostedHost('192.168.1.1')).toBe(true);
    expect(isSelfHostedHost('100.70.1.1')).toBe(true); // tailscale CGNAT
    expect(isSelfHostedHost('100.127.255.255')).toBe(true);
    expect(isSelfHostedHost('127.0.0.1')).toBe(true);
  });

  it('rejects public IPs, edge-of-range and malformed hosts', () => {
    expect(isSelfHostedHost('8.8.8.8')).toBe(false);
    expect(isSelfHostedHost('172.15.0.1')).toBe(false); // just below 172.16
    expect(isSelfHostedHost('172.32.0.1')).toBe(false); // just above 172.31
    expect(isSelfHostedHost('100.63.0.1')).toBe(false); // just below CGNAT
    expect(isSelfHostedHost('100.128.0.1')).toBe(false); // just above CGNAT
    expect(isSelfHostedHost('11.0.0.1')).toBe(false);
    expect(isSelfHostedHost('api.openai.com')).toBe(false);
    expect(isSelfHostedHost('not-an-ip')).toBe(false);
    expect(isSelfHostedHost('')).toBe(false);
  });
});

describe('dataClassOf', () => {
  it('returns the documented data class for each known consumer in CONSUMER_DATA_CLASS', () => {
    for (const [consumer, expected] of Object.entries(CONSUMER_DATA_CLASS)) {
      expect(dataClassOf(consumer)).toBe(expected);
    }
  });

  it('maps specific documented consumers to their classification', () => {
    expect(dataClassOf('frontier_experts')).toBe(DataClassification.PUBLIC);
    expect(dataClassOf('content_safety')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('embeddings')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('panel_review')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('fallback')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('council')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('jev')).toBe(DataClassification.CONFIDENTIAL);
  });

  it('defaults resident:* consumers to INTERNAL', () => {
    expect(dataClassOf('resident:writer')).toBe(DataClassification.INTERNAL);
    expect(dataClassOf('resident:checker')).toBe(DataClassification.INTERNAL);
  });

  it('defaults unknown consumers to CONFIDENTIAL (fail-safe)', () => {
    expect(dataClassOf('something-new')).toBe(DataClassification.CONFIDENTIAL);
    expect(dataClassOf('')).toBe(DataClassification.CONFIDENTIAL);
  });
});