/**
 * Approval routes
 */

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { createError } from '../middleware/error-handler';

export function createApprovalRoutes(db: Database): Router {
  const router = Router();

  // PATCH /api/approvals/:id - Approve or deny a request
  router.patch('/:id', (req, res, next) => {
    try {
      const { id } = req.params;
      const { approved, reason } = req.body;

      const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;
      
      if (!approval) {
        throw createError(404, 'Approval not found', 'APPROVAL_NOT_FOUND');
      }

      if (approval.status !== 'pending') {
        throw createError(400, 'Approval already processed', 'APPROVAL_ALREADY_PROCESSED');
      }

      const now = new Date().toISOString();
      const newStatus = approved ? 'approved' : 'denied';

      if (approved) {
        db.prepare(`
          UPDATE approvals SET
            status = ?,
            approved_by = ?,
            approved_at = ?,
            updated_at = ?
          WHERE id = ?
        `).run(newStatus, 'user', now, now, id);
      } else {
        db.prepare(`
          UPDATE approvals SET
            status = ?,
            approved_by = ?,
            denied_at = ?,
            denial_reason = ?,
            updated_at = ?
          WHERE id = ?
        `).run(newStatus, 'user', now, reason || 'No reason provided', now, id);
      }

      const updated = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as any;

      res.json({
        ...updated,
        request_data: JSON.parse(updated.request_data || '{}'),
        metadata: JSON.parse(updated.metadata || '{}'),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
