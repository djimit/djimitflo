export type CouncilMode = 'fast' | 'review' | 'council';
export type RiskClass = 'low' | 'medium' | 'high' | 'critical';

export interface TaskClassification {
  mode: CouncilMode;
  risk_class: RiskClass;
  model_count: number;
  reasoning_depth: number;
  requires_human_approval: boolean;
  privacy_required: 'local' | 'private_cloud' | 'public_api';
  estimated_cost: number;
  estimated_latency_ms: number;
  reasoning: string[];
}

export interface TaskInput {
  description: string;
  risk_class?: RiskClass;
  domains?: string[];
  privacy_sensitive?: boolean;
  realtime?: boolean;
  budget_constraint?: 'low' | 'medium' | 'high';
}

const COMPLEXITY_KEYWORDS = {
  high: ['architectuur', 'architect', 'threat model', 'beleid', 'policy', 'strategy', 'strategisch', 'security review', 'penetration test', 'red team', 'blue team', 'juridisch', 'legal', 'compliance', 'gdpr', 'audit', 'risicoanalyse', 'multi-system', 'distributie', 'consensus', 'second opinion'],
  medium: ['review', 'analyse', 'vergelijk', 'design', 'implementatie', 'refactor', 'test plan', 'documentatie', 'code review', 'optimization', 'performance', 'scaling', 'migratie'],
};

export class TaskRouter {
  classify(input: TaskInput): TaskClassification {
    const reasoning: string[] = [];
    const risk = input.risk_class ?? this.inferRisk(input.description);
    const complexity = this.assessComplexity(input.description);

    let mode: CouncilMode;
    let modelCount: number;
    let reasoningDepth: number;

    if (input.realtime) {
      mode = 'fast';
      modelCount = 1;
      reasoningDepth = 1;
      reasoning.push('Realtime requirement → Fast mode');
    } else if (risk === 'critical' || (complexity === 'high' && risk === 'high')) {
      mode = 'council';
      modelCount = 5;
      reasoningDepth = 4;
      reasoning.push(`Risk=${risk}, complexity=${complexity} → Council mode (5 models)`);
    } else if (risk === 'high' || complexity === 'high') {
      mode = 'council';
      modelCount = 3;
      reasoningDepth = 3;
      reasoning.push(`Risk=${risk}, complexity=${complexity} → Council mode (3 models)`);
    } else if (complexity === 'medium' || risk === 'medium') {
      mode = 'review';
      modelCount = 2;
      reasoningDepth = 2;
      reasoning.push(`Risk=${risk}, complexity=${complexity} → Review mode`);
    } else {
      mode = 'fast';
      modelCount = 1;
      reasoningDepth = 1;
      reasoning.push(`Risk=${risk}, complexity=${complexity} → Fast mode`);
    }

    const privacy = input.privacy_sensitive
      ? 'local'
      : risk === 'high' || risk === 'critical'
        ? 'private_cloud'
        : 'public_api';

    if (input.privacy_sensitive) {
      reasoning.push('Privacy sensitive → local model required');
    }

    const requiresHumanApproval = risk === 'critical' || (risk === 'high' && mode === 'council');
    if (requiresHumanApproval) {
      reasoning.push('High/critical risk → human approval gate required');
    }

    const baseLatency = mode === 'fast' ? 3000 : mode === 'review' ? 20000 : 60000;
    const estimatedLatency = baseLatency * reasoningDepth;

    const baseCost = mode === 'fast' ? 0.001 : mode === 'review' ? 0.01 : 0.05;
    const estimatedCost = baseCost * modelCount * reasoningDepth;

    return {
      mode,
      risk_class: risk,
      model_count: modelCount,
      reasoning_depth: reasoningDepth,
      requires_human_approval: requiresHumanApproval,
      privacy_required: privacy,
      estimated_cost: Math.round(estimatedCost * 1000) / 1000,
      estimated_latency_ms: estimatedLatency,
      reasoning,
    };
  }

  private inferRisk(description: string): RiskClass {
    const lower = description.toLowerCase();
    if (/\b(critical|kritiek|security|beveiliging|production|productie|live|gdpr|privacy|pii)\b/.test(lower)) {
      return 'high';
    }
    if (/\b(high|hoog|important|belangrijk|customer|klant)\b/.test(lower)) {
      return 'medium';
    }
    return 'low';
  }

  private assessComplexity(description: string): 'low' | 'medium' | 'high' {
    const lower = description.toLowerCase();
    for (const keyword of COMPLEXITY_KEYWORDS.high) {
      if (lower.includes(keyword)) return 'high';
    }
    for (const keyword of COMPLEXITY_KEYWORDS.medium) {
      if (lower.includes(keyword)) return 'medium';
    }
    return 'low';
  }
}
