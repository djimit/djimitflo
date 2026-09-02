// Flat ESLint config (ESLint 9). Shared across all @djimitflo workspaces.
// Scope intentionally lenient: TypeScript strict mode (tsc --noEmit) already
// enforces unused locals/params, explicit any, etc. ESLint here adds the
// structural/safety rules from @typescript-eslint/recommended that tsc cannot
// catch. Tighten incrementally once the baseline is green in CI.
import tseslint from 'typescript-eslint';

// TS 7 note: typescript-eslint 8.x parses with the TS 6 API and refuses TS 7.0.
// The rules used here are all type-agnostic (no type-information required), so
// we disable typed linting and let ESLint run with its own lightweight TS
// parser surface until typescript-eslint ships TS 7.1+ support (issue #10940).
process.env.TYPESCRIPT_ESLINT_TSCONFIG_SKIP = '1';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.djimitflo-loop-worktrees/**',
      '**/*.config.{js,cjs,mjs,ts}',
      'eslint.config.mjs',
      // Tooling and external sub-projects outside the @djimitflo workspaces.
      '.swarm/**',
      '.metaharness-fork/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // tsc noUnusedLocals/noUnusedParameters already covers these; avoid double-reporting.
      '@typescript-eslint/no-unused-vars': 'off',
      // `any` is accepted in this control-plane code; flagged via tsc if needed.
      '@typescript-eslint/no-explicit-any': 'off',
      // Lazy `require()` is used deliberately for optional/native module loads
      // (e.g. better-sqlite3, the optional telegram gateway). ESM-purity nit, not a bug.
      '@typescript-eslint/no-require-imports': 'off',
      // A namespace is used for typed global augmentation (middleware/auth.ts).
      '@typescript-eslint/no-namespace': 'off',
    },
  },
);