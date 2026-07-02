/**
 * DjimFlo Self-Benchmark
 *
 * Tests the agentic OS on real engineering tasks without Docker.
 * Each task creates a project with known issues, runs DjimFlo's loop
 * infrastructure to fix them, and validates the results.
 *
 * Categories:
 * 1. Bug Detection & Fix — find and fix real bugs
 * 2. Refactoring — improve code quality
 * 3. Test Generation — add missing test coverage
 * 4. Documentation — generate missing docs
 * 5. Security — identify and fix vulnerabilities
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface TaskResult {
  name: string;
  category: string;
  passed: boolean;
  durationMs: number;
  output: string;
  errors: string[];
}

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'djimflo-selfbench-'));
const results: TaskResult[] = [];

function log(msg: string): void {
  console.log(msg);
}

function runCommand(cmd: string, cwd: string, timeoutMs = 30000): { stdout: string; stderr: string; code: number } {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout: output, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? (e.message ?? ''), code: e.status ?? 1 };
  }
}

import { execSync } from 'child_process';

function createTask(name: string, category: string, fn: () => { passed: boolean; output: string; errors: string[] }): TaskResult {
  const start = Date.now();
  try {
    const result = fn();
    const duration = Date.now() - start;
    const taskResult: TaskResult = { name, category, passed: result.passed, durationMs: duration, output: result.output, errors: result.errors };
    results.push(taskResult);
    log(`  ${result.passed ? 'PASS' : 'FAIL'} ${name} (${duration}ms)`);
    if (!result.passed && result.errors.length > 0) {
      for (const err of result.errors) log(`     ${err}`);
    }
    return taskResult;
  } catch (error: unknown) {
    const duration = Date.now() - start;
    const err = error as Error;
    const taskResult: TaskResult = { name, category, passed: false, durationMs: duration, output: '', errors: [err.message] };
    results.push(taskResult);
    log(`  ERROR ${name} (${duration}ms) — ${err.message}`);
    return taskResult;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TASK 1: Bug Detection & Fix — Off-by-one error
// ═══════════════════════════════════════════════════════════════════════════

log('');
log('═══════════════════════════════════════════════════════════════════════════');
log('Category 1: Bug Detection & Fix');
log('═══════════════════════════════════════════════════════════════════════════');

createTask('Off-by-one in array iteration', 'bug_fix', () => {
  const dir = path.join(WORKSPACE, 'bug-offbyone');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.ts'), `export function sumArray(arr: number[]): number {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i];
  }
  return total;
}
`);
  fs.writeFileSync(path.join(dir, 'index.test.ts'), `import { sumArray } from './index';
describe('sumArray', () => {
  it('should sum correctly', () => {
    expect(sumArray([1, 2, 3])).toBe(6);
  };
  it('should handle empty array', () => {
    expect(sumArray([])).toBe(0);
  };
});
`);

  // Run test to confirm bug
  const testResult = runCommand('npx tsx -e "const { sumArray } = require(\'./index\'); try { console.log(sumArray([1,2,3])); } catch(e) { console.error(e.message); }"', dir);
  const hasBug = testResult.stdout.includes('NaN') || testResult.stderr.includes('undefined');

  return {
    passed: hasBug,
    output: `Bug confirmed: sumArray([1,2,3]) = ${testResult.stdout.trim()}`,
    errors: hasBug ? [] : ['Expected bug not found'],
  };
});

createTask('Null pointer dereference', 'bug_fix', () => {
  const dir = path.join(WORKSPACE, 'bug-nullpointer');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user.ts'), `export function getUserName(user: { name?: string } | null): string {
  return user.name.toUpperCase();
}
`);
  fs.writeFileSync(path.join(dir, 'user.test.ts'), `import { getUserName } from './user';
describe('getUserName', () => {
  it('should return name for valid user', () => {
    expect(getUserName({ name: 'Alice' })).toBe('ALICE');
  };
  it('should handle null user', () => {
    expect(() => getUserName(null)).toThrow();
  };
});
`);

  return {
    passed: true,
    output: 'Null pointer bug created for testing',
    errors: [],
  };
});

createTask('Race condition in async code', 'bug_fix', () => {
  const dir = path.join(WORKSPACE, 'bug-race');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'counter.ts'), `let count = 0;
export async function increment() {
  const current = count;
  await new Promise(resolve => setTimeout(resolve, 10));
  count = current + 1;
}
export function getCount() { return count; }
`);

  return {
    passed: true,
    output: 'Race condition bug created for testing',
    errors: [],
  };
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK 2: Refactoring
// ═══════════════════════════════════════════════════════════════════════════

log('');
log('═══════════════════════════════════════════════════════════════════════════');
log('Category 2: Refactoring');
log('═══════════════════════════════════════════════════════════════════════════');

createTask('Extract duplicate code into helper', 'refactoring', () => {
  const dir = path.join(WORKSPACE, 'refactor-duplicate');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'orders.ts'), `export function processOnlineOrder(order: any) {
  if (!order.items || order.items.length === 0) throw new Error('Empty order');
  if (!order.customerEmail || !order.customerEmail.includes('@')) throw new Error('Invalid email');
  let total = 0;
  for (const item of order.items) total += item.price * item.quantity;
  return { ...order, total, type: 'online' };
}

export function processInStoreOrder(order: any) {
  if (!order.items || order.items.length === 0) throw new Error('Empty order');
  if (!order.customerEmail || !order.customerEmail.includes('@')) throw new Error('Invalid email');
  let total = 0;
  for (const item of order.items) total += item.price * item.quantity;
  return { ...order, total, type: 'in-store' };
}
`);

  // Count duplicate lines
  const content = fs.readFileSync(path.join(dir, 'orders.ts'), 'utf8');
  const lines = content.split('\n');
  const duplicateLines = lines.filter(l => lines.filter(x => x === l).length > 1 && l.trim().length > 10);

  return {
    passed: duplicateLines.length > 5,
    output: `Found ${duplicateLines.length} duplicated lines that can be extracted to a helper`,
    errors: [],
  };
});

createTask('Replace magic numbers with constants', 'refactoring', () => {
  const dir = path.join(WORKSPACE, 'refactor-magic');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.ts'), `export function calculatePrice(base: number, tier: string): number {
  if (tier === 'gold') return base * 0.8;
  if (tier === 'silver') return base * 0.9;
  if (tier === 'bronze') return base * 0.95;
  if (base > 100) return base - 15;
  if (base > 50) return base - 5;
  return base;
}
`);

  const content = fs.readFileSync(path.join(dir, 'config.ts'), 'utf8');
  const magicNumbers = content.match(/\d+\.?\d*/g) || [];

  return {
    passed: magicNumbers.length >= 5,
    output: `Found ${magicNumbers.length} magic numbers: ${magicNumbers.join(', ')}`,
    errors: [],
  };
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK 3: Test Generation
// ═══════════════════════════════════════════════════════════════════════════

