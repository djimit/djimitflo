import { describe, expect, it } from 'vitest';
import { applyPiiPass, detectPii } from './pii-pass';

describe('detectPii', () => {
  it('detecteert e-mail, telefoon, IBAN, IP en geboortedatum', () => {
    expect(detectPii('mail jan@example.nl')).toContain('email');
    expect(detectPii('bel +31 6 1234 5678')).toContain('phone');
    expect(detectPii('IBAN NL91ABNA0417164300 graag')).toContain('iban');
    expect(detectPii('vanaf 192.168.1.28')).toContain('ip');
    expect(detectPii('geboren 15-03-1985')).toContain('birthdate');
  });

  it('detecteert BSN-achtig alleen als de elfproef klopt', () => {
    expect(detectPii('bsn 123456782')).toContain('bsn');
    expect(detectPii('nummer 123456789')).toEqual([]);
  });

  it('geeft lege lijst voor schone tekst', () => {
    expect(detectPii('gewone tekst zonder persoonsgegevens')).toEqual([]);
  });
});

describe('applyPiiPass', () => {
  const payload = { contact: 'jan@example.nl', note: 'bel +31 6 1234 5678 of kom langs' };

  it('BLOCK laat geen payload door bij PII', () => {
    const r = applyPiiPass(payload, 'BLOCK');
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(r.payload).toBeNull();
  });

  it('REDACT vervangt PII door labels zonder raw restanten', () => {
    const r = applyPiiPass(payload, 'REDACT');
    expect(r.ok).toBe(true);
    const out = JSON.stringify(r.payload);
    expect(out).not.toContain('jan@example.nl');
    expect(out).not.toContain('1234 5678');
    expect(out).toContain('[EMAIL]');
    expect(out).toContain('[PHONE]');
  });

  it('HASH is deterministisch per kind+waarde', () => {
    const a = applyPiiPass(payload, 'HASH');
    const b = applyPiiPass(payload, 'HASH');
    expect(a.payload).toEqual(b.payload);
    expect(JSON.stringify(a.payload)).not.toContain('jan@example.nl');
  });

  it('PASS laat de payload ongemoeid maar rapporteert hits', () => {
    const r = applyPiiPass(payload, 'PASS');
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual(payload);
    expect(r.hits).toContain('email');
  });

  it('onbekende mode wordt fail-closed als REDACT behandeld', () => {
    const r = applyPiiPass(payload, 'FOO' as never);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.payload)).toContain('[EMAIL]');
  });

  it('schone payload blijft identiek in elke mode', () => {
    const clean = { status: 'ok' };
    expect(applyPiiPass(clean, 'BLOCK').payload).toEqual(clean);
    expect(applyPiiPass(clean, 'REDACT').payload).toEqual(clean);
  });
});
