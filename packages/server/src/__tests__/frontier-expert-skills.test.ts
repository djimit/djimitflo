import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FRONTIER_SKILLS, installFrontierSkills, procedureForCapability } from '../services/frontier-expert-skills';
import { SkillService } from '../services/skill-service';
import { CAPABILITY_TAXONOMY } from '../services/frontier-expert-registry-service';
import { buildPerspectivePrompt } from '../services/expert-perspective-builder';

describe('frontier analysis skills (§34) through SkillService/OKF', () => {
  const originalBase = process.env.OKF_BASE;
  let tmp: string;
  afterEach(() => { if (originalBase === undefined) delete process.env.OKF_BASE; else process.env.OKF_BASE = originalBase; fs.rmSync(tmp, { recursive: true, force: true }); });

  it('installs the §34 skills (fourteen + software engineering, E4) idempotently, all validate, and every taxonomy capability has a skill', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    process.env.OKF_BASE = tmp;
    const skillsDir = path.join(tmp, 'skills');
    expect(FRONTIER_SKILLS).toHaveLength(15);
    const written = installFrontierSkills(skillsDir);
    expect(written.every((item) => item.action === 'written')).toBe(true);
    expect(installFrontierSkills(skillsDir).every((item) => item.action === 'kept')).toBe(true);
    const covered = new Set(FRONTIER_SKILLS.flatMap((skill) => skill.capabilities));
    expect(CAPABILITY_TAXONOMY.filter((capability) => !covered.has(capability.id)).map((capability) => capability.id)).toEqual(['reasoning', 'human_ai_interaction']);

    const db = new Database(':memory:');
    db.exec(schema); runMigrations(db);
    const skills = new SkillService(db);
    for (const skill of FRONTIER_SKILLS) expect(skills.validate(`skills/${skill.slug}`).status, skill.slug).toBe('validated');
    expect(skills.getSkillProcedure('ai-security-analysis')).toContain('AI security analysis');
    db.close();
  });

  it('feeds the capability procedure into the perspective prompt without weakening the no-persona rules', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    const procedure = procedureForCapability('ai_security', path.join(tmp, 'skills'));
    expect(procedure).toMatch(/^ai-security-analysis: ## Procedure/);
    expect(procedure).toContain('adaptive attack');
    expect(procedureForCapability('not_a_capability', null)).toBeNull();
    const prompt = buildPerspectivePrompt({ expert: { id: 'expert:1', canonical_name: 'Some Researcher', capabilities: ['ai_security'] }, question: 'Which defences hold?', evidence: [], procedure });
    expect(prompt.system).toContain('Follow this analysis procedure (skill ai-security-analysis');
    expect(prompt.system).toContain('You are NOT this person');
  });
});
