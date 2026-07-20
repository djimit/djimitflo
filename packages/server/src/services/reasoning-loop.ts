export interface ReasoningLoopConfig {
  max_depth: number;
  convergence_threshold: number;
  injection_strength: number;
}

export interface ReasoningLoopResult {
  iterations: number;
  converged: boolean;
  final_output: string;
  stability_score: number;
  score_progression: number[];
  terminated_by: 'convergence' | 'max_depth' | 'divergence';
}

export interface ConvergenceMetrics {
  spectral_radius: number;
  is_stable: boolean;
  marginal_gains: number[];
  recommended_depth: number;
}

export const DEFAULT_REASONING_CONFIG: ReasoningLoopConfig = {
  max_depth: 4,
  convergence_threshold: 0.05,
  injection_strength: 0.3,
};

export class ConvergenceDetector {
  analyze(scoreProgression: number[]): ConvergenceMetrics {
    if (scoreProgression.length < 2) {
      return {
        spectral_radius: 1,
        is_stable: false,
        marginal_gains: [],
        recommended_depth: scoreProgression.length,
      };
    }

    const marginalGains: number[] = [];
    for (let i = 1; i < scoreProgression.length; i++) {
      marginalGains.push(scoreProgression[i] - scoreProgression[i - 1]);
    }

    const spectralRadius = this.estimateSpectralRadius(scoreProgression);
    const isStable = spectralRadius < 1;

    let recommendedDepth = scoreProgression.length;
    for (let i = marginalGains.length - 1; i >= 0; i--) {
      if (Math.abs(marginalGains[i]) < 0.02) {
        recommendedDepth = i + 1;
        break;
      }
    }

    return {
      spectral_radius: Math.round(spectralRadius * 1000) / 1000,
      is_stable: isStable,
      marginal_gains: marginalGains.map(g => Math.round(g * 1000) / 1000),
      recommended_depth: recommendedDepth,
    };
  }

  shouldContinue(scoreProgression: number[], config: ReasoningLoopConfig): boolean {
    if (scoreProgression.length >= config.max_depth) return false;
    if (scoreProgression.length < 2) return true;

    const lastGain = Math.abs(
      scoreProgression[scoreProgression.length - 1] - scoreProgression[scoreProgression.length - 2],
    );

    return lastGain >= config.convergence_threshold;
  }

  detectOverthinking(scoreProgression: number[]): boolean {
    if (scoreProgression.length < 3) return false;

    const lastThree = scoreProgression.slice(-3);
    return lastThree[2] < lastThree[1] && lastThree[1] > lastThree[0];
  }

  private estimateSpectralRadius(scores: number[]): number {
    if (scores.length < 2) return 1;

    const ratios: number[] = [];
    for (let i = 2; i < scores.length; i++) {
      const prevDelta = scores[i - 1] - scores[i - 2];
      const currDelta = scores[i] - scores[i - 1];
      if (Math.abs(prevDelta) > 0.001) {
        ratios.push(Math.abs(currDelta / prevDelta));
      }
    }

    if (ratios.length === 0) return 0.5;
    return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }
}

export class ReasoningLoop {
  private detector = new ConvergenceDetector();

  constructor(private config: ReasoningLoopConfig = DEFAULT_REASONING_CONFIG) {}

  getConfig(): ReasoningLoopConfig {
    return { ...this.config };
  }

  shouldContinue(scoreProgression: number[]): boolean {
    return this.detector.shouldContinue(scoreProgression, this.config);
  }

  analyzeProgression(scoreProgression: number[]): ConvergenceMetrics {
    return this.detector.analyze(scoreProgression);
  }

  detectOverthinking(scoreProgression: number[]): boolean {
    return this.detector.detectOverthinking(scoreProgression);
  }

  computeStabilityScore(scoreProgression: number[]): number {
    if (scoreProgression.length < 2) return 0;

    const metrics = this.detector.analyze(scoreProgression);
    if (!metrics.is_stable) return 0;

    const avgGain = metrics.marginal_gains.reduce((a, b) => a + Math.abs(b), 0)
      / metrics.marginal_gains.length;

    return Math.max(0, Math.round((1 - avgGain * 10) * 100) / 100);
  }

  determineTerminationReason(scoreProgression: number[]): 'convergence' | 'max_depth' | 'divergence' {
    if (scoreProgression.length >= this.config.max_depth) return 'max_depth';

    const metrics = this.detector.analyze(scoreProgression);
    if (metrics.is_stable && scoreProgression.length >= 2) {
      const lastGain = Math.abs(
        scoreProgression[scoreProgression.length - 1] - scoreProgression[scoreProgression.length - 2],
      );
      if (lastGain < this.config.convergence_threshold) return 'convergence';
    }

    if (this.detector.detectOverthinking(scoreProgression)) return 'divergence';

    return 'max_depth';
  }
}
