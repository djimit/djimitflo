import { randomUUID } from 'crypto';
import type { Database } from 'better-sqlite3';

export interface CurriculumStep {
  id: string;
  objective: string;
  difficulty: number;
  prerequisites: string[];
  masteryThreshold: number;
  currentMastery: number;
  status: 'locked' | 'available' | 'in_progress' | 'completed';
}

interface StepRow {
  id: string;
  curriculum_id: string;
  objective: string;
  difficulty: number;
  prerequisites_json: string;
  mastery_threshold: number;
  current_mastery: number;
  status: string;
  created_at: string;
}

export class CurriculumLearningService {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS curriculum_steps (
        id TEXT PRIMARY KEY,
        curriculum_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        difficulty REAL NOT NULL DEFAULT 0.5,
        prerequisites_json TEXT NOT NULL DEFAULT '[]',
        mastery_threshold REAL NOT NULL DEFAULT 0.7,
        current_mastery REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'locked',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_curriculum_id ON curriculum_steps(curriculum_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_curriculum_status ON curriculum_steps(status)');
  }

  generateCurriculum(goal: string): CurriculumStep[] {
    const curriculumId = randomUUID();
    const steps = this.decomposeGoal(goal);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const prerequisites = i > 0 ? [steps[i - 1].id] : [];

      this.db.prepare(`
        INSERT INTO curriculum_steps (id, curriculum_id, objective, difficulty, prerequisites_json, mastery_threshold, current_mastery, status)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
      `).run(step.id, curriculumId, step.objective, step.difficulty, JSON.stringify(prerequisites), step.masteryThreshold, i === 0 ? 'available' : 'locked');
    }

    return this.getCurriculum(curriculumId);
  }

  evaluateMastery(stepId: string): number {
    const step = this.db.prepare('SELECT * FROM curriculum_steps WHERE id = ?').get(stepId) as StepRow | undefined;
    if (!step) return 0;

    const leases = this.db.prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successes
      FROM worker_leases WHERE capability_id = ?
    `).get(step.objective) as { total: number; successes: number | null };

    const mastery = leases.total > 0 ? (leases.successes ?? 0) / leases.total : 0;
    this.db.prepare('UPDATE curriculum_steps SET current_mastery = ? WHERE id = ?').run(mastery, stepId);

    if (mastery >= step.mastery_threshold && step.status === 'in_progress') {
      this.advanceStep(stepId);
    } else if (mastery < step.mastery_threshold * 0.5 && step.status === 'in_progress') {
      this.regressStep(stepId);
    }

    return mastery;
  }

  advanceStep(stepId: string): void {
    this.db.prepare("UPDATE curriculum_steps SET status = 'completed' WHERE id = ?").run(stepId);

    const step = this.db.prepare('SELECT curriculum_id FROM curriculum_steps WHERE id = ?').get(stepId) as { curriculum_id: string } | undefined;
    if (!step) return;

    const nextSteps = this.db.prepare(
      "SELECT id, prerequisites_json FROM curriculum_steps WHERE curriculum_id = ? AND status = 'locked'"
    ).all(step.curriculum_id) as Array<{ id: string; prerequisites_json: string }>;

    for (const next of nextSteps) {
      const prereqs = JSON.parse(next.prerequisites_json) as string[];
      const allCompleted = prereqs.every(prereq => {
        const p = this.db.prepare("SELECT status FROM curriculum_steps WHERE id = ?").get(prereq) as { status: string } | undefined;
        return p?.status === 'completed';
      });
      if (allCompleted) {
        this.db.prepare("UPDATE curriculum_steps SET status = 'available' WHERE id = ?").run(next.id);
      }
    }
  }

  regressStep(stepId: string): void {
    const step = this.db.prepare('SELECT current_mastery FROM curriculum_steps WHERE id = ?').get(stepId) as { current_mastery: number } | undefined;
    if (!step || step.current_mastery > 0.2) return;

    this.db.prepare("UPDATE curriculum_steps SET status = 'available' WHERE id = ?").run(stepId);
  }

  getCurriculum(curriculumId: string): CurriculumStep[] {
    const rows = this.db.prepare('SELECT * FROM curriculum_steps WHERE curriculum_id = ? ORDER BY difficulty ASC').all(curriculumId) as StepRow[];
    return rows.map(this.rowToStep);
  }

  getAvailableSteps(curriculumId: string): CurriculumStep[] {
    const rows = this.db.prepare("SELECT * FROM curriculum_steps WHERE curriculum_id = ? AND status = 'available' ORDER BY difficulty ASC").all(curriculumId) as StepRow[];
    return rows.map(this.rowToStep);
  }

  getLearningPath(curriculumId: string): CurriculumStep[] {
    return this.getCurriculum(curriculumId);
  }

  startStep(stepId: string): void {
    this.db.prepare("UPDATE curriculum_steps SET status = 'in_progress' WHERE id = ? AND status = 'available'").run(stepId);
  }

  private decomposeGoal(goal: string): Array<{ id: string; objective: string; difficulty: number; masteryThreshold: number }> {
    const steps: Array<{ id: string; objective: string; difficulty: number; masteryThreshold: number }> = [];

    if (goal.toLowerCase().includes('typescript') || goal.toLowerCase().includes('code')) {
      steps.push({ id: randomUUID(), objective: 'Analyze codebase', difficulty: 0.2, masteryThreshold: 0.7 });
      steps.push({ id: randomUUID(), objective: 'Fix type errors', difficulty: 0.4, masteryThreshold: 0.7 });
      steps.push({ id: randomUUID(), objective: 'Add tests', difficulty: 0.6, masteryThreshold: 0.7 });
      steps.push({ id: randomUUID(), objective: 'Refactor', difficulty: 0.8, masteryThreshold: 0.7 });
    } else if (goal.toLowerCase().includes('security')) {
      steps.push({ id: randomUUID(), objective: 'Scan vulnerabilities', difficulty: 0.3, masteryThreshold: 0.7 });
      steps.push({ id: randomUUID(), objective: 'Fix critical issues', difficulty: 0.6, masteryThreshold: 0.8 });
      steps.push({ id: randomUUID(), objective: 'Add security tests', difficulty: 0.7, masteryThreshold: 0.7 });
    } else {
      steps.push({ id: randomUUID(), objective: `Understand: ${goal}`, difficulty: 0.3, masteryThreshold: 0.7 });
      steps.push({ id: randomUUID(), objective: `Plan: ${goal}`, difficulty: 0.5, masteryThreshold: 0.7 });
      steps.push({ id: randomUUID(), objective: `Execute: ${goal}`, difficulty: 0.7, masteryThreshold: 0.7 });
    }

    return steps;
  }

  private rowToStep(row: StepRow): CurriculumStep {
    return {
      id: row.id,
      objective: row.objective,
      difficulty: row.difficulty,
      prerequisites: JSON.parse(row.prerequisites_json) as string[],
      masteryThreshold: row.mastery_threshold,
      currentMastery: row.current_mastery,
      status: row.status as CurriculumStep['status'],
    };
  }
}
