import { readFileSync } from 'fs';
import { join } from 'path';

let _version: string = '0.5.6';

export function getAppVersion(): string {
  if (_version !== '0.5.6') return _version;
  try {
    const pkgPath = join(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.version) {
      _version = pkg.version;
      return _version;
    }
  } catch {}
  try {
    const rootPkgPath = join(__dirname, '../../../package.json');
    const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'));
    if (pkg.version) {
      _version = pkg.version;
      return _version;
    }
  } catch {}
  return _version;
}