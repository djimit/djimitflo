/**
 * SkillEvolutionEngine — genetic algorithm for skill improvement.
 *
 * Each skill has a "genome" with traits that evolve over generations:
 * - Efficiency (tokens per task)
 * - Reliability (success rate)
 * - Generality (domain breadth)
 * - Complexity (implementation complexity)
 * - Adaptability (learning rate)
 *
 * Evolution operations:
 * - Crossover: Combine traits from two parent skills
 * - Mutation: Random trait modification
 * - Selection: Keep top-N skills by fitness
 * - Reproduction: Create new skills from successful patterns
 *
 * DORMANT (fitness audit 2026-10-11, docs/research/eco/FITNESS_AUDIT.md): a SkillGenome has no executable genotype —
 * only the trait numbers — and prod holds 0 rows. Traits and fitness are therefore measured PHENOTYPE, computed from
 * the skill's recorded skill_outcomes only (null = INSUFFICIENT_EVIDENCE, never a default 0.5), and mutation refuses to
 * touch them: changing a number is not changing behaviour. fitness = measured reliability (success share).
 * generality/complexity/adaptability have no measurement and stay null. Retirement is for the W8 operator review (14-10).
 * recordOutcome() and the skill_outcomes table are live (bandit, gym, attribution) and unchanged.
 * tokens_used is nullable: null = the runtime reported no usage (unknown, never 0); efficiency averages known rows only.
 * A stored 0 is read as unknown too (L-F05, forensic audit 2026-10-26): legacy rows and producers that coalesce a missing
 * report to 0 would otherwise score maximal efficiency. efficiency_coverage reports known/total rows.
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';
import { UNFAIR_ZERO_SQL } from './runtime-bandit';
import { supersededMergeOutcomeSql } from './merge-superseded';

interface SkillGenome {
  id: string;
  skillId: string;
  generation: number;
  parents: string[];
  /** measured phenotype from skill_outcomes; null = no measurement */
  traits: {
    efficiency: number | null;    // mean min(1, 1000 / tokens) over outcomes
    reliability: number | null;   // success share over outcomes
    generality: number | null;    // no measurement → null
    complexity: number | null;    // no measurement → null
    adaptability: number | null;  // no measurement → null
    /** rows with known (> 0) tokens behind efficiency, of all measured outcomes */
    efficiency_coverage?: { known: number; total: number };
  };
  /** = traits.reliability; null = INSUFFICIENT_EVIDENCE */
  fitness: number | null;
  mutations: string[];
  createdAt: string;
}

/**
 * Evidence ref on a zero whose process completed but that no independent verification judged (execution engine). It is no
 * observation of the skill — neither a success nor a failure — so reliability leaves it out, as UNFAIR_ZERO_SQL does for infra.
 */
export const COMPLETED_UNVERIFIED_REF = 'outcome_class:completed_unverified';

/**
 * INT-004 follow-up: an outcome the engine tagged as unverified skill attribution (skill assigned, delivery not proven:
 * skill_delivery:assigned|unknown) is no observation of that skill. Per-skill fitness and promotion leave it out; the row
 * stays stored. Untagged rows (written before delivery receipts, or by lanes without them) are unaffected.
 */
export const UNVERIFIED_ATTRIBUTION_SQL = `(evidence_refs_json LIKE '%"skill_attribution:unverified"%'
  OR evidence_refs_json LIKE '%"skill_delivery:assigned"%' OR evidence_refs_json LIKE '%"skill_delivery:unknown"%')`;

