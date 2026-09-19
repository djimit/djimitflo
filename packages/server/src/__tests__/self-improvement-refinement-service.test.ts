import { describe, expect, it } from 'vitest';
import type { ImprovementProposal } from '../services/self-improvement-service';
import { SelfImprovementRefinementService } from '../services/self-improvement-refinement-service';

function fixtureProposal(): ImprovementProposal {
  return {
    id: 'proposal-1',
    type: 'feature',
    title: 'Build a commons-oracle runtime',
    description: 'We should build a commons-oracle runtime for meta-level feedback.',
    rationale: 'Reflections suggest this would help.',
    source: 'reflection',
    status: 'needs_more_evidence',
    priority: 0.5,
    evidenceRefs: ['reflection:abc'],
    panelId: 'panel-1',
    approvedBy: null,
    refinedAt: null,
    refinedFromId: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  };
}

const dissent = [
  { specialist_id: 'systems_architect', specialist_title: 'Systems Architect', stance: 'needs_evidence' as const, limitations: 'Lacks quantitative resource bounds for the runtime.' },
];

describe('SelfImprovementRefinementService', () => {
  it('produces a refined draft grounded in the original proposal and dissent', async () => {
    const service = new SelfImprovementRefinementService(async () =>
      JSON.stringify({ title: 'Refined: bound resource usage', description: 'Adds explicit resource bounds.', rationale: 'Addresses reviewer gap.' }),
    );
    const draft = await service.refine(fixtureProposal(), dissent);
    expect(draft).toEqual({
      title: 'Refined: bound resource usage',
      description: 'Adds explicit resource bounds.',
      rationale: 'Addresses reviewer gap.',
    });
  });

  it('includes each dissenting specialist\'s stance and limitations in the prompt sent to the model', async () => {
    let capturedPrompt = '';
    const service = new SelfImprovementRefinementService(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({ title: 't', description: 'd', rationale: 'r' });
    });
    await service.refine(fixtureProposal(), dissent);
    expect(capturedPrompt).toContain('Systems Architect');
    expect(capturedPrompt).toContain('needs_evidence');
    expect(capturedPrompt).toContain('Lacks quantitative resource bounds for the runtime.');
    expect(capturedPrompt).toContain('Do NOT invent');
  });

  it('falls back to null on an unparseable model response, without fabricating a draft', async () => {
    const service = new SelfImprovementRefinementService(async () => 'not json at all');
    const draft = await service.refine(fixtureProposal(), dissent);
    expect(draft).toBeNull();
  });

  it('falls back to null when the model omits title, description, or rationale', async () => {
    const service = new SelfImprovementRefinementService(async () => JSON.stringify({ title: 'only a title' }));
    const draft = await service.refine(fixtureProposal(), dissent);
    expect(draft).toBeNull();
  });

  it('falls back to null on a throwing model call instead of persisting a partial draft', async () => {
    const service = new SelfImprovementRefinementService(async () => { throw new Error('network down'); });
    const draft = await service.refine(fixtureProposal(), dissent);
    expect(draft).toBeNull();
  });

  it('extracts JSON from a markdown-fenced response', async () => {
    const service = new SelfImprovementRefinementService(async () =>
      '```json\n' + JSON.stringify({ title: 't', description: 'd', rationale: 'r' }) + '\n```',
    );
    const draft = await service.refine(fixtureProposal(), dissent);
    expect(draft).toEqual({ title: 't', description: 'd', rationale: 'r' });
  });
});
