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

  afterEach(() => {
    if (originalBase === undefined) delete process.env.OKF_BASE; else process.env.OKF_BASE = originalBase;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

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

describe('renderFrontierSkill', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('renders correct frontmatter and body for a multi-capability skill', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-rs-'));
    const skill = FRONTIER_SKILLS[0]; // software-engineering-analysis, 5 caps
    const rendered = renderFrontierSkill(skill);

    // Frontmatter block
    expect(rendered.startsWith('---\ntype: Skill\n')).toBe(true);
    expect(rendered).toContain(`title: ${skill.title}\n`);
    expect(rendered).toContain(`description: ${skill.purpose}\n`);
    expect(rendered).toContain(`tags: [skill, frontier-experts, ${skill.slug}]\n`);
    expect(rendered).toContain(`capabilities: [${skill.capabilities.join(', ')}]\n`);
    expect(rendered).toContain('status: draft\n');
    expect(rendered).toContain('trust_level: system_generated\n');
    expect(rendered).toContain('generated_by: frontier-expert-intelligence\n');
    expect(rendered).toMatch(/\n---\n/);

    // Body sections
    expect(rendered).toContain(`# ${skill.title}`);
    expect(rendered).toContain(`Purpose: ${skill.purpose}`);
    expect(rendered).toContain(`Applicable capabilities: ${skill.capabilities.join(', ')}.`);
    expect(rendered).toContain('## Procedure');
    expect(rendered).toContain('1. Restate the question and the capability families it touches; abstain if none apply.');
    expect(rendered).toContain(`2. Required evidence: ${skill.evidence}. Use only evidence items listed in the prompt; absence of evidence is not evidence of absence.`);
    expect(rendered).toContain('3. Extract claims as subject / relation / object with polarity and the evidence ids that support each; never attribute views to a person beyond their cited work.');
    expect(rendered).toContain(`4. Falsification: ${skill.falsification}`);
    expect(rendered).toContain('5. Report uncertainties and the conditions under which each claim holds; preserve disagreement with other perspectives instead of averaging.');
    expect(rendered).toContain('## Prohibited shortcuts');
    expect(rendered).toContain(`- ${skill.shortcuts}.`);
    expect(rendered).toContain('- No impersonation, no unsupported attribution, no citation counts as truth.');
    expect(rendered).toContain('## Recommended expert retrieval');

    // Expert retrieval line: backtick-wrapped capabilities joined by ', '
    const expectedRetrieval = `- Resolve experts by capability ${skill.capabilities.map((c) => `\`${c}\``).join(', ')} with primary (Tier-1) evidence; famous but irrelevant experts do not qualify.`;
    expect(rendered).toContain(expectedRetrieval);
  });

  it('renders single-capability skill without extra commas', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-rs-'));
    const skill = FRONTIER_SKILLS.find(s => s.capabilities.length === 1)!;
    const rendered = renderFrontierSkill(skill);
    expect(rendered).toContain(`capabilities: [${skill.capabilities[0]}]\n`);
    expect(rendered).toContain(`Applicable capabilities: ${skill.capabilities[0]}.`);
    expect(rendered).toContain(`\`${skill.capabilities[0]}\``);
  });

  it('renders all 15 skills producing distinct outputs', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-rs-'));
    const outputs = new Set(FRONTIER_SKILLS.map(s => renderFrontierSkill(s)));
    expect(outputs.size).toBe(15);
  });
});

describe('installFrontierSkills', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('creates nested directory if missing and writes all 15 files', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-inst-'));
    const newDir = path.join(tmp, 'nested', 'skills');
    expect(fs.existsSync(newDir)).toBe(false);
    const result = installFrontierSkills(newDir);
    expect(fs.existsSync(newDir)).toBe(true);
    expect(result).toHaveLength(15);
    for (const skill of FRONTIER_SKILLS) {
      expect(fs.existsSync(path.join(newDir, `${skill.slug}.md`))).toBe(true);
    }
  });

  it('keeps existing files when force is false (default)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-inst-'));
    const skillsDir = path.join(tmp, 'skills');
    installFrontierSkills(skillsDir);
    const target = path.join(skillsDir, `${FRONTIER_SKILLS[0].slug}.md`);
    fs.writeFileSync(target, 'MODIFIED CONTENT', 'utf8');
    const secondRun = installFrontierSkills(skillsDir);
    expect(secondRun.every(item => item.action === 'kept')).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('MODIFIED CONTENT');
  });

  it('overwrites all files when force is true', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-inst-'));
    const skillsDir = path.join(tmp, 'skills');
    installFrontierSkills(skillsDir);
    const target = path.join(skillsDir, `${FRONTIER_SKILLS[0].slug}.md`);
    fs.writeFileSync(target, 'MODIFIED CONTENT', 'utf8');
    const forcedRun = installFrontierSkills(skillsDir, { force: true });
    expect(forcedRun.every(item => item.action === 'written')).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).not.toBe('MODIFIED CONTENT');
    expect(fs.readFileSync(target, 'utf8')).toBe(renderFrontierSkill(FRONTIER_SKILLS[0]));
  });

  it('returns correct slug and path for each entry', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-inst-'));
    const skillsDir = path.join(tmp, 'skills');
    const result = installFrontierSkills(skillsDir);
    result.forEach((item, i) => {
      expect(item.slug).toBe(FRONTIER_SKILLS[i].slug);
      expect(item.path).toBe(path.join(skillsDir, `${FRONTIER_SKILLS[i].slug}.md`));
      expect(item.action).toBe('written');
    });
  });

  it('writes content identical to renderFrontierSkill output for every skill', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-inst-'));
    const skillsDir = path.join(tmp, 'skills');
    installFrontierSkills(skillsDir);
    for (const skill of FRONTIER_SKILLS) {
      const fileContent = fs.readFileSync(path.join(skillsDir, `${skill.slug}.md`), 'utf8');
      expect(fileContent, skill.slug).toBe(renderFrontierSkill(skill));
    }
  });
});

