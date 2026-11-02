import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { SpecialistPanelService } from '../services/specialist-panel-service';
import { SelfImprovementService } from '../services/self-improvement-service';
import { SpecialistPanelBacklogScheduler } from '../services/specialist-panel-backlog-scheduler';
import { listSchedulers, noteScheduler, resetSchedulers } from '../services/scheduler-registry';

describe('SpecialistPanelBacklogScheduler', () => {
  let db: Database.Database;
  let panels: SpecialistPanelService;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    runMigrations(db);
    panels = new SpecialistPanelService(db);
    for (const key of ['SPECIALIST_PANEL_BACKLOG_ENABLED', 'SPECIALIST_PANEL_BACKLOG_INTERVAL_MINUTES']) {
      prevEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    db?.close();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function backlogReadyPanel() {
    const panel = panels.createPanel({
      topic: 'Add a dashboard filter',
      question: 'Should this be added to the backlog?',
      risk_class: 'medium',
      specialist_ids: ['systems_architect', 'runtime_engineer', 'skill_evaluator'],
    });
    // 2/3 support (>= ceil(3*0.66)=2), one uncertain -> decision: 'backlog'
    panels.submitReview(panel.id, { specialist_id: 'systems_architect', stance: 'support', confidence: 0.9, evidence_refs: ['x'] }, 'r1');
    panels.submitReview(panel.id, { specialist_id: 'runtime_engineer', stance: 'support', confidence: 0.9, evidence_refs: ['x'] }, 'r2');
    panels.submitReview(panel.id, { specialist_id: 'skill_evaluator', stance: 'uncertain', confidence: 0.5, evidence_refs: ['x'] }, 'r3');
    return panels.getPanel(panel.id);
  }

  it('does not arm when disabled (default off)', () => {
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    expect(scheduler.start()).toBe(false);
    scheduler.stop();
  });

  it('projects a consensus_ready general panel with a backlog decision into a work item', () => {
    const ready = backlogReadyPanel();
    expect(ready.status).toBe('consensus_ready');
    expect(ready.consensus.decision).toBe('backlog');
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    const result = scheduler.tick();
    expect(result.projected).toEqual([ready.id]);
    expect(panels.getPanel(ready.id).status).toBe('backlog_created');
    const workItem = db.prepare("SELECT id FROM work_items WHERE source = 'specialist_panel' AND source_ref = ?").get(ready.id);
    expect(workItem).toBeTruthy();
  });

  it('never touches a panel linked to a self-improvement proposal', () => {
    const improvement = new SelfImprovementService(db);
    const [proposal] = improvement.generateFromReflection({
      whatFailed: [], lessonsLearned: [], proposedImprovements: ['Improve the retry backoff'],
    });
    const panel = panels.getPanel(proposal.panelId!);
    panels.submitReview(panel.id, { specialist_id: panel.panel[0].id, stance: 'uncertain', confidence: 0.5, evidence_refs: ['x'] }, 'r1');
    panels.submitReview(panel.id, { specialist_id: panel.panel[1].id, stance: 'uncertain', confidence: 0.5, evidence_refs: ['x'] }, 'r2');
    const ready = panels.getPanel(panel.id);
    expect(ready.status).toBe('consensus_ready');
    expect(ready.consensus.decision).not.toBe('goal');

    const scheduler = new SpecialistPanelBacklogScheduler(db);
    const result = scheduler.tick();
    expect(result.projected).toEqual([]);
    expect(panels.getPanel(panel.id).status).toBe('consensus_ready');
  });

  it('never touches a panel linked to a memory candidate', () => {
    const panel = panels.createPanel({
      topic: 'Run summary', question: 'Should this be promoted to durable memory?',
      risk_class: 'low', specialist_ids: ['memory_scientist', 'security_reviewer'],
      metadata: { memory_candidate_id: 'candidate-1' },
    });
    panels.submitReview(panel.id, { specialist_id: 'memory_scientist', stance: 'uncertain', confidence: 0.5, evidence_refs: ['x'] }, 'r1');
    panels.submitReview(panel.id, { specialist_id: 'security_reviewer', stance: 'uncertain', confidence: 0.5, evidence_refs: ['x'] }, 'r2');
    const ready = panels.getPanel(panel.id);
    expect(ready.status).toBe('consensus_ready');
    expect(ready.consensus.decision).not.toBe('goal');

    const scheduler = new SpecialistPanelBacklogScheduler(db);
    const result = scheduler.tick();
    expect(result.projected).toEqual([]);
    expect(panels.getPanel(panel.id).status).toBe('consensus_ready');
  });

  it('does not touch a blocked panel', () => {
    const panel = panels.createPanel({
      topic: 'Risky change', question: 'Proceed?', risk_class: 'high',
      specialist_ids: ['systems_architect', 'security_reviewer'],
    });
    panels.submitReview(panel.id, { specialist_id: 'systems_architect', stance: 'support', confidence: 0.9, evidence_refs: ['x'] }, 'r1');
    panels.submitReview(panel.id, { specialist_id: 'security_reviewer', stance: 'oppose', confidence: 0.9, evidence_refs: ['x'] }, 'r2');
    const blocked = panels.getPanel(panel.id);
    expect(blocked.consensus.decision).toBe('blocked');

    const scheduler = new SpecialistPanelBacklogScheduler(db);
    const result = scheduler.tick();
    expect(result.projected).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('arms and does a catch-up tick when enabled, projecting ready panels', () => {
    const ready = backlogReadyPanel();
    process.env.SPECIALIST_PANEL_BACKLOG_ENABLED = 'true';
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    expect(scheduler.start()).toBe(true);
    expect(panels.getPanel(ready.id).status).toBe('backlog_created');
    scheduler.stop();
  });

  it('re-arms after stop', () => {
    process.env.SPECIALIST_PANEL_BACKLOG_ENABLED = 'true';
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    expect(scheduler.start()).toBe(true);
    scheduler.stop();
    expect(scheduler.start()).toBe(true);
    scheduler.stop();
  });

  it('skips panels that are still in review (not consensus_ready)', () => {
    const panel = panels.createPanel({
      topic: 'Pending', question: 'Still in review?',
      risk_class: 'low', specialist_ids: ['systems_architect', 'runtime_engineer'],
    });
    panels.submitReview(panel.id, { specialist_id: 'systems_architect', stance: 'support', confidence: 0.9, evidence_refs: ['x'] }, 'r1');
    const pending = panels.getPanel(panel.id);
    expect(pending.status).toBe('reviewing');
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    const result = scheduler.tick();
    expect(result.projected).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('records failed projections with the error message', () => {
    const ready = backlogReadyPanel();
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    (scheduler as { panels: { projectPanelToBacklog: () => never } }).panels.projectPanelToBacklog = () => { throw new Error('boom'); };
    const result = scheduler.tick();
    expect(result.projected).toEqual([]);
    expect(result.failed).toEqual([{ id: ready.id, error: 'boom' }]);
  });

  it('stringifies non-Error throws in failed projections', () => {
    const ready = backlogReadyPanel();
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    (scheduler as { panels: { projectPanelToBacklog: () => never } }).panels.projectPanelToBacklog = () => { throw 'string-error'; };
    const result = scheduler.tick();
    expect(result.projected).toEqual([]);
    expect(result.failed).toEqual([{ id: ready.id, error: 'string-error' }]);
  });

  it('records its tick in the scheduler registry via markRun', () => {
    resetSchedulers();
    noteScheduler('specialist_panel_backlog', 'SPECIALIST_PANEL_BACKLOG_ENABLED', true, 15 * 60_000);
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    scheduler.tick();
    const info = listSchedulers().schedulers.find((s) => s.name === 'specialist_panel_backlog');
    expect(info?.last_run).not.toBeNull();
    resetSchedulers();
  });

  it('uses a custom interval in minutes', () => {
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    process.env.SPECIALIST_PANEL_BACKLOG_INTERVAL_MINUTES = '7';
    expect(scheduler.intervalMinutes()).toBe(7);
  });

  it('defaults to a 15-minute interval when the env var is unset', () => {
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    expect(scheduler.intervalMinutes()).toBe(15);
  });

  it('falls back to 15 minutes for a zero interval', () => {
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    process.env.SPECIALIST_PANEL_BACKLOG_INTERVAL_MINUTES = '0';
    expect(scheduler.intervalMinutes()).toBe(15);
  });

  it('falls back to a 15-minute interval for invalid configuration', () => {
    const scheduler = new SpecialistPanelBacklogScheduler(db);
    process.env.SPECIALIST_PANEL_BACKLOG_INTERVAL_MINUTES = 'not-a-number';
    expect(scheduler.intervalMinutes()).toBe(15);
    process.env.SPECIALIST_PANEL_BACKLOG_INTERVAL_MINUTES = '-5';
    expect(scheduler.intervalMinutes()).toBe(15);
  });
});
