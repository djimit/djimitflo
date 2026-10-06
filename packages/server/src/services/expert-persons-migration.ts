import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { FrontierExpertRegistryService, CAPABILITY_EVIDENCE_KINDS, type EvidenceKind } from './frontier-expert-registry-service';
import { areaId, syncAreas } from './expert-areas';

/**
 * FE-AREAS migration (operator 2026-10-06): turn person identities into fields of interest and remove the people,
 * including their history. Evidence that points at a public work (arXiv, DOI, GitHub) moves to the area(s) of the
 * person's capabilities without author metadata; everything else about the person (affiliations, signatures,
 * profiles, versions, lifecycle events, claims) is deleted. One transaction; dry-run rolls back after reporting.
 * Names are only held in memory for the final check and are never printed.
 */
const PERSON_TABLES = ['expert_affiliations', 'expert_capabilities', 'expert_claims', 'expert_versions', 'expert_lifecycle_events', 'expert_evidence'] as const;
const PUBLIC_WORK = /(arxiv\.org|arxiv:|doi\.org|doi:|10\.\d{4,9}\/|github\.com\/)/i;
const MOVABLE_KINDS: EvidenceKind[] = ['paper', 'repository', 'technical_report', 'presentation'];
const MIN_NAME = 5;

export interface MigrationReport {
  persons: number; before: Record<string, number>; after: Record<string, number>; moved_evidence: number; dropped_evidence: number;
  areas_touched: number; scrubbed_rows: number; check: { persons_left: number; dangling_refs: number; name_hits: Array<{ table: string; column: string; rows: number }> };
}

