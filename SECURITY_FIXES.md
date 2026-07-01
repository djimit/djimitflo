# Security Fix: execSync Timeouts

## Issue
Multiple execSync calls lack timeout parameter (GitHub issue #30).

## Files to Fix
- packages/server/src/services/repository-scanner.ts
- packages/server/src/services/self-repository-service.ts
- packages/server/src/services/self-deploy-service.ts
- packages/server/src/services/diff-capture.ts

## Fix Pattern
Before: execSync('git status', { cwd: repoPath, encoding: 'utf-8' });
After:  execSync('git status', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 });

## Status
- [ ] Fix repository-scanner.ts
- [ ] Fix self-repository-service.ts
- [ ] Fix self-deploy-service.ts
- [ ] Fix diff-capture.ts
- [ ] Add tests
- [ ] Verify all 909 tests pass
