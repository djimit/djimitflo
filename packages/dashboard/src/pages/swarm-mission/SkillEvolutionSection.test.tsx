import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SkillEvolutionReadiness } from '../../lib/api';
import { SkillEvolutionSection, StatusBadge } from './SkillEvolutionSection';

const noopRun = async () => undefined;

const skill = (over: Partial<SkillEvolutionReadiness> = {}): SkillEvolutionReadiness => ({
  capability_id: 'cap-writing',
  candidate_id: null,
  artifact_lifecycle: null,
  skill_id: 'skill-writing',
  skill_version: '3',
  candidate_hash: 'abcdef1234567890',
  status: 'routable',
  assigned_agents: 4,
  candidate_runs: 2,
  baseline_hashes: ['h1', 'h2'],
  openmythos_run_id: 'run-42',
  evidence_ready: true,
  blocked_reasons: [],
  promotion_input: null,
  ...over,
});

describe('StatusBadge', () => {
  it('uses the success tone for routable, available, start, truth-gated, supported, validated', () => {
    for (const status of ['routable', 'available', 'start', 'truth-gated', 'supported', 'validated']) {
      const html = renderToStaticMarkup(<StatusBadge status={status} />);
      expect(html).toContain('text-status-success');
      expect(html).toContain(status);
    }
  });

  it('uses the warning tone for blocked, contradicted, review_required, skip, draft, candidate', () => {
    for (const status of ['blocked', 'contradicted', 'review_required', 'skip', 'draft', 'candidate']) {
      const html = renderToStaticMarkup(<StatusBadge status={status} />);
      expect(html).toContain('text-status-warning');
      expect(html).toContain(status);
    }
  });

  it('uses the neutral tone for any other status', () => {
    const html = renderToStaticMarkup(<StatusBadge status="unknown" />);
    expect(html).toContain('text-foreground-secondary');
    expect(html).not.toContain('text-status-success');
    expect(html).not.toContain('text-status-warning');
  });

  it('matches the tone case-insensitively while preserving the displayed text', () => {
    const html = renderToStaticMarkup(<StatusBadge status="ROUTABLE" />);
    expect(html).toContain('text-status-success');
    expect(html).toContain('ROUTABLE');
  });
});