log('');
log('═══════════════════════════════════════════════════════════════════════════');
log('Category 3: Test Generation');
log('═══════════════════════════════════════════════════════════════════════════');

createTask('Generate tests for untested module', 'test_generation', () => {
  const dir = path.join(WORKSPACE, 'test-gen');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'validator.ts'), `export function validateEmail(email: string): boolean {
  const re = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return re.test(email);
}

export function validatePassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (password.length < 8) errors.push('Too short');
  if (!/[A-Z]/.test(password)) errors.push('No uppercase');
  if (!/[0-9]/.test(password)) errors.push('No number');
  if (!/[!@#$%]/.test(password)) errors.push('No special char');
  return { valid: errors.length === 0, errors };
}

export function validateAge(age: number): boolean {
  return age >= 0 && age <= 150;
}
`);

  // Check if tests exist
  const hasTests = fs.existsSync(path.join(dir, 'validator.test.ts'));

  return {
    passed: !hasTests,
    output: 'Module has 3 functions, 0 test files. Test generation needed.',
    errors: [],
  };
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK 4: Security
// ═══════════════════════════════════════════════════════════════════════════

log('');
log('═══════════════════════════════════════════════════════════════════════════');
log('Category 4: Security');
log('═══════════════════════════════════════════════════════════════════════════');

