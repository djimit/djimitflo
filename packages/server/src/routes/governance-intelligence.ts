/**
 * Governance Intelligence Route — category trends, degradation alerts, improvement velocity.
 *
 * GET /api/governance/intelligence/:agentId
 * Returns per-category trend data with slope detection for governance degradation.
 */

import express from 'express';
import type { Database } from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';

export function createGovernanceIntelligenceRouter(db: Database): express.Router {
  const router = express.Router();

  /**
   * Get governance intelligence for an agent.
   * Returns category-level trends with linear regression slope for degradation detection.
   */
  // @ts-expect-error TS7030: Express handlers don't need explicit return
  router.get('/intelligence/:agentId', (req: Request, res: Response, _next: NextFunction) => {
    const { agentId } = req.params;

    // Validate agentId format (UUID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(agentId)) {
      return res.status(400).json({ error: 'Invalid agentId format' });
    }

    // get per-category averages from recent runs
    const recentRuns = db.prepare(`
      SELECT categories_json, overall_score, finished_at
      FROM openmythos_eval_runs
      WHERE agent_id = ? AND status = 'completed'
      ORDER BY finished_at DESC
      LIMIT 10
    `).all(agentId) as Array<{
      categories_json: string;
      overall_score: number;
      finished_at: string;
    }>;

    // Build category trend map
    const categoryData: Record<string, { scores: number[]; dates: string[] }> = {};
    for (const run of recentRuns) {
      const cats = JSON.parse(run.categories_json || '{}');
      for (const [cat, score] of Object.entries(cats)) {
        if (!categoryData[cat]) categoryData[cat] = { scores: [], dates: [] };
        categoryData[cat].scores.push(score as number);
        categoryData[cat].dates.push(run.finished_at);
      }
    }

    // Calculate trend slopes (simple linear regression)
    const trends = Object.entries(categoryData).map(([category, data]) => {
      const n = data.scores.length;
      const slope = n >= 2
        ? (data.scores[0] - data.scores[n - 1]) / n  // Positive = improving
        : 0;
      const avg = data.scores.reduce((a, b) => a + b, 0) / n;

      return {
        category,
        averageScore: Math.round(avg * 100) / 100,
        trendSlope: Math.round(slope * 1000) / 1000,
        trend: slope > 0.05 ? 'improving' : slope < -0.05 ? 'declining' : 'stable',
        runs: n,
        currentScore: data.scores[0] ?? 0,
      };
    });

    // Detect degradations
    const degradations = trends.filter(t => t.trend === 'declining');
    const weakCategories = trends.filter(t => t.averageScore < 3.0);

    res.json({
      agentId,
      trends,
      degradations,
      weakCategories,
      overallHealth: trends.length > 0
        ? Math.round((trends.reduce((a, t) => a + t.averageScore, 0) / trends.length) * 100) / 100
        : 0,
      generatedAt: new Date().toISOString(),
    });
  });

  return router;
}

