import { describe, it, expect } from 'vitest';
import { CRITICAL_PATTERNS, HIGH_PATTERNS, SELF_NARRATION_PATTERNS, JADEPUFFER_IOCS } from '../src/patterns';


describe('CRITICAL_PATTERNS', () => {
  it('detects MySQL AES_ENCRYPT', () => {
    const cmd = 'SELECT AES_ENCRYPT(content, "key") FROM config_info';
    expect(CRITICAL_PATTERNS.some(p => p.pattern.test(cmd))).toBe(true);
  });

  it('detects DROP DATABASE', () => {
    const cmd = 'DROP DATABASE production';
    expect(CRITICAL_PATTERNS.some(p => p.pattern.test(cmd))).toBe(true);
  });

  it('detects MinIO default credentials', () => {
    const cmd = 'curl -H "Authorization: Basic minioadmin:minioadmin" http://localhost:9000';
    expect(CRITICAL_PATTERNS.some(p => p.pattern.test(cmd))).toBe(true);
  });

  it('does not flag legitimate SELECT', () => {
    const cmd = 'SELECT * FROM users WHERE id = 1';
    expect(CRITICAL_PATTERNS.some(p => p.pattern.test(cmd))).toBe(false);
  });
});

describe('HIGH_PATTERNS', () => {
  it('detects INTO OUTFILE', () => {
    const cmd = "SELECT content INTO OUTFILE '/tmp/out.txt'";
    expect(HIGH_PATTERNS.some(p => p.pattern.test(cmd))).toBe(true);
  });

  it('detects crontab modification', () => {
    const cmd = 'crontab -e';
    expect(HIGH_PATTERNS.some(p => p.pattern.test(cmd))).toBe(true);
  });

  it('detects JADEPUFFER Bitcoin address', () => {
    const cmd = 'INSERT INTO ransom VALUES ("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")';
    expect(HIGH_PATTERNS.some(p => p.pattern.test(cmd))).toBe(true);
  });
});

describe('SELF_NARRATION_PATTERNS', () => {
  it('detects ROI commentary', () => {
    const code = '# High-ROI databases to drop\nDROP DATABASE test';
    expect(SELF_NARRATION_PATTERNS.some(p => p.pattern.test(code))).toBe(true);
  });

  it('detects ephemeral key pattern', () => {
    const code = 'KEY = base64.b64encode(uuid.uuid4().bytes + uuid.uuid4().bytes).decode()';
    expect(SELF_NARRATION_PATTERNS.some(p => p.pattern.test(code))).toBe(true);
  });

  it('detects JADEPUFFER email', () => {
    const code = 'contact = "e78393397@proton.me"';
    expect(SELF_NARRATION_PATTERNS.some(p => p.pattern.test(code))).toBe(true);
  });
});

describe('JADEPUFFER_IOCs', () => {
  it('has correct C2 IP and beacon interval', async () => {
    const patterns = await import('../src/patterns');
    expect(patterns.JADEPUFFER_IOCS.c2_IP).toBe('45.131.66.106');
    expect(patterns.JADEPUFFER_IOCS.beacon_interval_seconds).toBe(1800);
  });
});
