import { describe, expect, it } from 'vitest';
import { AGENT_CONFIG_PATH, isAgentConfigPath, isHighRiskPath } from '../services/diff-capture';

describe('diff-capture exports (AGENT_CONFIG_PATH, isAgentConfigPath, isHighRiskPath)', () => {
  describe('AGENT_CONFIG_PATH', () => {
    it('is a RegExp', () => {
      expect(AGENT_CONFIG_PATH).toBeInstanceOf(RegExp);
    });
  });

  describe('isAgentConfigPath', () => {
    it('matches AGENTS.md at repo root', () => {
      expect(isAgentConfigPath('AGENTS.md')).toBe(true);
    });

    it('matches CLAUDE.md at repo root', () => {
      expect(isAgentConfigPath('CLAUDE.md')).toBe(true);
    });

    it('matches CLAUDE.local.md at repo root', () => {
      expect(isAgentConfigPath('CLAUDE.local.md')).toBe(true);
    });

    it('matches opencode.json at repo root', () => {
      expect(isAgentConfigPath('opencode.json')).toBe(true);
    });

    it('matches opencode.jsonc at repo root', () => {
      expect(isAgentConfigPath('opencode.jsonc')).toBe(true);
    });

    it('matches .mcp.json at repo root', () => {
      expect(isAgentConfigPath('.mcp.json')).toBe(true);
    });

    it('matches .github/copilot-instructions.md', () => {
      expect(isAgentConfigPath('.github/copilot-instructions.md')).toBe(true);
    });

    it('matches agent config files at any depth (nested AGENTS.md)', () => {
      expect(isAgentConfigPath('packages/server/AGENTS.md')).toBe(true);
    });

    it('matches nested opencode.json under a subdirectory', () => {
      expect(isAgentConfigPath('apps/web/opencode.json')).toBe(true);
    });

    it('matches .opencode/ directory entry', () => {
      expect(isAgentConfigPath('.opencode/commands/foo.md')).toBe(true);
    });

    it('matches .claude/ directory entry', () => {
      expect(isAgentConfigPath('.claude/skills/bar.md')).toBe(true);
    });

    it('matches .codex/ directory entry', () => {
      expect(isAgentConfigPath('.codex/config.toml')).toBe(true);
    });

    it('does not match an unrelated markdown file', () => {
      expect(isAgentConfigPath('README.md')).toBe(false);
    });

    it('does not match a generic json file', () => {
      expect(isAgentConfigPath('package.json')).toBe(false);
    });

    it('does not match a file merely containing the config name as a substring', () => {
      expect(isAgentConfigPath('my-AGENTS.md')).toBe(false);
      expect(isAgentConfigPath('not-opencode.json.bak')).toBe(false);
    });

    it('does not match an empty string', () => {
      expect(isAgentConfigPath('')).toBe(false);
    });

    it('is case-sensitive for the documented file names', () => {
      expect(isAgentConfigPath('agents.md')).toBe(false);
      expect(isAgentConfigPath('claude.md')).toBe(false);
    });
  });

  describe('isHighRiskPath', () => {
    it('matches an agent config path (high-risk set includes AGENT_CONFIG_PATH)', () => {
      expect(isHighRiskPath('AGENTS.md')).toBe(true);
      expect(isHighRiskPath('packages/server/.opencode/commands/foo.md')).toBe(true);
    });

    it('matches lockfiles', () => {
      expect(isHighRiskPath('package-lock.json')).toBe(true);
      expect(isHighRiskPath('pnpm-lock.yaml')).toBe(true);
      expect(isHighRiskPath('yarn.lock')).toBe(true);
    });

    it('matches github workflow files', () => {
      expect(isHighRiskPath('.github/workflows/ci.yml')).toBe(true);
    });

    it('matches docker-related files', () => {
      expect(isHighRiskPath('Dockerfile')).toBe(true);
      expect(isHighRiskPath('docker-compose.yml')).toBe(true);
    });

    it('matches .env files (critical risk set)', () => {
      expect(isHighRiskPath('.env')).toBe(true);
      expect(isHighRiskPath('.env.local')).toBe(true);
    });

    it('matches key/pem files (critical risk set)', () => {
      expect(isHighRiskPath('id_rsa')).toBe(true);
      expect(isHighRiskPath('deploy.pem')).toBe(true);
      expect(isHighRiskPath('signing.key')).toBe(true);
    });

    it('matches secrets/credentials paths', () => {
      expect(isHighRiskPath('secrets/production.json')).toBe(true);
      expect(isHighRiskPath('config/credentials.yml')).toBe(true);
    });

    it('matches migrations directory', () => {
      expect(isHighRiskPath('migrations/0001_init.sql')).toBe(true);
    });

    it('does not match an ordinary source file', () => {
      expect(isHighRiskPath('packages/server/src/services/diff-capture.ts')).toBe(false);
    });

    it('does not match a regular markdown file', () => {
      expect(isHighRiskPath('docs/runbooks/example.md')).toBe(false);
    });
  });
});