describe('procedureForCapability', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns null for unknown capability id', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pfc-'));
    expect(procedureForCapability('nonexistent_capability_xyz', null)).toBeNull();
  });

  it('returns built-in procedure when skills dir is empty (file not installed)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pfc-'));
    const emptyDir = path.join(tmp, 'empty');
    fs.mkdirSync(emptyDir);
    const proc = procedureForCapability('scaling_laws', emptyDir);
    expect(proc).not.toBeNull();
    expect(proc!).toContain('scaling-analysis: ## Procedure');
    expect(proc!).toContain('State the extrapolation point where the law is untested');
  });

  it('reads from installed file when available (file wins over built-in text)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pfc-'));
    const skillsDir = path.join(tmp, 'skills');
    installFrontierSkills(skillsDir);
    const target = path.join(skillsDir, 'ai-security-analysis.md');
    const customContent = '---\ntype: Skill\n---\n# Custom\n## Procedure\nCUSTOM PROCEDURE TEXT HERE\n## Recommended expert retrieval\n- nothing';
    fs.writeFileSync(target, customContent, 'utf8');
    const proc = procedureForCapability('ai_security', skillsDir);
    expect(proc).toBe('ai-security-analysis: ## Procedure\nCUSTOM PROCEDURE TEXT HERE');
  });

  it('falls back to built-in text when installed file does not exist on disk', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pfc-'));
    const emptyDir = path.join(tmp, 'empty');
    fs.mkdirSync(emptyDir);
    const proc = procedureForCapability('alignment', emptyDir);
    expect(proc).not.toBeNull();
    expect(proc!).toContain('alignment-analysis: ## Procedure');
    expect(proc!).toContain('Describe the distribution shift or adversarial setting where the alignment method is untested.');
  });

  it('slices between ## Procedure and ## Recommended expert retrieval (inclusive of Prohibited shortcuts)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pfc-'));
    const skillsDir = path.join(tmp, 'skills');
    installFrontierSkills(skillsDir);
    const proc = procedureForCapability('cyber_capabilities', skillsDir);
    expect(proc).not.toBeNull();
    expect(proc!).toContain('## Procedure');
    expect(proc!).toContain('1. Restate the question');
    expect(proc!).toContain('5. Report uncertainties');
    expect(proc!).toContain('## Prohibited shortcuts');
    // Must NOT include the Recommended expert retrieval section header
    expect(proc!).not.toContain('## Recommended expert retrieval');
  });

  it('returns null when installed file has no ## Procedure section', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pfc-'));
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(skillsDir);
    const target = path.join(skillsDir, 'alignment-analysis.md');
    fs.writeFileSync(target, '# No procedure here\nJust text without sections.', 'utf8');
    const proc = procedureForCapability('alignment', skillsDir);
    expect(proc).toBeNull();
  });

  it('includes full remainder when end marker is absent (end <= start case)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pfc-'));
    const skillsDir = path.join(tmp, 'skills');
    fs.mkdirSync(skillsDir);
    const target = path.join(skillsDir, 'scaling-analysis.md');
    fs.writeFileSync(target, '## Procedure\nSome steps here.\nNo end marker follows.', 'utf8');
    const proc = procedureForCapability('scaling_laws', skillsDir);
    expect(proc).not.toBeNull();
    expect(proc!).toContain('Some steps here.');
    expect(proc!).toContain('No end marker follows.');
  });

  it('resolves every covered capability to a non-null procedure with correct slug prefix', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-pfc-'));
    const skillsDir = path.join(tmp, 'skills');
    installFrontierSkills(skillsDir);
    const coveredCaps = new Set(FRONTIER_SKILLS.flatMap(s => s.capabilities));
    for (const cap of coveredCaps) {
      const proc = procedureForCapability(cap, skillsDir);
      expect(proc, `capability ${cap}`).not.toBeNull();
      expect(proc!).toMatch(/^[a-z][a-z0-9-]*: ## Procedure/);
    }
  });
});

describe('FRONTIER_SKILLS data integrity', () => {
  let tmp: string | undefined;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('has exactly 15 unique kebab-case slugs', () => {
    const slugs = FRONTIER_SKILLS.map(s => s.slug);
    expect(slugs).toHaveLength(15);
    expect(new Set(slugs).size).toBe(15);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  });

  it('every skill has non-empty required fields and at least one capability', () => {
    for (const skill of FRONTIER_SKILLS) {
      expect(skill.slug.length, `${skill.slug} slug`).toBeGreaterThan(0);
      expect(skill.title.length, `${skill.slug} title`).toBeGreaterThan(0);
      expect(skill.capabilities.length, `${skill.slug} capabilities`).toBeGreaterThanOrEqual(1);
      expect(skill.purpose.length, `${skill.slug} purpose`).toBeGreaterThan(0);
      expect(skill.evidence.length, `${skill.slug} evidence`).toBeGreaterThan(0);
      expect(skill.falsification.length, `${skill.slug} falsification`).toBeGreaterThan(0);
      expect(skill.shortcuts.length, `${skill.slug} shortcuts`).toBeGreaterThan(0);
    }
  });
});
