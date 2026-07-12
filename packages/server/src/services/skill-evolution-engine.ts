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
 */

import { createHash, randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

interface SkillGenome {
  id: string;
  skillId: string;
  generation: number;
  parents: string[];
  traits: {
    efficiency: number;    // 0-1, higher = fewer tokens per task
    reliability: number;   // 0-1, higher = more successful
    generality: number;    // 0-1, higher = works in more domains
    complexity: number;    // 0-1, lower = simpler implementation
    adaptability: number;  // 0-1, higher = learns faster
  };
  fitness: number;
  mutations: string[];
  createdAt: string;
}

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
    const genome: SkillGenome = {
      id: randomUUID(),
      skillId,
      generation: 1,
      parents: [],
      traits: {
        efficiency: initialTraits?.efficiency ?? 0.5,
        reliability: initialTraits?.reliability ?? 0.5,
        generality: initialTraits?.generality ?? 0.5,
        complexity: initialTraits?.complexity ?? 0.5,
        adaptability: initialTraits?.adaptability ?? 0.5,
      },
      fitness: 0,
      mutations: [],
      createdAt: new Date().toISOString(),
    };

    genome.fitness = this.calculateFitness(genome.traits);

    this.db.prepare(`
      INSERT INTO skill_genomes (id, skill_id, generation, parents_json, traits_json, fitness, mutations_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(genome.id, genome.skillId, genome.generation, JSON.stringify(genome.parents),
      JSON.stringify(genome.traits), genome.fitness, JSON.stringify(genome.mutations), genome.createdAt);

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
    const sorted = [...currentGenomes].sort((a, b) => b.fitness - a.fitness);
    const elite = sorted.slice(0, Math.ceil(sorted.length / 2));
    nextGen.push(...elite.map((genome) => ({
      ...genome,
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
    for (const genome of nextGen) {
      this.db.prepare(`
        INSERT INTO skill_genomes (id, skill_id, generation, parents_json, traits_json, fitness, mutations_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(genome.id, genome.skillId, genome.generation, JSON.stringify(genome.parents),
        JSON.stringify(genome.traits), genome.fitness, JSON.stringify(genome.mutations), genome.createdAt);
    }

    return nextGen;
  }

  /**
   * Record a skill execution outcome for learning.
   */
  recordOutcome(skillId: string, outcome: {
    success: boolean;
    tokensUsed: number;
    durationMs: number;
    domain: string;
  }): void {
    this.db.prepare(`
      INSERT INTO skill_outcomes (id, skill_id, success, tokens_used, duration_ms, domain, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), skillId, outcome.success ? 1 : 0, outcome.tokensUsed, outcome.durationMs, outcome.domain, new Date().toISOString());

    // Update skill traits based on outcome
    this.updateTraits(skillId, outcome);
  }

  /**
   * Get evolution statistics.
   */
  getStats(): {
    totalGenomes: number;
    currentGeneration: number;
    avgFitness: number;
    topSkill: string | null;
    totalOutcomes: number;
  } {
    const genomes = this.db.prepare('SELECT * FROM skill_genomes').all() as any[];
    const outcomes = (this.db.prepare('SELECT COUNT(*) as c FROM skill_outcomes').get() as any)?.c || 0;

    const maxGen = genomes.reduce((max: number, g: any) => Math.max(max, g.generation), 0);
    const avgFitness = genomes.length > 0
      ? genomes.reduce((sum: number, g: any) => sum + g.fitness, 0) / genomes.length
      : 0;

    const topSkill = genomes.length > 0
      ? genomes.sort((a: any, b: any) => b.fitness - a.fitness)[0].skill_id
      : null;

    return {
      totalGenomes: genomes.length,
      currentGeneration: maxGen,
      avgFitness,
      topSkill,
      totalOutcomes: outcomes,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private calculateFitness(traits: SkillGenome['traits']): number {
    // Weighted fitness function
    return (
      traits.efficiency * 0.3 +
      traits.reliability * 0.3 +
      traits.generality * 0.15 +
      (1 - traits.complexity) * 0.15 +
      traits.adaptability * 0.1
    );
  }

  private getCurrentGeneration(): SkillGenome[] {
    const maxGen = (this.db.prepare('SELECT MAX(generation) as max_gen FROM skill_genomes').get() as any)?.max_gen || 0;
    if (maxGen === 0) return [];

    return (this.db.prepare('SELECT * FROM skill_genomes WHERE generation = ?').all(maxGen) as any[]).map(parseGenome);
  }

  private crossover(parent1: SkillGenome, parent2: SkillGenome): SkillGenome {
    const child: SkillGenome = {
      id: randomUUID(),
      skillId: `${parent1.skillId}-x-${parent2.skillId}`,
      generation: parent1.generation + 1,
      parents: [parent1.id, parent2.id],
      traits: {
        efficiency: this.random() < 0.5 ? parent1.traits.efficiency : parent2.traits.efficiency,
        reliability: this.random() < 0.5 ? parent1.traits.reliability : parent2.traits.reliability,
        generality: this.random() < 0.5 ? parent1.traits.generality : parent2.traits.generality,
        complexity: this.random() < 0.5 ? parent1.traits.complexity : parent2.traits.complexity,
        adaptability: this.random() < 0.5 ? parent1.traits.adaptability : parent2.traits.adaptability,
      },
      fitness: 0,
      mutations: [],
      createdAt: new Date().toISOString(),
    };

    child.fitness = this.calculateFitness(child.traits);
    return child;
  }

  private mutate(genome: SkillGenome): void {
    const traits = ['efficiency', 'reliability', 'generality', 'complexity', 'adaptability'] as const;
    const traitToMutate = traits[Math.floor(this.random() * traits.length)];

    // Small random adjustment (±0.1)
    const adjustment = (this.random() - 0.5) * 0.2;
    genome.traits[traitToMutate] = Math.max(0, Math.min(1, genome.traits[traitToMutate] + adjustment));

    genome.mutations.push(`mutated ${traitToMutate} by ${adjustment.toFixed(2)}`);
    genome.fitness = this.calculateFitness(genome.traits);
  }

  private updateTraits(skillId: string, outcome: {
    success: boolean;
    tokensUsed: number;
    durationMs: number;
    domain: string;
  }): void {
    const genomes = this.db.prepare('SELECT * FROM skill_genomes WHERE skill_id = ? ORDER BY generation DESC LIMIT 1').all(skillId) as any[];
    if (genomes.length === 0) return;

    const genome = parseGenome(genomes[0]);

    // Update reliability based on success
    const alpha = 0.3;
    genome.traits.reliability = genome.traits.reliability * (1 - alpha) + (outcome.success ? 1 : 0) * alpha;

    // Update efficiency based on token usage (normalized)
    const expectedTokens = 1000;
    const efficiencyGain = Math.max(0, Math.min(1, expectedTokens / Math.max(1, outcome.tokensUsed)));
    genome.traits.efficiency = genome.traits.efficiency * (1 - alpha) + efficiencyGain * alpha;

    genome.fitness = this.calculateFitness(genome.traits);

    this.db.prepare('UPDATE skill_genomes SET traits_json = ?, fitness = ? WHERE id = ?')
      .run(JSON.stringify(genome.traits), genome.fitness, genome.id);
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
        tokens_used INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        domain TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_skill_genomes_skill_id ON skill_genomes(skill_id);
      CREATE INDEX IF NOT EXISTS idx_skill_genomes_generation ON skill_genomes(generation);
      CREATE INDEX IF NOT EXISTS idx_skill_outcomes_skill_id ON skill_outcomes(skill_id);
    `);
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
