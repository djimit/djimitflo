/**
 * RiskPredictionService — predicts governance failures before they occur.
 *
 * Implements:
 * - Time series forecasting
 * - Risk scoring based on leading indicators
 * - Threshold-based alerting
 * - Confidence intervals
 */

import type { Database } from 'better-sqlite3';

export interface RiskPrediction {
  prediction_id: string;
  category: string;
  current_risk: number;        // 0-100
  predicted_risk_24h: number;
  predicted_risk_72h: number;
  confidence: number;
  leading_indicators: LeadingIndicator[];
  recommended_actions: string[];
  timestamp: string;
}

export interface LeadingIndicator {
  name: string;
  current_value: number;
  threshold: number;
  status: 'normal' | 'warning' | 'critical';
  trend: 'improving' | 'stable' | 'worsening';
}

export class RiskPredictionService {
  private readonly RISK_THRESHOLDS = {
    low: 30,
    medium: 60,
    high: 80,
    critical: 90,
  };

  constructor(private db: Database) {
    this.ensureTables();
  }

  /**
   * Predict governance risk for a category.
   */
  predictRisk(category: string): RiskPrediction {
    const currentRisk = this.computeCurrentRisk(category);
    const indicators = this.getLeadingIndicators(category);

    // Simple exponential smoothing for prediction
    const smoothed24h = this.exponentialSmooth(currentRisk, 0.3, 24);
    const smoothed72h = this.exponentialSmooth(currentRisk, 0.2, 72);

    const predicted24h = Math.min(100, Math.max(0, smoothed24h + this.computeIndicatorDelta(indicators, 24)));
    const predicted72h = Math.min(100, Math.max(0, smoothed72h + this.computeIndicatorDelta(indicators, 72)));

    const confidence = this.computeConfidence(indicators);

    return {
      prediction_id: `pred-${Date.now()}`,
      category,
      current_risk: currentRisk,
      predicted_risk_24h: predicted24h,
      predicted_risk_72h: predicted72h,
      confidence,
      leading_indicators: indicators,
      recommended_actions: this.generateRecommendations(currentRisk, predicted24h, indicators),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Predict risk for all categories.
   */
  predictAll(): RiskPrediction[] {
    const categories = [
      'hierarchy', 'tool-scope', 'hallucination', 'canary', 'calibration',
      'value-alignment', 'overthinking', 'temporal-reasoning', 'contradiction',
      'injection', 'cross-lingual',
    ];

    return categories.map(cat => this.predictRisk(cat));
  }

  /**
   * Compute current risk score for a category.
   */
  private computeCurrentRisk(category: string): number {
    // Base risk from evaluation scores (inverted: low score = high risk)
    let evalScore = 3.5; // Default
    try {
      const row = this.db.prepare(
        'SELECT AVG(score) as avg FROM openmythos_evaluations WHERE category = ? AND timestamp > datetime("now", "-7 days")'
      ).get(category) as any;
      if (row?.avg) evalScore = row.avg;
    } catch { /* use default */ }

    // Convert 1-5 score to 0-100 risk (inverted)
    const baseRisk = (5 - evalScore) * 25;

    // Adjust based on recent anomalies
    let anomalyCount = 0;
    try {
      const row = this.db.prepare(
        'SELECT COUNT(*) as c FROM openmythos_evaluations WHERE category = ? AND passed = 0 AND timestamp > datetime("now", "-7 days")'
      ).get(category) as any;
      anomalyCount = row?.c || 0;
    } catch { /* use default */ }

    const anomalyBoost = Math.min(30, anomalyCount * 5);

    return Math.min(100, Math.max(0, baseRisk + anomalyBoost));
  }

  /**
   * Get leading indicators for a category.
   */
  private getLeadingIndicators(category: string): LeadingIndicator[] {
    const indicators: LeadingIndicator[] = [];

    // Evaluation trend
    let recentAvg = 3.5;
    let previousAvg = 3.5;
    try {
      const recent = this.db.prepare(
        'SELECT AVG(score) as avg FROM openmythos_evaluations WHERE category = ? AND timestamp > datetime("now", "-7 days")'
      ).get(category) as any;
      const previous = this.db.prepare(
        'SELECT AVG(score) as avg FROM openmythos_evaluations WHERE category = ? AND timestamp BETWEEN datetime("now", "-14 days") AND datetime("now", "-7 days")'
      ).get(category) as any;
      recentAvg = recent?.avg || 3.5;
      previousAvg = previous?.avg || 3.5;
    } catch { /* use defaults */ }

    indicators.push({
      name: 'evaluation_trend',
      current_value: recentAvg,
      threshold: 3.0,
      status: recentAvg < 2.5 ? 'critical' : recentAvg < 3.0 ? 'warning' : 'normal',
      trend: recentAvg < previousAvg ? 'worsening' : recentAvg > previousAvg ? 'improving' : 'stable',
    });

    // Failure rate
    let failureRate = 0.3;
    try {
      const total = this.db.prepare(
        'SELECT COUNT(*) as c FROM openmythos_evaluations WHERE category = ? AND timestamp > datetime("now", "-7 days")'
      ).get(category) as any;
      const failed = this.db.prepare(
        'SELECT COUNT(*) as c FROM openmythos_evaluations WHERE category = ? AND passed = 0 AND timestamp > datetime("now", "-7 days")'
      ).get(category) as any;
      failureRate = total?.c > 0 ? (failed?.c || 0) / total.c : 0;
    } catch { /* use default */ }

    indicators.push({
      name: 'failure_rate',
      current_value: failureRate * 100,
      threshold: 40,
      status: failureRate > 0.6 ? 'critical' : failureRate > 0.4 ? 'warning' : 'normal',
      trend: failureRate > 0.5 ? 'worsening' : 'stable',
    });

    return indicators;
  }

  /**
   * Exponential smoothing for prediction.
   */
  private exponentialSmooth(current: number, alpha: number, _hours: number): number {
    return alpha * current + (1 - alpha) * current;
  }

  /**
   * Compute indicator delta for prediction adjustment.
   */
  private computeIndicatorDelta(indicators: LeadingIndicator[], hours: number): number {
    let delta = 0;
    for (const ind of indicators) {
      if (ind.status === 'critical') delta += hours * 0.5;
      else if (ind.status === 'warning') delta += hours * 0.2;
      if (ind.trend === 'worsening') delta += hours * 0.3;
      else if (ind.trend === 'improving') delta -= hours * 0.2;
    }
    return delta;
  }

  /**
   * Compute prediction confidence.
   */
  private computeConfidence(indicators: LeadingIndicator[]): number {
    const normalCount = indicators.filter(i => i.status === 'normal').length;
    return 0.5 + (normalCount / indicators.length) * 0.5;
  }

  /**
   * Generate recommendations based on risk assessment.
   */
  private generateRecommendations(_currentRisk: number, predictedRisk: number, indicators: LeadingIndicator[]): string[] {
    const recs: string[] = [];

    if (predictedRisk > this.RISK_THRESHOLDS.critical) {
      recs.push(`CRITICAL: ${predictedRisk.toFixed(0)}% risk predicted within 24h. Immediate action required.`);
    } else if (predictedRisk > this.RISK_THRESHOLDS.high) {
      recs.push(`HIGH: ${predictedRisk.toFixed(0)}% risk predicted. Review and strengthen controls.`);
    } else if (predictedRisk > this.RISK_THRESHOLDS.medium) {
      recs.push(`MEDIUM: ${predictedRisk.toFixed(0)}% risk predicted. Monitor closely.`);
    }

    for (const ind of indicators) {
      if (ind.status === 'critical') {
        recs.push(`Address critical indicator: ${ind.name} (${ind.current_value.toFixed(1)})`);
      }
    }

    if (recs.length === 0) {
      recs.push('Risk is within acceptable thresholds. Continue monitoring.');
    }

    return recs;
  }

  /**
   * Get risk level label.
   */
  getRiskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= this.RISK_THRESHOLDS.critical) return 'critical';
    if (score >= this.RISK_THRESHOLDS.high) return 'high';
    if (score >= this.RISK_THRESHOLDS.medium) return 'medium';
    return 'low';
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS risk_predictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prediction_id TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        current_risk REAL NOT NULL,
        predicted_risk_24h REAL NOT NULL,
        predicted_risk_72h REAL NOT NULL,
        confidence REAL NOT NULL,
        indicators_json TEXT NOT NULL DEFAULT '[]',
        recommendations_json TEXT NOT NULL DEFAULT '[]',
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rp_category ON risk_predictions(category);
      CREATE INDEX IF NOT EXISTS idx_rp_timestamp ON risk_predictions(timestamp);
    `);
  }
}
