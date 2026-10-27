import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ExecutionEvent } from '@djimitflo/shared';
import { api, type ImprovementFunnel } from '../lib/api';
import { useStore } from '../lib/store';
import { ImprovementFunnelPage } from './ImprovementFunnelPage';
import { TaskDetailPage } from './TaskDetailPage';
import { AgentsPage } from './AgentsPage';
import { SwarmOverviewPage } from './SwarmOverviewPage';
import { ExecutionTimeline } from '../components/ExecutionTimeline';
import { Layout } from '../components/Layout';

/** Forensic audit 2026-10-26 UX-002…UX-007: numbers keep their denominator/window, unknown stays unknown, journeys stay reachable. */

const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn(() => () => {}) }));
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe, isConnected: true }) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useStore.setState({ agents: [], tasks: [] }); });

const funnel: ImprovementFunnel = {
  generatedAt: '2026-10-26T00:00:00Z',
  proposals: { total: 3, byStatus: { verified: 3 } },
  bySource: [],
  panel: { decisions: {}, goalRate: null, linkedPanels: 0, linkedDecided: 0, linkedDecisions: {} },
  refinement: { originals: 0, children: 0, childOutcomes: {}, childGoals: { reachedGoal: 0, completed: 0, failed: 0, other: 0 } },
  goals: { fromSelfImprovement: {} },
  learning: { cognitiveEpisodes: null, cognitivePatterns: 0, cognitiveStrategies: 0, learningClosures: 0, memoryCandidates: {} },
  kpi: { windowDays: 7, verified: 2, regressed: 0, regressionRate: 0, panels24h: 0, panels7d: 0, reviews24h: 0, reviews7d: 0, panelsPerVerified: null,
    medianHoursToVerified: 121, medianHoursWindowDays: 30, medianHoursN: 2, approvalsPerRun: null },
  hygiene: { zombieGoals: 0, staleRuns: null, blockedBoardItems: 0 },
  queues: { openWorkItems: 13, workItemGroups: 13, workItemsByLoopLimit: 12,
    workItemsByLoop: Array.from({ length: 12 }, (_, n) => ({ loop: `loop-${n}`, status: 'candidate', n: 1 })), commonsReviews: {} },
  unavailable: { staleRuns: 'query_failed: database is locked', cognitiveEpisodes: 'missing_schema: no such table: cognitive_episodes' },
};

describe('UX-002/003/004 improvement funnel', () => {
  const open = () => {
    vi.spyOn(api, 'getImprovementFunnel').mockResolvedValue(funnel);
    vi.spyOn(api, 'getPanelCalibration').mockResolvedValue({ specialists: [] });
    render(<ImprovementFunnelPage />);
  };

  it('UX-002: shows the full open-work total before the truncated top-N breakdown', async () => {
    open();
    const heading = await screen.findByRole('heading', { name: /Open work items/ });
    expect(heading.textContent).toContain('13');
    const section = heading.parentElement!;
    expect(section.textContent).toContain('largest 12 of 13 loop/status groups');
    expect(section.textContent).toContain('1 item in groups not listed');
  });

  it('UX-003: the latency median is labelled with its own window, cohort size and non-first-verification basis', async () => {
    open();
    const label = await screen.findByText('Median hours created → last update');
    const stat = label.parentElement!;
    expect(stat.textContent).toContain('121');
    expect(stat.textContent).toMatch(/currently verified\/evaluating\/applied · updated in last 30 d · n=2/);
    expect(stat.textContent).toMatch(/not first-verification latency/);
    expect(screen.queryByText('Median hours to verified')).toBeNull();
  });

  it('UX-004: an unavailable read shows unknown with its reason, a measured zero stays 0', async () => {
    open();
    const stale = (await screen.findByText('Stale runs')).parentElement!;
    expect(within(stale).getByText('unknown')).toBeTruthy();
    expect(stale.textContent).toContain('query_failed: database is locked');
    const zombies = screen.getByText('Zombie goals').parentElement!;
    expect(within(zombies).getByText('0')).toBeTruthy();
    const episodes = screen.getByText('Cognitive episodes').parentElement!;
    expect(within(episodes).getByText('unknown')).toBeTruthy();
  });
});

