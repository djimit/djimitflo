# G266 server regression

`npm run test --workspace=@djimitflo/server --silent`

- 323 test files passed, 2 skipped
- 2,527 tests passed, 20 skipped, 0 failed
- Existing fixture diagnostic `fatal: not a git repository` remains non-fatal.

`npm run type-check --silent`, `npm run build --silent`, `npm run lint --silent`, and `git diff --check` passed.
