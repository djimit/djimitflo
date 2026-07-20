/**
 * SEGML ↔ PredictiveAnalyticsService Bridge.
 *
 * Adds governance prediction capabilities to SEGML using historical
 * governance data from PredictiveAnalyticsService.
 *
 * Direction 1: Historical governance data → Predictive model
 *   SEGML cycle results are fed into the predictive analytics engine
 *   to forecast future governance degradation.
 *
 * Direction 2: Predictions → SEGML proactive triggers
 *   When the model predicts governance decline, SEGML is triggered
 *   proactively before the next scheduled eval.
 *
 * Direction 3: Risk factors → Curriculum adjustment
 *   Predicted risk factors inform curriculum phase adjustments.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { swarmEventBus } from './swarm-event-bus';

interface GovernancePrediction {
  id: string;
  agentId: string;
  category: string;
  currentScore: number;
  predictedScore: number;
  declineProbability: number;
  riskFactors: string[];
  recommendation: string;
  confidence: number;
  predictedAt: string;
  predictionHorizonDays: number;
}

interface TrendAnalysis {
  category: string;
  slope: number;       // Linear regression slope
  rSquared: number;    // Goodness of fit
  dataPoints: number;
  forecast: number;    // Predicted next value
}

export class SegmlPredictiveBridge {
  constructor(private db: Database) {
    this.ensureTables();
    // Ensure dependent tables exist (from compliance bridge)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_compliance_log (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        compliance_controls_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS segml_predictions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        current_score REAL NOT NULL,
        predicted_score REAL NOT NULL,
        decline_probability REAL NOT NULL,
        risk_factors_json TEXT NOT NULL DEFAULT '[]',
        recommendation TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 0.5,
        prediction_horizon_days INTEGER NOT NULL DEFAULT 7,
        actual_score REAL,
        accuracy REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_segml_pred_agent ON segml_predictions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_segml_pred_category ON segml_predictions(category);
      CREATE INDEX IF NOT EXISTS idx_segml_pred_decline ON segml_predictions(decline_probability DESC);
    `);
  }

  /**
   * Analyze trend for a governance category using linear regression.
   * Uses ordinary least squares on historical SEGML cycle data.
   */
  analyzeTrend(agentId: string, category: string): TrendAnalysis {
    const rows = this.db.prepare(`
      SELECT JSON_EXTRACT(details_json, '$.score_delta') as score_delta, created_at
      FROM segml_compliance_log
      WHERE agent_id = ? AND event_type = 'blind_spot_detected'
        AND JSON_EXTRACT(details_json, '$.category') = ?
      ORDER BY created_at ASC
      LIMIT 50
    `).all(agentId, category) as any[];

    if (rows.length < 3) {
      return { category, slope: 0, rSquared: 0, dataPoints: rows.length, forecast: 0 };
    }

    // Simple linear regression: y = mx + b
    const n = rows.length;
    const xValues = Array.from({ length: n }, (_, i) => i);
    const yValues = rows.map(r => r.score_delta || 0);

    const xMean = xValues.reduce((a, b) => a + b, 0) / n;
    const yMean = yValues.reduce((a, b) => a + b, 0) / n;

    let ssXY = 0, ssXX = 0, ssYY = 0;
    for (let i = 0; i < n; i++) {
      ssXY += (xValues[i] - xMean) * (yValues[i] - yMean);
      ssXX += (xValues[i] - xMean) ** 2;
      ssYY += (yValues[i] - yMean) ** 2;
    }

    const slope = ssXX > 0 ? ssXY / ssXX : 0;
    const intercept = yMean - slope * xMean;
    const rSquared = ssYY > 0 ? (ssXY ** 2) / (ssXX * ssYY) : 0;
    const forecast = intercept + slope * n; // Next prediction

    return { category, slope, rSquared, dataPoints: n, forecast };
  }

  /**
   * Predict governance decline for an agent.
   * Combines trend analysis with risk factor identification.
   */
  predictDecline(agentId: string, category: string, currentScore: number): GovernancePrediction {
    const trend = this.analyzeTrend(agentId, category);

    // Decline probability based on trend slope and current score
    const declineProbability = this.computeDeclineProbability(trend, currentScore);

    const riskFactors = this.identifyRiskFactors(trend, currentScore);
    const recommendation = this.generateRecommendation(declineProbability, riskFactors, trend);

    const prediction: GovernancePrediction = {
      id: randomUUID(),
      agentId,
      category,
      currentScore,
      predictedScore: Math.max(0, currentScore + trend.forecast),
      declineProbability,
      riskFactors,
      recommendation,
      confidence: trend.rSquared,
      predictedAt: new Date().toISOString(),
      predictionHorizonDays: 7,
    };

    // Store prediction
    this.db.prepare(`
      INSERT INTO segml_predictions
      (id, agent_id, category, current_score, predicted_score, decline_probability, risk_factors_json, recommendation, confidence, prediction_horizon_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(prediction.id, agentId, category, currentScore, prediction.predictedScore,
      declineProbability, JSON.stringify(riskFactors), recommendation, prediction.confidence, 7);

    // Emit proactive trigger if decline probability is high
    if (declineProbability > 0.7) {
      swarmEventBus.emit('segml:trigger:predicted_decline', {
        agentId,
        category,
        declineProbability,
        predictedScore: prediction.predictedScore,
        recommendation,
      });
    }

    return prediction;
  }

  /**
   * Compute decline probability from trend and current score.
   */
  private computeDeclineProbability(trend: TrendAnalysis, currentScore: number): number {
    if (trend.dataPoints < 3) return 0.3; // Insufficient data

    // Negative slope + low score = high decline probability
    const slopeFactor = trend.slope < -0.1 ? 0.4 : trend.slope < 0 ? 0.2 : 0;
    const scoreFactor = currentScore < 2.0 ? 0.3 : currentScore < 3.0 ? 0.15 : 0;
    const reliabilityFactor = trend.rSquared > 0.5 ? 0.2 : 0;

    return Math.min(0.95, slopeFactor + scoreFactor + reliabilityFactor);
  }

  /**
   * Identify risk factors from trend analysis.
   */
  private identifyRiskFactors(trend: TrendAnalysis, currentScore: number): string[] {
    const factors: string[] = [];

    if (trend.slope < -0.1) {
      factors.push(`Declining trend (slope: ${trend.slope.toFixed(3)} per cycle)`);
    }
    if (currentScore < 2.5) {
      factors.push(`Low current score (${currentScore.toFixed(2)}/5.0)`);
    }
    if (trend.rSquared < 0.3 && trend.dataPoints > 5) {
      factors.push('High variance in governance scores — unstable behavior');
    }
    if (trend.dataPoints < 5) {
      factors.push(`Insufficient data (${trend.dataPoints} data points) — prediction uncertain`);
    }

    return factors;
  }

  /**
   * Generate recommendation based on prediction.
   */
  private generateRecommendation(declineProbability: number, _riskFactors: string[], trend: TrendAnalysis): string {
    if (declineProbability > 0.8) {
      return `URGENT: High decline risk (${(declineProbability * 100).toFixed(0)}%) — trigger immediate SEGML cycle and consider agent quarantine`;
    }
    if (declineProbability > 0.5) {
      return `WARNING: Moderate decline risk (${(declineProbability * 100).toFixed(0)}%) — schedule SEGML cycle within 24h`;
    }
    if (trend.slope < -0.05) {
      return `MONITOR: Slight negative trend detected — increase monitoring frequency`;
    }
    return `STABLE: No immediate action required — continue regular SEGML cycles`;
  }

  /**
   * Validate a prediction against actual outcome.
   */
  validatePrediction(predictionId: string, actualScore: number): void {
    const prediction = this.db.prepare('SELECT * FROM segml_predictions WHERE id = ?').get(predictionId) as any;
    if (!prediction) return;

    const accuracy = 1 - Math.abs(prediction.predicted_score - actualScore) / 5;

    this.db.prepare(`
      UPDATE segml_predictions SET actual_score = ?, accuracy = ? WHERE id = ?
    `).run(actualScore, Math.max(0, accuracy), predictionId);
  }

  /**
   * Get high-risk predictions across all agents.
   */
  getHighRiskPredictions(threshold = 0.6): GovernancePrediction[] {
    const rows = this.db.prepare(`
      SELECT * FROM segml_predictions
      WHERE decline_probability >= ? AND actual_score IS NULL
      ORDER BY decline_probability DESC
      LIMIT 20
    `).all(threshold) as any[];

    return rows.map(r => ({
      id: r.id,
      agentId: r.agent_id,
      category: r.category,
      currentScore: r.current_score,
      predictedScore: r.predicted_score,
      declineProbability: r.decline_probability,
      riskFactors: JSON.parse(r.risk_factors_json || '[]'),
      recommendation: r.recommendation,
      confidence: r.confidence,
      predictedAt: r.created_at,
      predictionHorizonDays: r.prediction_horizon_days,
    }));
  }

  /**
   * Get prediction accuracy statistics.
   */
  getPredictionAccuracy(): {
    totalPredictions: number;
    validatedPredictions: number;
    avgAccuracy: number;
    highRiskDetected: number;
  } {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM segml_predictions').get() as { c: number };
    const validated = this.db.prepare('SELECT COUNT(*) as c, AVG(accuracy) as avg_acc FROM segml_predictions WHERE actual_score IS NOT NULL').get() as { c: number; avg_acc: number };
    const highRisk = this.db.prepare('SELECT COUNT(*) as c FROM segml_predictions WHERE decline_probability >= 0.7').get() as { c: number };

    return {
      totalPredictions: total.c,
      validatedPredictions: validated.c,
      avgAccuracy: validated.avg_acc || 0,
      highRiskDetected: highRisk.c,
    };
  }
}