describe('SkillEvolutionSection', () => {
  it('renders the heading and the bounded-candidate description', () => {
    const html = renderToStaticMarkup(<SkillEvolutionSection skills={[]} actionId={null} run={noopRun} />);
    expect(html).toContain('Skill Evolution Readiness');
    expect(html).toContain('Paired candidate checks are bound to exact skill hashes');
  });

  it('renders the empty-state row when there are no skills', () => {
    const html = renderToStaticMarkup(<SkillEvolutionSection skills={[]} actionId={null} run={noopRun} />);
    expect(html).toContain('No governed skill capabilities registered.');
  });

  it('renders each skill row with id, version, hash prefix, counts and openmythos run id', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection skills={[skill()]} actionId={null} run={noopRun} />,
    );
    expect(html).toContain('skill-writing');
    expect(html).toContain('v3');
    expect(html).toContain('abcdef123456');
    expect(html).toContain('4');
    expect(html).toContain('2');
    expect(html).toContain('run-42');
  });

  it('falls back to capability_id and unattributed when skill_id and hash are empty', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[skill({ skill_id: '', skill_version: '', candidate_hash: '' })]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).toContain('cap-writing');
    expect(html).toContain('v?');
    expect(html).toContain('unattributed');
  });

  it('shows a ready badge and omits blocked reasons when evidence is ready', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection skills={[skill({ evidence_ready: true })]} actionId={null} run={noopRun} />,
    );
    expect(html).toContain('>ready<');
    expect(html).not.toContain('no baseline');
  });

  it('shows a blocked badge and joined blocked reasons when evidence is not ready', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[skill({ evidence_ready: false, blocked_reasons: ['no baseline', 'oracle gap'] })]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).toContain('>blocked<');
    expect(html).toContain('text-status-warning');
    expect(html).toContain('no baseline, oracle gap');
  });

  it('renders "not evaluated" when a skill has no paired comparison', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection skills={[skill({ candidate_comparison: null })]} actionId={null} run={noopRun} />,
    );
    expect(html).toContain('not evaluated');
  });

  it('renders the paired comparison verdict, scores, reason, run duration and per-case evidence', () => {
    const comparison: SkillEvolutionReadiness['candidate_comparison'] = {
      verdict: 'PASS',
      reason: 'candidate improved coherence',
      baseline_score: 71,
      candidate_score: 88,
      baseline_eval_id: 'eval-b',
      candidate_eval_id: 'eval-c',
      cases: [
        {
          case_id: 'case-001',
          baseline_status: 'partial',
          candidate_status: 'complete',
          baseline_score: 60,
          candidate_score: 90,
          baseline_scoring_source: 'oracle',
          candidate_scoring_source: 'oracle',
          baseline_oracle_pass: true,
          candidate_oracle_pass: true,
          oracle_regression: false,
        },
      ],
      manifest: { baseline_run_ms: 1200, candidate_run_ms: 1500 },
    };
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[skill({ candidate_comparison: comparison })]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).toContain('pass');
    expect(html).toContain('71');
    expect(html).toContain('88');
    expect(html).toContain('candidate improved coherence');
    expect(html).toContain('1200 ms');
    expect(html).toContain('1500 ms');
    expect(html).toContain('Per-case evidence (1)');
    expect(html).toContain('case-001');
  });

  it('marks a regression in per-case evidence', () => {
    const comparison: SkillEvolutionReadiness['candidate_comparison'] = {
      verdict: 'FAIL',
      reason: 'oracle regression',
      baseline_score: 70,
      candidate_score: 40,
      baseline_eval_id: 'eval-b',
      candidate_eval_id: 'eval-c',
      cases: [
        {
          case_id: 'case-002',
          baseline_status: 'complete',
          candidate_status: 'partial',
          baseline_score: 90,
          candidate_score: 30,
          baseline_scoring_source: 'oracle',
          candidate_scoring_source: 'oracle',
          baseline_oracle_pass: true,
          candidate_oracle_pass: false,
          oracle_regression: true,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[skill({ candidate_comparison: comparison })]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).toContain('REGRESSION');
  });

  it('shows the rollback button only when artifact_lifecycle is active and a candidate_id exists', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[skill({ artifact_lifecycle: 'active', candidate_id: 'cand-9' })]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).toContain('Roll back for new runs');
  });

  it('omits the rollback button when artifact_lifecycle is not active', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[skill({ artifact_lifecycle: 'rolled-back', candidate_id: 'cand-9' })]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).not.toContain('Roll back for new runs');
  });

  it('shows the run-paired-comparison button for candidate skills with a candidate id', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[skill({ status: 'candidate', candidate_id: 'cand-9' })]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).toContain('Run paired comparison');
  });

  it('omits the run-paired-comparison button for non-candidate skills', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[skill({ status: 'routable', candidate_id: 'cand-9' })]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).not.toContain('Run paired comparison');
  });

  it('shows the submit-to-promotion-gate button for evidence-ready candidates with promotion input', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[
          skill({
            status: 'candidate',
            candidate_id: 'cand-9',
            evidence_ready: true,
            promotion_input: { summary: 'ready' },
          }),
        ]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).toContain('Submit to existing promotion gate');
  });

  it('omits the submit-to-promotion-gate button when promotion input is missing', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[
          skill({ status: 'candidate', candidate_id: 'cand-9', evidence_ready: true, promotion_input: null }),
        ]}
        actionId={null}
        run={noopRun}
      />,
    );
    expect(html).not.toContain('Submit to existing promotion gate');
  });

  it('disables action buttons while an action is running (actionId set)', () => {
    const html = renderToStaticMarkup(
      <SkillEvolutionSection
        skills={[
          skill({ status: 'candidate', candidate_id: 'cand-9', evidence_ready: true, promotion_input: { x: 1 } }),
        ]}
        actionId="some-action"
        run={noopRun}
      />,
    );
    expect(html).toContain('disabled');
  });
});