function counts(db: Db): Record<string, number> {
  const out: Record<string, number> = { persons: (db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE COALESCE(kind, 'person') = 'person'").get() as { n: number }).n };
  for (const t of [...PERSON_TABLES, 'expert_identities', 'expert_claim_relations']) out[t] = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** JSON text with every `authors` array replaced by `author_count`; non-JSON text unchanged. */
function stripAuthors(text: string): string {
  if (!/"authors"\s*:/.test(text)) return text;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return text; }
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(v as Record<string, unknown>)) {
      if (key === 'authors' && Array.isArray(item)) out.author_count = item.length; else out[key] = walk(item);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

function scrubJson(text: string, names: RegExp | null): string {
  if (!names) return text;
  return text.replace(names, 'redacted');
}

/** Text columns of every expert_* table: where any deleted person's name still appears (counts only). */
function nameHits(db: Db, names: RegExp | null): Array<{ table: string; column: string; rows: number }> {
  if (!names) return [];
  const hits: Array<{ table: string; column: string; rows: number }> = [];
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'expert_%'").all() as Array<{ name: string }>).map((r) => r.name);
  for (const table of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>).filter((c) => /TEXT|^$/i.test(c.type)).map((c) => c.name);
    for (const column of cols) {
      let rows = 0;
      for (const row of db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).iterate() as Iterable<{ v: unknown }>) {
        names.lastIndex = 0;
        if (typeof row.v === 'string' && names.test(row.v)) rows += 1;
      }
      if (rows) hits.push({ table, column, rows });
    }
  }
  return hits;
}

export function migratePersonsToAreas(db: Db, options: { apply?: boolean } = {}): MigrationReport {
  const before = counts(db);
  let report!: MigrationReport;
  const rollback = new Error('DRY_RUN_ROLLBACK');
  try {
    db.transaction(() => {
      syncAreas(db);
      const registry = new FrontierExpertRegistryService(db);
      const persons = db.prepare("SELECT id, canonical_name, aliases_json FROM expert_identities WHERE COALESCE(kind, 'person') = 'person'").all() as Array<{ id: string; canonical_name: string; aliases_json: string }>;
      const ids = new Set(persons.map((p) => p.id));
      const nameList = [...new Set(persons.flatMap((p) => [p.canonical_name, ...(JSON.parse(p.aliases_json || '[]') as string[])]).map((n) => String(n).trim()).filter((n) => n.length >= MIN_NAME && /\s/.test(n)))];
      const names = nameList.length ? new RegExp(nameList.sort((a, b) => b.length - a.length).map(escape).join('|'), 'g') : null;
      const capsOf = db.prepare("SELECT capability_id FROM expert_capabilities WHERE expert_id = ? AND status != 'revoked'");
      const evidenceOf = db.prepare('SELECT id, kind, title, url, source_ref, canonical_origin FROM expert_evidence WHERE expert_id = ?');
      let moved = 0; let dropped = 0; const touched = new Set<string>();
      for (const person of persons) {
        const areas = (capsOf.all(person.id) as Array<{ capability_id: string }>).map((c) => areaId(c.capability_id));
        for (const ev of evidenceOf.all(person.id) as Array<{ id: string; kind: EvidenceKind; title: string; url: string | null; source_ref: string; canonical_origin: string }>) {
          const origin = `${ev.canonical_origin} ${ev.url ?? ''} ${ev.source_ref}`;
          if (!areas.length || !MOVABLE_KINDS.includes(ev.kind) || !PUBLIC_WORK.test(origin)) { dropped += 1; continue; }
          for (const area of areas) {
            if (!db.prepare('SELECT 1 FROM expert_identities WHERE id = ?').get(area)) continue;
            registry.addEvidence(area, { kind: ev.kind, title: scrubJson(ev.title, names), url: ev.url, sourceRef: ev.canonical_origin, canonicalOrigin: ev.canonical_origin, metadata: {} });
            touched.add(area);
          }
          moved += 1;
        }
      }
      // areas carry every qualifying piece of evidence they now hold
      for (const area of touched) {
        const refs = (db.prepare(`SELECT id FROM expert_evidence WHERE expert_id = ? AND lifecycle = 'active' AND kind IN (SELECT value FROM json_each(?)) ORDER BY id`).all(area, JSON.stringify(CAPABILITY_EVIDENCE_KINDS)) as Array<{ id: string }>).map((r) => r.id);
        if (refs.length) registry.inferCapability(area, { capability: area.slice('area:'.length), confidence: 0.6, evidenceRefs: refs, derivedBy: 'migration:fe-persons-to-areas' });
      }
      const idJson = JSON.stringify([...ids]);
      db.prepare(`DELETE FROM expert_claim_relations WHERE from_claim_id IN (SELECT id FROM expert_claims WHERE expert_id IN (SELECT value FROM json_each(?)))
        OR to_claim_id IN (SELECT id FROM expert_claims WHERE expert_id IN (SELECT value FROM json_each(?)))`).run(idJson, idJson);
      for (const table of PERSON_TABLES) db.prepare(`DELETE FROM ${table} WHERE expert_id IN (SELECT value FROM json_each(?))`).run(idJson);
      db.prepare('DELETE FROM expert_identities WHERE id IN (SELECT value FROM json_each(?))').run(idJson);
      // History outside the per-person tables keeps its counts and loses every name: author lists become counts, and any
      // name of a deleted person left in a text column of an expert table is redacted.
      const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
      let scrubbed = 0;
      for (const table of [...present].filter((t) => t.startsWith('expert_'))) {
        const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; pk: number }>)
          .filter((c) => /TEXT|^$/i.test(c.type) && !c.pk && !/(^|_)id$/.test(c.name)).map((c) => c.name);
        for (const column of cols) {
          const rows = db.prepare(`SELECT rowid AS rid, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`).all() as Array<{ rid: number; v: unknown }>;
          for (const row of rows) {
            if (typeof row.v !== 'string') continue;
            const next = scrubJson(stripAuthors(row.v), names);
            if (next !== row.v) { db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(next, row.rid); scrubbed += 1; }
          }
        }
      }
      const dangling = PERSON_TABLES.reduce((sum, table) => sum + (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE expert_id IN (SELECT value FROM json_each(?))`).get(idJson) as { n: number }).n, 0);
      const check = { persons_left: (db.prepare("SELECT COUNT(*) n FROM expert_identities WHERE COALESCE(kind, 'person') = 'person'").get() as { n: number }).n, dangling_refs: dangling, name_hits: nameHits(db, names) };
      report = { persons: persons.length, before, after: counts(db), moved_evidence: moved, dropped_evidence: dropped, areas_touched: touched.size, scrubbed_rows: scrubbed, check };
      if (check.persons_left || check.dangling_refs || check.name_hits.length) throw Object.assign(new Error('FE_AREAS_CHECK_FAILED'), { report });
      if (!options.apply) throw rollback;
    })();
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return report;
}

/** --apply path: a verified SQLite backup first, then the migration. */
export async function applyWithBackup(db: Db, backupPath: string | undefined): Promise<MigrationReport> {
  if (!backupPath) throw new Error('FE_AREAS_BACKUP_REQUIRED');
  await db.backup(backupPath);
  const copy = new Database(backupPath, { readonly: true });
  try { copy.prepare('SELECT COUNT(*) n FROM expert_identities').get(); } finally { copy.close(); }
  return migratePersonsToAreas(db, { apply: true });
}
