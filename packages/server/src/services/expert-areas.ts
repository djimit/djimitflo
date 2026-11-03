import type { Database } from 'better-sqlite3';
import { FrontierExpertRegistryService } from './frontier-expert-registry-service';

/**
 * FE-AREAS (operator 2026-10-06): Frontier Experts describe fields of interest, not people. One `area` unit per
 * taxonomy capability ('area:<capability>'), named by the taxonomy label, whose evidence is the paper and repository
 * units that carry that capability. Person identities are no longer created unless FRONTIER_EXPERT_PERSONS_ENABLED=true.
 */
export const frontierExpertPersonsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FRONTIER_EXPERT_PERSONS_ENABLED === 'true';
export const areaId = (capability: string): string => `area:${capability}`;
const ACTOR = 'autopilot:frontier-areas';

/** Idempotent: creates missing areas and links new unit evidence; an unchanged area gets no new version. */
export function syncAreas(db: Database): { areas: number; linked: number } {
  const registry = new FrontierExpertRegistryService(db);
  registry.seedTaxonomy();
  const taxonomy = db.prepare('SELECT id, label FROM expert_capability_taxonomy ORDER BY id').all() as Array<{ id: string; label: string }>;
  const insertArea = db.prepare(`INSERT OR IGNORE INTO expert_identities (id, canonical_name, aliases_json, lifecycle_state, identity_confidence, provenance_json, version, kind)
    VALUES (?, ?, ?, 'CAPABILITY_INFERRED', 1, ?, 1, 'area')`);
  const units = db.prepare(`SELECT e.id, e.canonical_name, e.kind, e.aliases_json FROM expert_capabilities c JOIN expert_identities e ON e.id = c.expert_id
    WHERE c.capability_id = ? AND c.status != 'revoked' AND e.kind IN ('paper', 'repository') ORDER BY e.id`);
  const current = db.prepare("SELECT evidence_refs_json FROM expert_capabilities WHERE expert_id = ? AND capability_id = ? AND status != 'revoked'");
  let areas = 0; let linked = 0;
  for (const cap of taxonomy) {
    const id = areaId(cap.id);
    areas += insertArea.run(id, cap.label, JSON.stringify([cap.id]), JSON.stringify({ source: 'taxonomy', capability: cap.id })).changes;
    const refs = (units.all(cap.id) as Array<{ id: string; canonical_name: string; kind: 'paper' | 'repository'; aliases_json: string }>).map((unit) => {
      const alias = (JSON.parse(unit.aliases_json || '[]') as string[])[0];
      return registry.addEvidence(id, { kind: unit.kind, title: unit.canonical_name, sourceRef: unit.id, canonicalOrigin: alias || unit.id, metadata: { unit_id: unit.id } });
    });
    if (!refs.length) continue;
    const before = (current.get(id, cap.id) as { evidence_refs_json: string } | undefined)?.evidence_refs_json;
    if (before === JSON.stringify([...new Set(refs)])) continue;
    registry.inferCapability(id, { capability: cap.id, confidence: 0.6, evidenceRefs: refs, derivedBy: ACTOR });
    linked += refs.length;
  }
  return { areas, linked };
}
