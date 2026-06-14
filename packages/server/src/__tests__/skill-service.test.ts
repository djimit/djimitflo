import { describe, it, expect } from 'vitest';
import { SkillService } from '../services/skill-service';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const TEST_OKF_BASE = path.join(__dirname, '__test_okf_skills__');

describe('SkillService', () => {
  let service: SkillService;
  let db: Database.Database;

  beforeEach(() => {
    if (fs.existsSync(TEST_OKF_BASE)) {
      fs.rmSync(TEST_OKF_BASE, { recursive: true });
    }
    fs.mkdirSync(path.join(TEST_OKF_BASE, 'skills'), { recursive: true });
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT, capabilities TEXT, metadata TEXT);
      INSERT INTO agents VALUES ('test-agent', 'Test Agent', 'desc', 'active', '[]', '{}');
    `);
    service = new SkillService(db);
    // Override OKF_BASE for tests
    (service as any).skillsDir = path.join(TEST_OKF_BASE, 'skills');
    (service as any).reportsDir = path.join(TEST_OKF_BASE, 'reports');
    fs.mkdirSync((service as any).reportsDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
  });

  it('validate passes for valid frontmatter', () => {
    const skillPath = 'test-skill';
    const skillContent = `---
type: Skill
title: "Test Skill"
description: "A test skill"
trust_level: agent_generated
status: draft
timestamp: 2026-06-14T00:00:00Z
---

# Test Skill

Some content here.
`;
    fs.mkdirSync(path.join(TEST_OKF_BASE, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(TEST_OKF_BASE, 'skills', 'test-skill.md'), skillContent, 'utf8');

    // Override OKF_BASE via the service's internal paths
    (service as any).skillsDir = path.join(TEST_OKF_BASE, 'skills');
    (service as any).reportsDir = path.join(TEST_OKF_BASE, 'reports', 'validation');
    fs.mkdirSync((service as any).reportsDir, { recursive: true });

    const result = service.validate(skillPath, 'process');
    expect(result.status).toBe('validated');
    expect(result.skillId).toBe('test-skill');
  });

it('validate fails for missing frontmatter', () => {
    const skillPath = 'bad-skill';
    fs.mkdirSync(path.join(TEST_OKF_BASE, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(TEST_OKF_BASE, 'skills', 'bad-skill.md'), 'No frontmatter here', 'utf8');

    (service as any).skillsDir = path.join(TEST_OKF_BASE, 'skills');

    const result = service.validate(skillPath, 'process');
    expect(result.status).toBe('failed');
  });

  it('validate fails for missing required fields', () => {
    const skillPath = 'incomplete-skill';
    fs.mkdirSync(path.join(TEST_OKF_BASE, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(TEST_OKF_BASE, 'skills', 'incomplete-skill.md'), `---
title: "Missing Type"
---

# Missing type
`, 'utf8');

    (service as any).skillsDir = path.join(TEST_OKF_BASE, 'skills');

    const result = service.validate(skillPath, 'process');
    expect(result.status).toBe('failed');
  });

it('push rejects non-validated skills', async () => {
    const skillPath = 'draft-skill';
    fs.mkdirSync(path.join(TEST_OKF_BASE, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(TEST_OKF_BASE, 'skills', 'draft-skill.md'), `---
type: Skill
title: "Draft"
description: "Draft skill"
trust_level: agent_generated
status: draft
timestamp: 2026-06-14T00:00:00Z
---

# Draft
`, 'utf8');

    (service as any).skillsDir = path.join(TEST_OKF_BASE, 'skills');

    const result = await service.push('test-agent', skillPath, 'ssh');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not validated');
  });
});