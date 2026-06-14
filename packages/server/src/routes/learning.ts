import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { AuthMiddleware } from '../middleware/auth';
import { createError } from '../middleware/error-handler';
import { randomUUID } from 'crypto';

const VALID_CATEGORIES = ['pattern', 'anti_pattern', 'optimization', 'security', 'workflow', 'tool_usage', 'communication'];

function ensureTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_learning (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('pattern', 'anti_pattern', 'optimization', 'security', 'workflow', 'tool_usage', 'communication')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source_task_id TEXT,
      source_discussion_id TEXT,
      lesson_learned TEXT NOT NULL,
      action_taken TEXT,
      effectiveness INTEGER CHECK(effectiveness >= 0 AND effectiveness <= 100),
      times_applied INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function createLearningRoutes(db: Database, auth?: AuthMiddleware): Router {
  const router = Router();
  const requirePermission = auth?.requirePermission ?? ((_perm: string) => (_req: any, _res: any, next: any) => next());

  ensureTable(db);

  // GET / — List learnings (auth-only, no extra permission)
  router.get('/', (_req, res, next) => {
    try {
      const rows = db.prepare('SELECT * FROM swarm_learning ORDER BY created_at DESC LIMIT 100').all();
      res.json({ learnings: rows });
    } catch (err) { next(err); }
  });

  // GET /:id — Get single learning
  router.get('/:id', (req, res, next) => {
    try {
      const { id } = req.params;
      const row = db.prepare('SELECT * FROM swarm_learning WHERE id = ?').get(id);
      if (!row) {
        throw createError(404, 'Learning not found', 'LEARNING_NOT_FOUND');
      }
      res.json({ learning: row });
    } catch (err) { next(err); }
  });

  // POST / — Create learning entry (from swarm learn())
  router.post('/', requirePermission('manage:config'), (req, res, next) => {
    try {
      const {
        id,
        category = 'pattern',
        title,
        description,
        lesson_learned,
        source_task_id = null,
        source_discussion_id = null,
        effectiveness = 75,
        times_applied = 1,
        metadata = {},
        created_at,
      } = req.body;

      if (!title) {
        throw createError(400, 'title is required', 'INVALID_INPUT');
      }

      const learningId = id || randomUUID();
      const now = new Date().toISOString();

      // Map 'consensus' from swarm to 'pattern' (closest valid category)
      const mappedCategory = VALID_CATEGORIES.includes(category) ? category : 'pattern';
      const learningDesc = description || lesson_learned || title;
      const learningLesson = lesson_learned || description || title;

      db.prepare(`
        INSERT INTO swarm_learning (id, category, title, description, lesson_learned,
          source_task_id, source_discussion_id, effectiveness, times_applied,
          metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        learningId,
        mappedCategory,
        title,
        learningDesc,
        learningLesson,
        source_task_id,
        source_discussion_id,
        effectiveness,
        times_applied,
        typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
        created_at || now,
        now,
      );

      const row = db.prepare('SELECT * FROM swarm_learning WHERE id = ?').get(learningId);
      res.status(201).json({ learning: row });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
