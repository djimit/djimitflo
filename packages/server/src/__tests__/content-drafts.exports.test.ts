import { describe, expect, it } from 'vitest';
import { publicUrl, parseContentSignal, parseDraft } from '../services/content-drafts';

describe('content-drafts exports', () => {
  describe('publicUrl', () => {
    it('accepts a plain https URL', () => {
      expect(publicUrl('https://example.com/path')).toBe('https://example.com/path');
    });

    it('accepts an http URL', () => {
      expect(publicUrl('http://example.com/')).toBe('http://example.com/');
    });

    it('strips trailing punctuation', () => {
      expect(publicUrl('https://example.com/path,')).toBe('https://example.com/path');
    });

    it('returns null for a non-http(s) scheme', () => {
      expect(publicUrl('ftp://example.com/')).toBeNull();
    });

    it('returns null for a malformed URL', () => {
      expect(publicUrl('not a url')).toBeNull();
    });

    it('returns null for a URL with credentials', () => {
      expect(publicUrl('https://user:pass@example.com/')).toBeNull();
    });

    it('returns null for localhost', () => {
      expect(publicUrl('https://localhost/')).toBeNull();
    });

    it('returns null for a .local host', () => {
      expect(publicUrl('https://host.local/')).toBeNull();
    });

    it('returns null for a single-label host', () => {
      expect(publicUrl('https://intranet/')).toBeNull();
    });

    it('returns null for a private IPv4 range', () => {
      expect(publicUrl('https://192.168.1.1/')).toBeNull();
      expect(publicUrl('https://10.0.0.1/')).toBeNull();
      expect(publicUrl('https://127.0.0.1/')).toBeNull();
    });

    it('returns null for a link-local IPv4', () => {
      expect(publicUrl('https://169.254.1.1/')).toBeNull();
    });

    it('returns null for a CGNAT range', () => {
      expect(publicUrl('https://100.64.0.1/')).toBeNull();
    });

    it('returns null for the IPv6 unspecified address', () => {
      expect(publicUrl('https://[::]/')).toBeNull();
    });

    it('returns null for the IPv6 loopback', () => {
      expect(publicUrl('https://[::1]/')).toBeNull();
    });

    it('accepts a public IPv6 host', () => {
      expect(publicUrl('https://[2606:4700::1]/')).toBe('https://[2606:4700::1]/');
    });
  });

  describe('parseContentSignal', () => {
    const row = (payload: unknown) => ({ id: 'ev-1', dedupe_key: 'dk-1', payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });

    it('returns null when action_type is not blog', () => {
      expect(parseContentSignal(row({ evidence_json: { action_type: 'alert' }, source_trust: 'internal' }))).toBeNull();
    });

    it('returns null when source_trust is not internal', () => {
      expect(parseContentSignal(row({ source_trust: 'external', evidence_json: { action_type: 'blog' } }))).toBeNull();
    });

    it('returns null when evidence_json source_trust is explicitly non-internal', () => {
      expect(parseContentSignal(row({ source_trust: 'internal', evidence_json: { action_type: 'blog', source_trust: 'external' } }))).toBeNull();
    });

    it('parses a valid internal blog signal', () => {
      const sig = parseContentSignal(row({
        source_trust: 'internal',
        title: 'T',
        summary: 'S',
        domain: 'd',
        evidence_json: { action_type: 'blog', original_text: 'See https://example.com/a', source_excerpt: 'x' },
      }));
      expect(sig).not.toBeNull();
      expect(sig?.event_id).toBe('ev-1');
      expect(sig?.dedupe_key).toBe('dk-1');
      expect(sig?.source_trust).toBe('internal');
      expect(sig?.source_urls).toContain('https://example.com/a');
    });

    it('falls back to row.dedupe_key then row.id when payload has none', () => {
      const sig = parseContentSignal({ id: 'ev-2', dedupe_key: 'dk-row', payload: JSON.stringify({ source_trust: 'internal', evidence_json: { action_type: 'blog' } }) });
      expect(sig?.dedupe_key).toBe('dk-row');
      const sig2 = parseContentSignal({ id: 'ev-3', dedupe_key: null, payload: JSON.stringify({ source_trust: 'internal', evidence_json: { action_type: 'blog' } }) });
      expect(sig2?.dedupe_key).toBe('ev-3');
    });

    it('handles a nested string payload', () => {
      const outer = JSON.stringify({ source_trust: 'internal', payload: JSON.stringify({ title: 'Nested', evidence_json: { action_type: 'blog' } }) });
      const sig = parseContentSignal({ id: 'ev-4', dedupe_key: null, payload: outer });
      expect(sig?.title).toBe('Nested');
    });

    it('extracts source refs and primary urls', () => {
      const sig = parseContentSignal(row({
        source_trust: 'internal',
        evidence_json: { action_type: 'blog', source_refs: ['https://example.com/r'], primary_urls: [{ url: 'https://example.com/p' }] },
      }));
      expect(sig?.source_urls).toEqual(expect.arrayContaining(['https://example.com/r', 'https://example.com/p']));
    });

    it('dedupes and caps source urls at 20', () => {
      const refs = Array.from({ length: 25 }, (_, i) => `https://example.com/${i}`);
      const sig = parseContentSignal(row({ source_trust: 'internal', evidence_json: { action_type: 'blog', source_refs: refs } }));
      expect(sig?.source_urls.length).toBeLessThanOrEqual(20);
      expect(new Set(sig?.source_urls).size).toBe(sig?.source_urls.length);
    });

    it('returns null for unparseable payload', () => {
      expect(parseContentSignal({ id: 'ev-5', dedupe_key: null, payload: 'not json' })).toBeNull();
    });
  });

  describe('parseDraft', () => {
    it('parses a valid draft JSON object', () => {
      const text = '{"title":"  T  ","excerpt":"  E  ","tags":["a","b"],"body":"# Body"}';
      const d = parseDraft(text);
      expect(d).toEqual({ title: 'T', excerpt: 'E', tags: ['a', 'b'], body: '# Body' });
    });

    it('parses a draft wrapped in a json code fence', () => {
      const text = '```json\n{"title":"T","excerpt":"E","tags":["a"],"body":"b"}\n```';
      const d = parseDraft(text);
      expect(d?.title).toBe('T');
    });

    it('parses a draft wrapped in a plain code fence', () => {
      const text = '```\n{"title":"T","excerpt":"E","tags":[],"body":"b"}\n```';
      expect(parseDraft(text)?.title).toBe('T');
    });

    it('filters non-string tags', () => {
      const d = parseDraft('{"title":"T","excerpt":"E","tags":["a",1,"b"],"body":"b"}');
      expect(d?.tags).toEqual(['a', 'b']);
    });

    it('returns null when title is missing', () => {
      expect(parseDraft('{"excerpt":"E","tags":[],"body":"b"}')).toBeNull();
    });

    it('returns null when excerpt is missing', () => {
      expect(parseDraft('{"title":"T","tags":[],"body":"b"}')).toBeNull();
    });

    it('returns null when body is missing', () => {
      expect(parseDraft('{"title":"T","excerpt":"E","tags":[]}')).toBeNull();
    });

    it('returns null when tags is not an array', () => {
      expect(parseDraft('{"title":"T","excerpt":"E","tags":"a","body":"b"}')).toBeNull();
    });

    it('returns null for non-object JSON', () => {
      expect(parseDraft('"a string"')).toBeNull();
      expect(parseDraft('[]')).toBeNull();
    });

    it('returns null for unparseable text', () => {
      expect(parseDraft('not json at all')).toBeNull();
    });
  });
});