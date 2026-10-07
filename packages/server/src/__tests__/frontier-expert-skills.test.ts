import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FRONTIER_SKILLS, installFrontierSkills, procedureForCapability, renderFrontierSkill } from '../services/frontier-expert-skills';
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

describe('renderFrontierSkill and procedureForCapability edge cases', () => {
  const originalBase = process.env.OKF_BASE;
  let tmp = '';
  afterEach(() => { if (originalBase === undefined) delete process.env.OKF_BASE; else process.env.OKF_BASE = originalBase; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('renderFrontierSkill wraps each capability in backticks inside the recommended-expert-retrieval line', () => {
    const skill = FRONTIER_SKILLS.find((item) => item.slug === 'ai-security-analysis')!;
    const rendered = renderFrontierSkill(skill);
    expect(rendered).toContain('## Recommended expert retrieval');
    for (const capability of skill.capabilities) expect(rendered).toContain(`\`${capability}\``);
    expect(rendered).toContain('- Resolve experts by capability');
    expect(rendered).toContain('## Procedure');
    expect(rendered).toContain('## Prohibited shortcuts');
    expect(rendered).toContain('status: draft');
    expect(rendered).toContain('trust_level: system_generated');
    expect(rendered).toContain('generated_by: frontier-expert-intelligence');
  });

  it('installFrontierSkills rewrites existing files when force is set', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    const skillsDir = path.join(tmp, 'skills');
    const first = installFrontierSkills(skillsDir);
    expect(first.every((item) => item.action === 'written')).toBe(true);
    const target = path.join(skillsDir, 'ai-security-analysis.md');
    fs.writeFileSync(target, 'tampered', 'utf8');
    const forced = installFrontierSkills(skillsDir, { force: true });
    expect(forced.find((item) => item.slug === 'ai-security-analysis')!.action).toBe('written');
    expect(fs.readFileSync(target, 'utf8')).not.toBe('tampered');
    expect(fs.readFileSync(target, 'utf8')).toContain('## Procedure');
  });

  it('procedureForCapability reads the installed file (not the built-in text) when skillsDir points at it', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    const skillsDir = path.join(tmp, 'skills');
    installFrontierSkills(skillsDir);
    const customMarker = 'CUSTOM_PROCEDURE_BODY_MARKER';
    const target = path.join(skillsDir, 'ai-security-analysis.md');
    const installed = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, installed.replace('## Procedure', `## Procedure\n${customMarker}`), 'utf8');
    const procedure = procedureForCapability('ai_security', skillsDir);
    expect(procedure).toContain(customMarker);
    expect(procedure).toMatch(/^ai-security-analysis: ## Procedure/);
  });

  it('procedureForCapability falls back to the built-in text when the installed file is missing (skillsDir null) for a valid capability', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    const procedure = procedureForCapability('ai_security', null);
    expect(procedure).toMatch(/^ai-security-analysis: ## Procedure/);
    expect(procedure).toContain('adaptive attack');
    expect(procedure).toContain('## Prohibited shortcuts');
    expect(procedure).not.toContain('## Recommended expert retrieval');
    expect(procedure).not.toContain('famous but irrelevant experts do not qualify');
  });

  it('procedureForCapability returns null when the installed file has no Procedure section, even with skillsDir set', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'ai-security-analysis.md'), 'no procedure here at all', 'utf8');
    expect(procedureForCapability('ai_security', skillsDir)).toBeNull();
  });

  it('procedureForCapability slices exactly up to the Recommended expert retrieval header and trims whitespace', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    const skillsDir = path.join(tmp, 'skills');
    installFrontierSkills(skillsDir);
    const procedure = procedureForCapability('frontier_model_engineering', skillsDir);
    expect(procedure).not.toContain('## Recommended expert retrieval');
    expect(procedure).not.toContain('famous but irrelevant experts do not qualify');
    expect(procedure).toContain('## Prohibited shortcuts');
    expect(procedure!.endsWith('- No impersonation, no unsupported attribution, no citation counts as truth.')).toBe(true);
    expect(procedure!.startsWith('frontier-model-analysis: ## Procedure')).toBe(true);
  });

  it('procedureForCapability keeps the trailing remainder when the installed file has no retrieval header', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const onlyProcedure = '## Procedure\nstep one\nstep two\nstep three';
    fs.writeFileSync(path.join(skillsDir, 'scaling-analysis.md'), onlyProcedure, 'utf8');
    const procedure = procedureForCapability('scaling_laws', skillsDir);
    expect(procedure).toBe('scaling-analysis: ## Procedure\nstep one\nstep two\nstep three');
  });

  it('procedureForCapability without an explicit skillsDir resolves the default OKF skills dir via OKF_BASE', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-skills-'));
    process.env.OKF_BASE = tmp;
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const customMarker = 'DEFAULT_DIR_MARKER';
    fs.writeFileSync(path.join(skillsDir, 'cyber-capability-analysis.md'), `## Procedure\n${customMarker}`, 'utf8');
    const procedure = procedureForCapability('cyber_capabilities');
    expect(procedure).toContain(customMarker);
  });
});
