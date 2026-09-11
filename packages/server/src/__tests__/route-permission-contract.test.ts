import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROLE_PERMISSIONS } from '@djimitflo/shared';

describe('literal route permission contract', () => {
  it('rejects permission names owned by no existing role', () => {
    const known = new Set(Object.values(ROLE_PERMISSIONS).flat());
    const dir = join(__dirname, '../routes');
    const calls = readdirSync(dir).filter(name => name.endsWith('.ts')).flatMap(file => {
      const text = readFileSync(join(dir, file), 'utf8');
      return [...text.matchAll(/\brequirePermission\s*\(\s*(['"])([^'"]+)\1/g)].map(match => ({
        file, permission: match[2], line: text.slice(0, match.index).split('\n').length,
      }));
    });
    expect(calls.length).toBeGreaterThan(100);
    expect(calls.filter(call => !known.has(call.permission))).toEqual([]);
  });
});
