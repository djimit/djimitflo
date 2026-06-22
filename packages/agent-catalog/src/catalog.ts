import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseAgentMarkdown } from './parser';
import { normalizeAgent } from './normalize';
import { runStaticGate } from './static-gate';
import { CatalogDB, type Profile } from './db';
import { ActivationRegistry } from './registry';

export interface ImportResult { profile: Profile; evaluation: any }

export class AgentCatalog {
  db: CatalogDB;
  registry: ActivationRegistry;
  constructor(dbPath = ':memory:') { this.db = new CatalogDB(dbPath); this.registry = new ActivationRegistry(this.db); }
  close() { this.db.close(); }

  importText(text: string, opts: { sourceRepo: string; sourcePath: string }): ImportResult {
    const parsed = parseAgentMarkdown(text, opts);
    const profile = normalizeAgent(parsed);
    const existing = this.db.listProfiles();
    this.db.upsertProfile(profile);
    const evaluation = runStaticGate(profile, existing);
    this.db.setEvaluation(evaluation, profile.version_hash);
    profile.risk_profile = { level: evaluation.risk_level, injection_score: evaluation.injection_score, overlap_score: evaluation.overlap_score, flags: evaluation.flags };
    profile.evaluation_status = evaluation.status;
    profile.activation_status = 'draft';
    this.db.upsertProfile(profile);
    for (const o of evaluation.overlaps) this.db.setOverlap(profile.id, o.id, o.score);
    this.db.audit(profile.id, 'import', JSON.stringify({ sourcePath: opts.sourcePath, status: evaluation.status }));
    return { profile, evaluation };
  }

  importDir(dir: string, sourceRepo: string): ImportResult[] {
    const results: ImportResult[] = [];
    for (const f of readdirSync(dir)) {
      if (!/\.md$/i.test(f)) continue;
      results.push(this.importText(readFileSync(join(dir, f), 'utf8'), { sourceRepo, sourcePath: f }));
    }
    return results;
  }

  importTree(dir: string, sourceRepo: string, rootDir?: string): ImportResult[] {
    const root = rootDir || dir;
    const NON_DIV = new Set(['examples', 'strategy', 'integrations', 'scripts', '.github', 'node_modules', '.git']);
    const SKIP = /^(readme|contributing|security|license|changelog)/i;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        if (name === '.git' || name === 'node_modules') continue;
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) { if (NON_DIV.has(name)) continue; walk(p); }
        else if (/\.md$/i.test(name) && !SKIP.test(name)) files.push(p);
      }
    };
    walk(dir);
    const results: ImportResult[] = [];
    for (const abs of files) {
      const rel = relative(root, abs);
      try { results.push(this.importText(readFileSync(abs, 'utf8'), { sourceRepo, sourcePath: rel })); }
      catch (e) { results.push({ profile: { id: rel, name: rel, division: rel.split('/')[0] } as any, evaluation: { status: 'error', flags: [String((e as Error).message)] } }); }
    }
    return results;
  }

  counts() { return this.db.counts(); }
  search(query: string, topK = 20): Profile[] {
    const q = String(query || '').toLowerCase();
    return this.db.listProfiles().filter(p => JSON.stringify(p).toLowerCase().includes(q)).slice(0, topK);
  }
  list(filter?: { division?: string; status?: string }): Profile[] {
    let list = this.db.listProfiles();
    if (filter?.division) list = list.filter(p => p.division === filter.division);
    if (filter?.status) list = list.filter(p => p.evaluation_status === filter.status);
    return list;
  }
}