describe('UX-005 execution evidence journey', () => {
  const event = (patch: Partial<ExecutionEvent> = {}): ExecutionEvent => ({
    id: 'e1', task_id: 't1', event_type: 'tool.completed', level: 'info', message: 'wrote file', timestamp: new Date().toISOString(),
    tool_name: null, tool_input: null, tool_output: null, tool_error: null, artifact_id: 'artifact-1', metadata: {}, ...patch,
  } as ExecutionEvent);

  it('does not advertise an inert "View Artifact" action; names the artifact and why it cannot be opened here', () => {
    render(<ExecutionTimeline events={[event()]} />);
    expect(screen.queryByText('View Artifact')).toBeNull();
    const note = screen.getByText(/artifact-1/);
    expect(note.closest('[class*="cursor-pointer"]')).toBeNull();
    expect(note.parentElement!.textContent).toMatch(/no retrieval endpoint/i);
  });

  const taskStub = (opts: { task?: unknown; events?: 'fail' | unknown[]; taskFails?: boolean }) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    let data: unknown;
    if (url.endsWith('/loops/runtime-contracts')) data = { runtimes: {} };
    else if (url.endsWith('/tasks/t1')) { if (opts.taskFails) return { ok: false, status: 503, json: async () => ({ error: 'db busy' }) }; data = opts.task; }
    else if (url.endsWith('/events')) { if (opts.events === 'fail') return { ok: false, status: 500, json: async () => ({ error: 'events down' }) }; data = { events: opts.events ?? [] }; }
    else if (url.endsWith('/approvals')) data = { approvals: [] };
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, status: 200, json: async () => data };
  }));
  const task = { id: 't1', title: 'Loop maker task', description: 'd', status: 'completed', priority: 'medium', risk_level: 'low', execution_mode: 'review_only', tags: [], metadata: { loop_run_id: 'run-42' } };
  const openTask = () => render(<MemoryRouter initialEntries={['/tasks/t1']}><Routes><Route path="/tasks/:taskId" element={<TaskDetailPage />} /></Routes></MemoryRouter>);

  it('links a loop task to its run and the run review evidence', async () => {
    taskStub({ task });
    openTask();
    const link = await screen.findByRole('link', { name: /run-42/ });
    expect(link.getAttribute('href')).toBe('/goals-loops?run=run-42');
  });

  it('a failed timeline read is reported, not shown as "No execution events yet"', async () => {
    taskStub({ task, events: 'fail' });
    openTask();
    await screen.findByText('Loop maker task');
    expect(await screen.findByText(/Execution events could not be loaded/)).toBeTruthy();
    expect(screen.queryByText('No execution events yet')).toBeNull();
  });

  it('a failed task read is an error, not "Task Not Found"', async () => {
    taskStub({ taskFails: true });
    openTask();
    expect(await screen.findByText(/Could not load task/)).toBeTruthy();
    expect(screen.queryByText('Task Not Found')).toBeNull();
  });
});

describe('UX-007 loading, keyboard and mobile navigation', () => {
  it('AgentsPage: a pending inventory read is loading, a failed one is not "No agents configured"', async () => {
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'getAgents').mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    render(<MemoryRouter><AgentsPage /></MemoryRouter>);
    expect(screen.getByText(/Loading agents/)).toBeTruthy();
    expect(screen.queryByText('No agents configured')).toBeNull();
    fail(new Error('agents 503'));
    expect(await screen.findByText(/agents 503/)).toBeTruthy();
    expect(screen.queryByText('No agents configured')).toBeNull();
    expect(screen.getByText(/Agent inventory unavailable/)).toBeTruthy();
  });

  it('AgentsPage: a successful empty read is a confirmed empty inventory', async () => {
    vi.spyOn(api, 'getAgents').mockResolvedValue({ agents: [] } as never);
    render(<MemoryRouter><AgentsPage /></MemoryRouter>);
    expect(await screen.findByText('No agents configured')).toBeTruthy();
  });

  it('SwarmOverviewPage: an agent card is a native link (keyboard, new tab)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = url.startsWith('/api/agents') ? { agents: [{ id: 'a1', name: 'Live one', status: 'active', liveness: 'live', total_tasks: 0, capabilities: [] }] }
        : url.startsWith('/api/tasks') ? { tasks: [] } : url.startsWith('/api/discussions') ? { discussions: [] } : url.startsWith('/api/learning') ? { learnings: [] } : {};
      return { ok: true, status: 200, json: async () => body };
    }));
    useStore.setState({ agents: [{ id: 'a1', name: 'Live one', status: 'active', liveness: 'live', total_tasks: 0, capabilities: [] }] as never });
    render(<MemoryRouter><SwarmOverviewPage /></MemoryRouter>);
    const card = await screen.findByRole('link', { name: /Live one/ });
    expect(card.getAttribute('href')).toBe('/agents/a1');
  });

  it('Layout: the closed mobile drawer is hidden from focus below md, Escape closes it and restores focus', async () => {
    vi.spyOn(api, 'getAllApprovals').mockResolvedValue({ approvals: [] });
    vi.spyOn(api, 'getAuthorityStats').mockRejectedValue(new Error('x'));
    vi.spyOn(api, 'request').mockResolvedValue(undefined as never);
    render(<MemoryRouter initialEntries={['/tasks']}><Layout /></MemoryRouter>);
    const aside = document.querySelector('aside')!;
    expect(aside.className).toMatch(/(^|\s)invisible(\s|$)/); // visibility:hidden drops it from tab order and the a11y tree
    expect(aside.className).toContain('md:visible'); // desktop sidebar unaffected
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    opener.focus();
    fireEvent.click(opener);
    expect(aside.className).not.toMatch(/(^|\s)invisible(\s|$)/);
    await waitFor(() => expect(aside.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(aside.className).toMatch(/(^|\s)invisible(\s|$)/);
    expect(document.activeElement).toBe(opener);
  });
});
