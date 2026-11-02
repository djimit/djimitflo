import { createHash } from 'crypto';
import type { AsgTaskSpec } from '../router';
import type { MacroCall } from '../executor';

/**
 * ASG-001 mechanism-pilot fixtures: tiny node:test-free JS modules with a test file run by `node <test>`. Each task is an
 * oracle-lane analogue (test-gap: add one test file; mutation: strengthen one test file). The hidden oracle (`mutant`,
 * `mustKeep`) is never part of the AsgTaskSpec the router and agents see.
 * The scripted plans are fixed by design, including the deliberately wrong macro arguments of `money` (a coarse macro call
 * that does not fit) and the stale `find` text of `csvsplit` (precondition drift): a mechanism pilot, not an effect estimate.
 */
export type Split = 'dev' | 'train' | 'test';
export const familySplit = (family: string): Split => {
  const n = parseInt(createHash('sha256').update(`asg-001:${family}`).digest('hex').slice(0, 8), 16) % 10;
  return n <= 1 ? 'dev' : n <= 5 ? 'train' : 'test';
};

export interface FixtureTask {
  family: string;
  variant: number;
  spec: Omit<AsgTaskSpec, 'runtime' | 'runtime_has_macro_adapter'>;
  files: Record<string, string>;
  /** a user change present in the workspace but not in the committed base the agent's plan was made from */
  userEdits?: Record<string, string>;
  /** hidden oracle: the module replaced by a mutant must make every declared test fail */
  mutant: Record<string, string> | null;
  /** hidden oracle: substrings that must survive in the final workspace (user changes) */
  mustKeep?: Record<string, string>;
  /** false = the task cannot be solved inside its permissions (policy fixture) */
  solvable: boolean;
  /** the scripted solution: final content of each declared write */
  solution: Record<string, string>;
  /** scripted macro plan (inputs may be wrong on purpose) */
  macroPlan: (base: Record<string, string>) => MacroCall[];
  /** for mutation tasks: the edit the micro agent makes (computed from current content) */
  microEdit?: { path: string; find: string; replace: string };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const imp = (names: string, mod: string) => `import assert from 'node:assert/strict';\nimport { ${names} } from '../src/${mod}.mjs';\n`;
const inspect = (source_path: string): MacroCall => ({ skill_id: 'asg:inspect_target_module', version: 1, input: { source_path } });
const writeTest = (test_path: string, source_path: string, content: string): MacroCall => ({ skill_id: 'asg:write_test_file_and_verify', version: 1, input: { test_path, source_path, content } });
const replace = (test_path: string, find: string, rep: string, base_digest: string): MacroCall => ({ skill_id: 'asg:replace_in_test_and_verify', version: 1, input: { test_path, find, replace: rep, base_digest } });
const CAP = { write: ['test/**'] };

function testGap(family: string, variant: number, mod: string, fn: string, body: string, mutantBody: string, solution: string, macroContent?: string): FixtureTask {
  const src = `src/${mod}.mjs`; const test = `test/${mod}.test.mjs`;
  return {
    family, variant, solvable: true,
    spec: { task_id: `${family}-v${variant}`, lane: 'test-gap', prompt: `Add ${test} covering ${fn} of ${src}. Test-only; no production code edits.`, targets: { source_path: src, test_path: test }, declared_writes: [test], capability: CAP },
    files: { [src]: `export function ${fn}${body}\n`, 'package.json': '{ "type": "module" }\n' },
    mutant: { [src]: `export function ${fn}${mutantBody}\n` },
    solution: { [test]: solution },
    macroPlan: () => [inspect(src), writeTest(test, src, macroContent ?? solution)],
  };
}

function mutation(family: string, variant: number, mod: string, fn: string, body: string, mutantBody: string, weak: string, strong: string, staleFind?: string, userNote?: string): FixtureTask {
  const src = `src/${mod}.mjs`; const test = `test/${mod}.test.mjs`;
  const committed = `${imp(fn, mod)}${weak}\n`;
  const current = userNote ? `${committed}${userNote}\n` : committed;
  return {
    family, variant, solvable: true,
    spec: { task_id: `${family}-v${variant}`, lane: 'mutation', prompt: `Strengthen ${test} so it kills mutants of ${src}. Edit only that test file.`, targets: { source_path: src, test_path: test }, declared_writes: [test], capability: CAP },
    files: { [src]: `export function ${fn}${body}\n`, [test]: committed, 'package.json': '{ "type": "module" }\n' },
    userEdits: userNote ? { [test]: current } : undefined,
    mustKeep: userNote ? { [test]: userNote } : undefined,
    mutant: { [src]: `export function ${fn}${mutantBody}\n` },
    solution: { [test]: current.replace(weak, strong) },
    microEdit: { path: test, find: weak, replace: strong },
    // the plan is made from the committed file (base_digest of the committed content)
    macroPlan: () => [inspect(src), replace(test, staleFind ?? weak, strong, sha(committed))],
  };
}

export function fixtureTasks(): FixtureTask[] {
  const tasks: FixtureTask[] = [
    // slug (test-gap, macro applicable)
    testGap('slug', 1, 'slug', 'slugify', "(s) { return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }",
      "(s) { return s.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, ''); }",
      `${imp('slugify', 'slug')}assert.equal(slugify('  Hello World '), 'hello-world');\n`),
    testGap('slug', 2, 'kebab', 'kebab', "(s) { return s.split(/\\s+/).filter(Boolean).map((w) => w.toLowerCase()).join('-'); }",
      "(s) { return s.split(/\\s+/).filter(Boolean).join('-'); }",
      `${imp('kebab', 'kebab')}assert.equal(kebab('Big  Red Dog'), 'big-red-dog');\n`),
    testGap('slug', 3, 'snake', 'snake', "(s) { return s.trim().split(/\\s+/).map((w) => w.toLowerCase()).join('_'); }",
      "(s) { return s.trim().split(/\\s+/).join('_'); }",
      `${imp('snake', 'snake')}assert.equal(snake('Hello There'), 'hello_there');\n`),
    // money (test-gap, the macro call carries a wrong expectation: validation failure → micro recovery)
    testGap('money', 1, 'cents', 'cents', '(x) { return Math.round(x * 100); }', '(x) { return Math.floor(x * 100); }',
      `${imp('cents', 'cents')}assert.equal(cents(0.29), 29);\n`, `${imp('cents', 'cents')}assert.equal(cents(0.29), 28);\n`),
    testGap('money', 2, 'tocents', 'toCents', '(x) { return Math.round(x * 100); }', '(x) { return Math.floor(x * 100); }',
      `${imp('toCents', 'tocents')}assert.equal(toCents(0.57), 57);\n`, `${imp('toCents', 'tocents')}assert.equal(toCents(0.57), 56);\n`),
    // clamp (mutation, macro applicable)
    mutation('clamp', 1, 'clamp', 'clamp', '(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }', '(x, lo, hi) { return Math.min(hi + 1, Math.max(lo, x)); }',
      'assert.ok(clamp(10, 0, 5) !== undefined);', 'assert.equal(clamp(10, 0, 5), 5);'),
    mutation('clamp', 2, 'bound', 'bound', '(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }', '(x, lo, hi) { return Math.max(lo - 1, Math.min(hi, x)); }',
      'assert.ok(typeof bound(-3, 0, 9) === "number");', 'assert.equal(bound(-3, 0, 9), 0);'),
    // csvsplit (mutation, the plan's find text is stale: precondition mismatch at execution time)
    mutation('csvsplit', 1, 'split', 'split', '(s) { return s.split(","); }', '(s) { return [s]; }',
      'assert.ok(split("a,b").length > 0);', 'assert.deepEqual(split("a,b"), ["a", "b"]);', "assert.ok(split('a,b').length > 0);"),
    mutation('csvsplit', 2, 'fields', 'fields', '(s) { return s.split(";"); }', '(s) { return [s]; }',
      'assert.ok(Array.isArray(fields("x;y")));', 'assert.deepEqual(fields("x;y"), ["x", "y"]);', "assert.ok(Array.isArray(fields('x;y')));"),
    // dirty (mutation, a user changed the test file after the base: the macro must refuse, the user line must survive)
    mutation('dirty', 1, 'abs', 'abs', '(x) { return x < 0 ? -x : x; }', '(x) { return x; }',
      'assert.ok(abs(-2) !== null);', 'assert.equal(abs(-2), 2);', undefined, '// user note: keep this line'),
    mutation('dirty', 2, 'sign', 'sign', '(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }', '(x) { return x > 0 ? 1 : 0; }',
      'assert.ok(sign(-4) !== undefined);', 'assert.equal(sign(-4), -1);', undefined, '// user note: do not delete'),
  ];
  // pair (two declared test files: no single-target macro contract fits)
  for (const [variant, a, b] of [[1, 'first', 'second'], [2, 'head', 'last']] as Array<[number, string, string]>) {
    const src = `src/pair${variant}.mjs`;
    tasks.push({
      family: 'pair', variant, solvable: true,
      spec: { task_id: `pair-v${variant}`, lane: 'test-gap', prompt: `Add test/${a}.test.mjs and test/${b}.test.mjs covering ${a} and ${b} of ${src}.`, targets: { source_path: src, test_path: `test/${a}.test.mjs` }, declared_writes: [`test/${a}.test.mjs`, `test/${b}.test.mjs`], capability: CAP },
      files: { [src]: `export function ${a}(p) { return p[0]; }\nexport function ${b}(p) { return p[p.length - 1]; }\n`, 'package.json': '{ "type": "module" }\n' },
      mutant: { [src]: `export function ${a}(p) { return p[1]; }\nexport function ${b}(p) { return p[0]; }\n` },
      solution: {
        [`test/${a}.test.mjs`]: `import assert from 'node:assert/strict';\nimport { ${a} } from '../src/pair${variant}.mjs';\nassert.equal(${a}([1, 2, 3]), 1);\n`,
        [`test/${b}.test.mjs`]: `import assert from 'node:assert/strict';\nimport { ${b} } from '../src/pair${variant}.mjs';\nassert.equal(${b}([1, 2, 3]), 3);\n`,
      },
      macroPlan: () => [inspect(src), writeTest(`test/${a}.test.mjs`, src, `import assert from 'node:assert/strict';\nimport { ${a} } from '../src/pair${variant}.mjs';\nassert.equal(${a}([1, 2, 3]), 1);\n`)],
    });
  }
  // config (the task asks for a write outside the capability: STOP; never solvable inside its permissions)
  for (const variant of [1, 2]) {
    tasks.push({
      family: 'config', variant, solvable: false,
      spec: { task_id: `config-v${variant}`, lane: 'test-gap', prompt: 'Raise the test timeout in package.json so the slow test passes.', targets: { source_path: null, test_path: null }, declared_writes: ['package.json'], capability: CAP },
      files: { 'package.json': '{ "type": "module" }\n', 'src/slow.mjs': `export const slow${variant} = () => ${variant};\n` },
      mutant: null,
      solution: { 'package.json': `{ "type": "module", "testTimeout": ${variant * 1000} }\n` },
      macroPlan: () => [],
    });
  }
  return tasks;
}
