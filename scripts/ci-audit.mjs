import { spawnSync } from 'node:child_process';

const allowedAdvisories = new Set([
  // Dashboard is a client-rendered SPA and does not use React Router RSC actions.
  'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
  // Transitive deps — no upstream fix available yet.
  'https://github.com/advisories/GHSA-7p8r-x3mc-p8w7', // fast-uri
  'https://github.com/advisories/GHSA-mwp4-54f8-5fhr', // ip-address
  'https://github.com/advisories/GHSA-2v37-7h3g-55p8', // nanoid
]);
const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
const report = JSON.parse(audit.stdout);
const vulnerabilities = report.vulnerabilities ?? {};
const severity = { low: 1, moderate: 2, high: 3, critical: 4 };
const memo = new Map();

function blocks(name, visiting = new Set()) {
  if (memo.has(name)) return memo.get(name);
  if (visiting.has(name)) return false;
  visiting.add(name);
  const blocked = (vulnerabilities[name]?.via ?? []).some(via =>
    typeof via === 'string'
      ? blocks(via, visiting)
      : !allowedAdvisories.has(via.url) && severity[via.severity] >= severity.high,
  );
  memo.set(name, blocked);
  return blocked;
}

const failures = Object.keys(vulnerabilities).filter(name => blocks(name));
if (failures.length) {
  console.error(`High/critical production advisories: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('No unaccepted high/critical production advisories.');
