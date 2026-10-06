import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TabbedPage } from './components/TabbedPage';

const tabs = [
  { id: 'logs', label: 'Logs', element: <p>logs body</p> },
  { id: 'trace', label: 'Trace', element: <p>trace body</p> },
  { id: 'chain', label: 'Chain', element: <p>chain body</p> },
];
const renderTabs = () => render(<MemoryRouter initialEntries={['/audit']}><TabbedPage tabs={tabs} /></MemoryRouter>);

it('UX-25b: tabs are wired to their panel (aria-controls ↔ id, aria-labelledby) with a roving tabindex', () => {
  renderTabs();
  const [logs, trace] = screen.getAllByRole('tab');
  const panel = screen.getByRole('tabpanel');
  expect(logs.getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.getAttribute('aria-labelledby')).toBe(logs.id);
  expect(panel.textContent).toBe('logs body');
  expect(logs.getAttribute('tabindex')).toBe('0');
  expect(trace.getAttribute('tabindex')).toBe('-1');
});

it('UX-25b: Left/Right/Home/End move selection and focus between tabs (wrapping)', () => {
  renderTabs();
  const tab = (name: string) => screen.getByRole('tab', { name });
  tab('Logs').focus();
  fireEvent.keyDown(tab('Logs'), { key: 'ArrowRight' });
  expect(tab('Trace').getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(tab('Trace'));
  expect(screen.getByRole('tabpanel').textContent).toBe('trace body');
  fireEvent.keyDown(tab('Trace'), { key: 'End' });
  expect(document.activeElement).toBe(tab('Chain'));
  fireEvent.keyDown(tab('Chain'), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(tab('Logs')); // wraps
  fireEvent.keyDown(tab('Logs'), { key: 'ArrowLeft' });
  expect(document.activeElement).toBe(tab('Chain'));
  fireEvent.keyDown(tab('Chain'), { key: 'Home' });
  expect(document.activeElement).toBe(tab('Logs'));
  expect(tab('Logs').getAttribute('aria-selected')).toBe('true');
});

const css = readFileSync(join(__dirname, 'styles/index.css'), 'utf8');
const rgbVar = (name: string): [number, number, number] => {
  const m = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(css);
  if (!m) throw new Error(`token ${name} not found`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
/** WCAG 2.x relative luminance and contrast ratio. */
const luminance = (rgb: [number, number, number]) => {
  const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

it('UX-25b: muted text meets WCAG AA (≥ 4.5:1) on every background token', () => {
  expect(contrast([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5); // helper sanity
  const muted = rgbVar('djimit-text-muted');
  for (const bg of ['djimit-bg-primary', 'djimit-bg-secondary', 'djimit-bg-tertiary', 'djimit-bg-elevated']) {
    expect(contrast(muted, rgbVar(bg)), bg).toBeGreaterThanOrEqual(4.5);
  }
});

it('UX-25b: a global focus-visible ring exists', () => {
  expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/);
});

const sources = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
});

it('UX-25b: no window.prompt / window.confirm left in the dashboard source', () => {
  const offenders = sources(__dirname).filter((p) => /window\.(prompt|confirm)\(/.test(readFileSync(p, 'utf8')));
  expect(offenders).toEqual([]);
});

it('UX-25b: muted/tertiary content text is never smaller than 12 px', () => {
  const offenders = sources(__dirname).flatMap((p) => readFileSync(p, 'utf8').split('\n')
    .filter((line) => /text-\[10px\]/.test(line) && /(muted|tertiary|slate-500)/.test(line))
    .map((line) => `${p.split('/src/')[1]}: ${line.trim().slice(0, 80)}`));
  expect(offenders).toEqual([]);
});
