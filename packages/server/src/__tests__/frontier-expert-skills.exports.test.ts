import { describe, expect, it } from 'vitest';
import { FRONTIER_SKILLS, renderFrontierSkill, type FrontierSkill } from '../services/frontier-expert-skills';

describe('renderFrontierSkill', () => {
  const sample: FrontierSkill = FRONTIER_SKILLS[0];

  it('emits YAML frontmatter with type, title, description, capabilities and draft status', () => {
    const rendered = renderFrontierSkill(sample);
    expect(rendered.startsWith('---\n')).toBe(true);
    const close = rendered.indexOf('\n---', 3);
    const frontmatter = rendered.slice(3, close);
    expect(frontmatter).toContain('type: Skill');
    expect(frontmatter).toContain(`title: ${sample.title}`);
    expect(frontmatter).toContain(`description: ${sample.purpose}`);
    expect(frontmatter).toContain(`capabilities: [${sample.capabilities.join(', ')}]`);
    expect(frontmatter).toContain('status: draft');
    expect(frontmatter).toContain('trust_level: system_generated');
    expect(frontmatter).toContain('generated_by: frontier-expert-intelligence');
    expect(frontmatter).toContain(`tags: [skill, frontier-experts, ${sample.slug}]`);
  });

  it('renders the title as an H1 heading followed by the purpose and capabilities', () => {
    const rendered = renderFrontierSkill(sample);
    expect(rendered).toContain(`# ${sample.title}`);
    expect(rendered).toContain(`Purpose: ${sample.purpose}`);
    expect(rendered).toContain(`Applicable capabilities: ${sample.capabilities.join(', ')}.`);
  });

  it('includes the Procedure section with five ordered steps and the required-evidence text', () => {
    const rendered = renderFrontierSkill(sample);
    expect(rendered).toContain('## Procedure');
    expect(rendered).toContain('1. Restate the question and the capability families it touches; abstain if none apply.');
    expect(rendered).toContain(`2. Required evidence: ${sample.evidence}.`);
    expect(rendered).toContain('3. Extract claims as subject / relation / object');
    expect(rendered).toContain(`4. Falsification: ${sample.falsification}`);
    expect(rendered).toContain('5. Report uncertainties and the conditions under which each claim holds;');
  });

  it('includes the Prohibited shortcuts section containing the skill-specific shortcut text', () => {
    const rendered = renderFrontierSkill(sample);
    expect(rendered).toContain('## Prohibited shortcuts');
    expect(rendered).toContain(`- ${sample.shortcuts}.`);
    expect(rendered).toContain('- No impersonation, no unsupported attribution, no citation counts as truth.');
  });

  it('lists each capability wrapped in backticks under Recommended expert retrieval', () => {
    const rendered = renderFrontierSkill(sample);
    expect(rendered).toContain('## Recommended expert retrieval');
    expect(rendered).toContain('Resolve experts by capability');
    for (const capability of sample.capabilities) {
      expect(rendered).toContain(`\`${capability}\``);
    }
  });

  it('renders every skill in FRONTIER_SKILLS without throwing and preserves each slug in tags', () => {
    for (const skill of FRONTIER_SKILLS) {
      const rendered = renderFrontierSkill(skill);
      expect(rendered).toContain(`title: ${skill.title}`);
      expect(rendered).toContain(`tags: [skill, frontier-experts, ${skill.slug}]`);
      expect(rendered).toContain(`# ${skill.title}`);
      expect(rendered).toContain(`## Procedure`);
    }
  });

  it('joins multiple capabilities with a comma-space separator in both frontmatter and prose', () => {
    const multi: FrontierSkill = {
      slug: 'multi-cap',
      title: 'Multi capability skill',
      capabilities: ['alpha', 'beta', 'gamma'],
      purpose: 'multi purpose',
      evidence: 'multi evidence',
      falsification: 'multi falsification',
      shortcuts: 'multi shortcuts',
    };
    const rendered = renderFrontierSkill(multi);
    expect(rendered).toContain('capabilities: [alpha, beta, gamma]');
    expect(rendered).toContain('Applicable capabilities: alpha, beta, gamma.');
  });
});