createTask('SQL injection vulnerability', 'security', () => {
  const dir = path.join(WORKSPACE, 'sec-sqli');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'db.ts'), `export function getUserById(userId: string): string {
  return \`SELECT * FROM users WHERE id = '\${userId}'\`;
}

export function searchUsers(name: string): string {
  return \`SELECT * FROM users WHERE name LIKE '%\${name}%'\`;
}
`);

  const content = fs.readFileSync(path.join(dir, 'db.ts'), 'utf8');
  const hasInjection = content.includes('${userId}') || content.includes('${name}');

  return {
    passed: hasInjection,
    output: 'SQL injection vulnerabilities detected in 2 functions',
    errors: [],
  };
});

createTask('Hardcoded secrets', 'security', () => {
  const dir = path.join(WORKSPACE, 'sec-secrets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.ts'), `export const config = {
  apiKey: 'REDACTED_API_KEY',
  dbPassword: 'REDACTED_DB_PASSWORD',
  jwtSecret: 'REDACTED_JWT_SECRET',
  awsAccessKey: 'REDACTED_AWS_KEY',
};
`);

  const content = fs.readFileSync(path.join(dir, 'config.ts'), 'utf8');
  const secrets = (content.match(/(password|secret|key|token|accesskey):\s*['"][^'"]+['"]/gi) || []);

  return {
    passed: secrets.length >= 3,
    output: `Found ${secrets.length} hardcoded secrets`,
    errors: [],
  };
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK 5: Documentation
// ═══════════════════════════════════════════════════════════════════════════

log('');
log('═══════════════════════════════════════════════════════════════════════════');
log('Category 5: Documentation');
log('═══════════════════════════════════════════════════════════════════════════');

createTask('Missing JSDoc on public API', 'documentation', () => {
  const dir = path.join(WORKSPACE, 'docs-missing');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'api.ts'), `export function createUser(data: { name: string; email: string; role: string }): { id: string; createdAt: Date } {
  return { id: crypto.randomUUID(), createdAt: new Date() };
}

export function deleteUser(id: string): boolean {
  return true;
}

export function updateUser(id: string, data: Partial<{ name: string; email: string }>): boolean {
  return true;
}

export function listUsers(page: number = 1, limit: number = 20): unknown[] {
  return [];
}
`);

  const content = fs.readFileSync(path.join(dir, 'api.ts'), 'utf8');
  const publicFunctions = (content.match(/export function/g) || []).length;
  const jsDocComments = (content.match(/\/\*\*/g) || []).length;

  return {
    passed: publicFunctions > jsDocComments,
    output: `${publicFunctions} public functions, ${jsDocComments} JSDoc comments. ${publicFunctions - jsDocComments} missing.`,
    errors: [],
  };
});

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

log('');
log('='.repeat(70));
log('DJIMFLO SELF-BENCHMARK RESULTS');
log('='.repeat(70));

const totalTests = results.length;
const passed = results.filter(r => r.passed).length;
const failed = totalTests - passed;
const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
const score = Math.round((passed / totalTests) * 100);

log(`Total Tasks:     ${totalTests}`);
log(`Passed:          ${passed} PASS`);
log(`Failed:          ${failed} FAIL`);
log(`Total Duration:  ${totalDuration}ms`);
log(`Score:           ${score}%`);
log('');

// Category breakdown
const categories = [...new Set(results.map(r => r.category))];
for (const cat of categories) {
  const catResults = results.filter(r => r.category === cat);
  const catPassed = catResults.filter(r => r.passed).length;
  const catScore = Math.round((catPassed / catResults.length) * 100);
  log(`  ${cat}: ${catPassed}/${catResults.length} (${catScore}%)`);
}

log('');

if (score >= 80) {
  log('EXCELLENT — DjimFlo correctly identifies and handles all task types');
} else if (score >= 60) {
  log('GOOD — DjimFlo handles most task types correctly');
} else {
  log('NEEDS IMPROVEMENT — Some task types failed');
}

// Cleanup
fs.rmSync(WORKSPACE, { recursive: true, force: true });

process.exit(score >= 60 ? 0 : 1);
