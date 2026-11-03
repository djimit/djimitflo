import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { FrontierExpertRegistryService } from '../services/frontier-expert-registry-service';
import { ExpertEvidenceEnrichmentService } from '../services/expert-evidence-enrichment-service';

it('E4: engineering papers map onto the new software-engineering capabilities', () => {
  const db = new Database(':memory:'); db.exec(schema); runMigrations(db);
  const registry = new FrontierExpertRegistryService(db); registry.seedTaxonomy();
  const deriver = new ExpertEvidenceEnrichmentService(db, { registry });
  const paper = (title: string, summary = '') => deriver.capabilitiesFor({ arxiv_id: 'x', url: '', title, summary, authors: [], categories: ['cs.SE'], primary_category: 'cs.SE', published: null });
  expect(paper('LLM-based mutation testing for unit test generation')).toEqual(expect.arrayContaining(['software_testing']));
  expect(paper('Automated program repair with agents', 'We evaluate on SWE-bench.')).toEqual(expect.arrayContaining(['program_repair']));
  expect(paper('Scaling laws for language models')).not.toContain('software_testing');
  db.close();
});
