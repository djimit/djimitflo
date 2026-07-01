# Security Fix Plan: execSync Timeouts

This file documents the security fix for GitHub issue #30.

## Pattern
Before: execSync('git status', { cwd: repoPath, encoding: 'utf-8' });
After:  execSync('git status', { cwd: repoPath, encoding: 'utf-8', timeout: 10_000 });

## Files
- repository-scanner.ts (8 calls)
- self-repository-service.ts (7 calls)
- self-deploy-service.ts (5 calls)
- diff-capture.ts (3 calls)