function seededRandom(seed?: string): () => number {
  if (!seed) return Math.random;
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export class SkillEvolutionEngine {
  private random: () => number;

  constructor(private db: Database, random?: () => number) {
    this.random = random || seededRandom(process.env.SKILL_EVOLUTION_SEED);
    this.ensureTables();
  }

  /**
   * Register a new skill genome.
   */
  registerSkill(skillId: string, initialTraits?: Partial<SkillGenome['traits']>): SkillGenome {
    // declared traits are claims, not measurements: they are recorded as such and never enter fitness
    const declared = initialTraits && Object.keys(initialTraits).length ? [`declared traits ignored: ${JSON.stringify(initialTraits)}`] : [];
    const traits = this.measuredTraits(skillId);
    const genome: SkillGenome = {
      id: randomUUID(),
      skillId,
      generation: 1,
      parents: [],
      traits,
      fitness: traits.reliability,
      mutations: declared,
      createdAt: new Date().toISOString(),
    };
    this.persist(genome);
    return genome;
  }

  /**
   * Evolve the next generation of skills.
   */
  evolve(): SkillGenome[] {
    const currentGenomes = this.getCurrentGeneration();
    if (currentGenomes.length < 2) return currentGenomes;

    const nextGen: SkillGenome[] = [];

    // Keep top 50% (elitism)
    const sorted = [...currentGenomes].sort((a, b) => (b.fitness ?? -1) - (a.fitness ?? -1));
    const elite = sorted.slice(0, Math.ceil(sorted.length / 2));
    nextGen.push(...elite.map((genome) => ({
      ...genome,
      traits: this.measuredTraits(genome.skillId),
      fitness: this.measuredTraits(genome.skillId).reliability,
      id: randomUUID(),
      generation: genome.generation + 1,
      parents: [genome.id],
      mutations: [],
      createdAt: new Date().toISOString(),
    })));

    // Crossover: combine top performers
    for (let i = 0; i < elite.length - 1; i += 2) {
      const child = this.crossover(elite[i], elite[i + 1]);
      nextGen.push(child);
    }

    // Mutation: randomly modify some skills
    for (const genome of nextGen) {
      if (this.random() < 0.3) {
        this.mutate(genome);
      }
    }

    // Persist next generation
    for (const genome of nextGen) this.persist(genome);

    return nextGen;
  }

  /**
   * Record a skill execution outcome for learning.
   */
  recordOutcome(skillId: string, outcome: {
    success: boolean;
    /** null = not reported by the runtime (unknown), stored as NULL, never as 0 */
    tokensUsed: number | null;
    durationMs: number;
    domain: string;
    taskId?: string;
    agentId?: string;
    skillVersion?: string;
    skillContentHash?: string;
    model?: string;
    evidenceRefs?: string[];
  }): void {
    this.db.prepare(`
      INSERT INTO skill_outcomes (
        id, skill_id, success, tokens_used, duration_ms, domain,
        task_id, agent_id, skill_version, skill_content_hash, model, evidence_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      skillId,
      outcome.success ? 1 : 0,
      typeof outcome.tokensUsed === 'number' && Number.isFinite(outcome.tokensUsed) ? outcome.tokensUsed : null,
      outcome.durationMs,
      outcome.domain,
      outcome.taskId || null,
      outcome.agentId || null,
      outcome.skillVersion || null,
      outcome.skillContentHash || null,
      outcome.model || null,
      JSON.stringify(outcome.evidenceRefs || []),
      new Date().toISOString(),
    );

    // Update skill traits based on outcome
    this.updateTraits(skillId);
  }

  /**
   * Get evolution statistics.
   */
  getStats(): {
    totalGenomes: number;
    currentGeneration: number;
    avgFitness: number | null;
    topSkill: string | null;
    totalOutcomes: number;
  } {
    const genomes = this.db.prepare('SELECT * FROM skill_genomes').all() as any[];
    const outcomes = (this.db.prepare('SELECT COUNT(*) as c FROM skill_outcomes').get() as any)?.c || 0;

    const maxGen = genomes.reduce((max: number, g: any) => Math.max(max, g.generation), 0);
    // fitness is read from outcomes, never from the stored column; skills without outcomes are left out
    // per distinct skill: elitism copies a genome row, which must not shift the average
    const measured = [...new Set(genomes.map((g: any) => g.skill_id as string))].map((skill) => ({ skill, fitness: this.measuredTraits(skill).reliability }))
      .filter((g): g is { skill: string; fitness: number } => g.fitness !== null);
    const avgFitness = measured.length ? measured.reduce((sum, g) => sum + g.fitness, 0) / measured.length : null;
    const topSkill = measured.length ? measured.sort((a, b) => b.fitness - a.fitness)[0].skill : null;

    return {
      totalGenomes: genomes.length,
      currentGeneration: maxGen,
      avgFitness,
      topSkill,
      totalOutcomes: outcomes,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  /** Phenotype measured from this skill's recorded outcomes only. */
  measuredTraits(skillId: string): SkillGenome['traits'] {
    // E2: an infra / no-change / completed-unverified zero is no observation of the skill (left out, never a 0).
    // Unknown tokens (NULL, or a 0 that stands for a missing report) drop out of the efficiency AVG instead of scoring 1.
    // Unverified skill attribution is left out on both sides (a success is no more the skill's than a failure).
    const r = this.db.prepare(`SELECT COUNT(*) AS n, AVG(success) AS rel,
        AVG(CASE WHEN tokens_used > 0 THEN MIN(1.0, 1000.0 / tokens_used) END) AS eff, COALESCE(SUM(tokens_used > 0), 0) AS eff_n FROM skill_outcomes WHERE skill_id = ?
        AND NOT ${UNVERIFIED_ATTRIBUTION_SQL} AND NOT (success = 0 AND ${UNFAIR_ZERO_SQL}) AND NOT (success = 0 AND evidence_refs_json LIKE '%"${COMPLETED_UNVERIFIED_REF}"%')${skillId.includes('loop-maker:merge:') ? ` AND NOT ${supersededMergeOutcomeSql('skill_outcomes')}` : ''}`).get(skillId) as { n: number; rel: number | null; eff: number | null; eff_n: number };
    const has = r.n > 0;
    return { efficiency: has ? r.eff : null, reliability: has ? r.rel : null, generality: null, complexity: null, adaptability: null,
      efficiency_coverage: { known: r.eff_n, total: r.n } };
  }

  private persist(genome: SkillGenome): void {
    // ponytail: the legacy NOT NULL fitness column stores 0 for 'no measurement'; every read goes through measuredTraits()
    this.db.prepare(`
      INSERT INTO skill_genomes (id, skill_id, generation, parents_json, traits_json, fitness, mutations_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(genome.id, genome.skillId, genome.generation, JSON.stringify(genome.parents),
      JSON.stringify(genome.traits), genome.fitness ?? 0, JSON.stringify(genome.mutations), genome.createdAt);
  }

  private getCurrentGeneration(): SkillGenome[] {
    const maxGen = (this.db.prepare('SELECT MAX(generation) as max_gen FROM skill_genomes').get() as any)?.max_gen || 0;
    if (maxGen === 0) return [];

    return (this.db.prepare('SELECT * FROM skill_genomes WHERE generation = ?').all(maxGen) as any[]).map(parseGenome);
  }

  private crossover(parent1: SkillGenome, parent2: SkillGenome): SkillGenome {
    // a child is a new, unmeasured skill: it inherits lineage, not its parents' measured numbers
    const skillId = `${parent1.skillId}-x-${parent2.skillId}`;
    const traits = this.measuredTraits(skillId);
    return {
      id: randomUUID(),
      skillId,
      generation: parent1.generation + 1,
      parents: [parent1.id, parent2.id],
      traits,
      fitness: traits.reliability,
      mutations: [],
      createdAt: new Date().toISOString(),
    };
  }

  /** Refuses: traits are measured phenotype and a SkillGenome has no executable genotype to mutate. */
  mutate(genome: SkillGenome): void {
    genome.mutations.push('refused: traits are measured phenotype; no executable genotype to mutate (DORMANT)');
  }

  private updateTraits(skillId: string): void {
    const genomes = this.db.prepare('SELECT * FROM skill_genomes WHERE skill_id = ? ORDER BY generation DESC LIMIT 1').all(skillId) as any[];
    if (genomes.length === 0) return;

    // the outcome is already in skill_outcomes: the stored phenotype is re-measured from all of them
    const traits = this.measuredTraits(skillId);
    this.db.prepare('UPDATE skill_genomes SET traits_json = ?, fitness = ? WHERE id = ?')
      .run(JSON.stringify(traits), traits.reliability ?? 0, genomes[0].id);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_genomes (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        parents_json TEXT NOT NULL DEFAULT '[]',
        traits_json TEXT NOT NULL DEFAULT '{}',
        fitness REAL NOT NULL DEFAULT 0,
        mutations_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS skill_outcomes (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        domain TEXT NOT NULL DEFAULT '',
        task_id TEXT,
        agent_id TEXT,
        skill_version TEXT,
        skill_content_hash TEXT,
        model TEXT,
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    for (const [name, ddl] of [
      ['task_id', 'TEXT'],
      ['agent_id', 'TEXT'],
      ['skill_version', 'TEXT'],
      ['skill_content_hash', 'TEXT'],
      ['model', 'TEXT'],
      ['evidence_refs_json', "TEXT NOT NULL DEFAULT '[]'"],
    ] as const) {
      const exists = (this.db.prepare('PRAGMA table_info(skill_outcomes)').all() as Array<{ name: string }>)
        .some((column) => column.name === name);
      if (!exists) this.db.exec(`ALTER TABLE skill_outcomes ADD COLUMN ${name} ${ddl}`);
    }
    this.relaxTokensNotNull();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_genomes_skill_id ON skill_genomes(skill_id);
      CREATE INDEX IF NOT EXISTS idx_skill_genomes_generation ON skill_genomes(generation);
      CREATE INDEX IF NOT EXISTS idx_skill_outcomes_skill_id ON skill_outcomes(skill_id);
    `);
  }

  /**
   * One-time, idempotent widening of a skill_outcomes table created with `tokens_used INTEGER NOT NULL` so an unknown
   * count can be NULL. SQLite cannot drop NOT NULL in place (same pattern as migrate.ts rebuildLoopTables): the stored DDL
   * is copied with only that constraint removed (ALTER-added columns keep their order), every row is copied unchanged,
   * and the copy is checked before the old table is dropped. The index is recreated by the caller. A table whose DDL does
   * not match, or a failed rebuild (rolled back), is left as it was; existing writers that pass a number are unaffected.
   */
  private relaxTokensNotNull(): void {
    const tokens = (this.db.prepare('PRAGMA table_info(skill_outcomes)').all() as Array<{ name: string; notnull: number }>)
      .find((column) => column.name === 'tokens_used');
    if (!tokens?.notnull) return;
    const ddl = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'skill_outcomes'").get() as { sql: string } | undefined)?.sql ?? '';
    const relaxed = ddl.replace(/\btokens_used\s+INTEGER\s+NOT\s+NULL\b/i, 'tokens_used INTEGER');
    const copy = relaxed.replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?skill_outcomes["`]?(?=\s*\()/i, 'CREATE TABLE skill_outcomes_nullable_tokens');
    if (relaxed === ddl || copy === relaxed) return;
    try {
      this.db.transaction(() => {
        this.db.exec('DROP TABLE IF EXISTS skill_outcomes_nullable_tokens');
        this.db.exec(copy);
        this.db.exec('INSERT INTO skill_outcomes_nullable_tokens SELECT * FROM skill_outcomes');
        const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        if (count('skill_outcomes_nullable_tokens') !== count('skill_outcomes')) throw new Error('skill_outcomes copy row count mismatch');
        this.db.exec('DROP TABLE skill_outcomes');
        this.db.exec('ALTER TABLE skill_outcomes_nullable_tokens RENAME TO skill_outcomes');
      })();
    } catch (err) {
      console.warn('skill_outcomes: tokens_used NOT NULL not relaxed:', (err as Error)?.message || err);
    }
  }
}

function parseGenome(row: any): SkillGenome {
  return {
    id: row.id,
    skillId: row.skill_id,
    generation: row.generation,
    parents: JSON.parse(row.parents_json || '[]'),
    traits: JSON.parse(row.traits_json || '{}'),
    fitness: row.fitness,
    mutations: JSON.parse(row.mutations_json || '[]'),
    createdAt: row.created_at,
  };
}
