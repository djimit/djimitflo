import { createHash } from 'node:crypto';
import { toList, firstParagraph, type ParsedAgent } from './parser';
import type { Profile } from './db';

function firstNonEmpty(...vals: any[]): string {
  for (const v of vals) if (v && String(v).trim()) return String(v).trim();
  return '';
}
function listOrSplit(val: any, text?: string): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (text) return toList(text);
  return [];
}
function divisionFromPath(sourcePath: string): string {
  const parts = String(sourcePath || '').split('/').filter(Boolean);
  return parts[0] || 'unknown';
}
function slug(s: string): string {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function hashProfile(profile: Profile): string {
  const stable = JSON.stringify(profile, Object.keys(profile).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

export function normalizeAgent(parsed: ParsedAgent): Profile {
  const { frontmatter: fm, sections: s, preamble, sourceRepo, sourcePath } = parsed;
  const name = firstNonEmpty(fm.name, fm.title);
  const division = firstNonEmpty(fm.division, divisionFromPath(sourcePath));
  const id = slug(`${division}/${name}`) || `agent/${Math.random().toString(36).slice(2, 8)}`;
  const persona = firstNonEmpty(fm.vibe && `${fm.vibe}`, preamble && firstParagraph(preamble), s.memory_policy && firstParagraph(s.memory_policy), fm.description);

  const profile: Profile = {
    id, name, division,
    description: firstNonEmpty(fm.description, ''),
    source_repo: sourceRepo || '', source_path: sourcePath || '',
    version_hash: '',
    persona,
    mission: firstNonEmpty(s.mission && firstParagraph(s.mission), fm.description, ''),
    rules: listOrSplit(fm.rules, s.rules),
    workflows: listOrSplit(fm.workflows, s.workflows),
    deliverables: listOrSplit(fm.deliverables, s.deliverables),
    success_metrics: listOrSplit(fm.success_metrics, s.success_metrics),
    memory_policy: firstNonEmpty(s.memory_policy && firstParagraph(s.memory_policy), ''),
    tools_required: listOrSplit(fm.tools_required, s.tools_required),
    runtime_targets: Array.isArray(fm.runtime_targets) ? fm.runtime_targets.map(String) : [],
    risk_profile: { level: 'low', injection_score: 0, overlap_score: 0, flags: [] },
    evaluation_status: 'pending', activation_status: 'draft',
  };
  profile.version_hash = hashProfile(profile);
  return profile;
}
