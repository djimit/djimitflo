import { PatternMatch, BehavioralSignal, SelfNarrationMatch } from '../types';

export class ConfidenceScorer {
  compute(
    patternMatches: PatternMatch[],
    behavioralSignals: BehavioralSignal[],
    selfNarrationMatches: SelfNarrationMatch[]
  ): number {
    if (patternMatches.length === 0 && behavioralSignals.length === 0 && selfNarrationMatches.length === 0) {
      return 0;
    }

    let score = this.scorePatterns(patternMatches);
    score = this.adjustForBehavioral(score, behavioralSignals);
    score = this.adjustForSelfNarration(score, selfNarrationMatches);

    return Math.min(Math.round(score * 100) / 100, 0.99);
  }

  private scorePatterns(matches: PatternMatch[]): number {
    if (matches.length === 0) return 0;

    const criticalCount = matches.filter(m => m.riskLevel === 'CRITICAL').length;
    const highCount = matches.filter(m => m.riskLevel === 'HIGH').length;

    if (criticalCount >= 2) return 0.95;
    if (criticalCount === 1) return 0.85;
    if (highCount >= 2) return 0.75;
    if (highCount === 1) return 0.65;
    return 0.4;
  }

  private adjustForBehavioral(baseScore: number, signals: BehavioralSignal[]): number {
    if (signals.length === 0 || baseScore === 0) return baseScore;

    const boost = Math.min(signals.length * 0.05, 0.15);
    return Math.min(baseScore + boost, 0.99);
  }

  private adjustForSelfNarration(baseScore: number, matches: SelfNarrationMatch[]): number {
    if (matches.length === 0 || baseScore === 0) return baseScore;

    const hasEphemeralKey = matches.some(m => m.category === 'ephemeral_key');
    const hasRoiCommentary = matches.some(m => m.category === 'roi_commentary');
    const hasRansomContact = matches.some(m => m.category === 'ransom_contact');

    let boost = Math.min(matches.length * 0.05, 0.15);
    if (hasEphemeralKey) boost += 0.1;
    if (hasRoiCommentary && hasRansomContact) boost += 0.15;

    return Math.min(baseScore + boost, 0.99);
  }
}
