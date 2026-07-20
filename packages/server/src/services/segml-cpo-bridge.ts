/**
 * SEGML ↔ CognitivePlatformOrchestrator Bridge.
 *
 * Integrates SEGML as a formal subsystem of the CPO's cognitive cycle.
 * Implements the "Learn" phase of Observe→Learn→Plan→Act→Verify→Archive
 * by feeding SEGML's governance intelligence into the broader cognitive loop.
 *
 * Architecture (arXiv 2607.13104 §6.4 Full Scaffolding):
 * - CPO calls SEGML as part of its "Learn" step
 * - SEGML's blind spots become CPO observations
 * - SEGML's score delta feeds CPO's pattern extraction
 * - CPO's strategy evolution can trigger SEGML re-runs
 */

import type { Database } from 'better-sqlite3';
import { SelfEvolvingGovernanceLoop } from './self-evolving-governance-loop';
import { swarmEventBus } from './swarm-event-bus';
import type { BlindSpot } from './segml-types';

export interface SegmlCpoIntegrationResult {
  cycleId: string;
  agentId: string;
  status: 'completed' | 'failed' | 'skipped';
  blindSpots: BlindSpot[];
  scoreDelta: number;
  memoriesCreated: number;
  casesGenerated: number;
  curriculumAdjusted: boolean;
  judgeUpdated: boolean;
}

export class SegmlCpoBridge {
  private segmlLoops: Map<string, SelfEvolvingGovernanceLoop> = new Map();

  constructor(private db: Database) {}

  /**
   * Get or create a SEGML loop instance for an agent.
   * Maintains per-agent evolution state.
   */
  private getLoop(agentId: string): SelfEvolvingGovernanceLoop {
    if (!this.segmlLoops.has(agentId)) {
      this.segmlLoops.set(agentId, new SelfEvolvingGovernanceLoop(this.db));
    }
    return this.segmlLoops.get(agentId)!;
  }

  /**
   * Run SEGML as part of CPO's "Learn" phase.
   * Called by CognitivePlatformOrchestrator.runCognitiveCycle().
   */
  async runSegmlLearningPhase(agentId: string): Promise<SegmlCpoIntegrationResult> {
    const loop = this.getLoop(agentId);

    try {
      const result = await loop.runCycle(agentId);

      const integrationResult: SegmlCpoIntegrationResult = {
        cycleId: result.id,
        agentId,
        status: result.status as 'completed' | 'failed' | 'skipped',
        blindSpots: result.blind_spots_detected.map(category => ({
          category,
          avg_score: 0,
          case_count: 0,
          severity: 'medium' as const,
          recommendation: `Auto-detected blind spot: ${category}`,
        })),
        scoreDelta: result.score_delta,
        memoriesCreated: result.memories_created,
        casesGenerated: result.cases_generated,
        curriculumAdjusted: result.curriculum_phases_adjusted > 0,
        judgeUpdated: result.judge_rubrics_updated > 0,
      };

      // Emit CPO-compatible event for pattern extraction
      swarmEventBus.emit('segml:cpo:learning_complete', {
        agentId,
        cycleId: result.id,
        blindSpots: result.blind_spots_detected,
        scoreDelta: result.score_delta,
        timestamp: result.completed_at,
      });

      return integrationResult;
    } catch (error) {
      return {
        cycleId: '',
        agentId,
        status: 'failed',
        blindSpots: [],
        scoreDelta: 0,
        memoriesCreated: 0,
        casesGenerated: 0,
        curriculumAdjusted: false,
        judgeUpdated: false,
      };
    }
  }

  /**
   * Run SEGML for all agents that have eval data.
   * Called during full CPO cognitive cycle.
   */
  async runFleetSegmlPhase(agentIds: string[]): Promise<SegmlCpoIntegrationResult[]> {
    const results: SegmlCpoIntegrationResult[] = [];

    for (const agentId of agentIds) {
      const result = await this.runSegmlLearningPhase(agentId);
      results.push(result);
    }

    // Fleet-wide aggregation: detect cross-agent patterns
    const fleetBlindSpots = this.aggregateFleetBlindSpots(results);
    if (fleetBlindSpots.length > 0) {
      swarmEventBus.emit('segml:cpo:fleet_blind_spots', {
        blindSpots: fleetBlindSpots,
        affectedAgents: results.filter(r => r.blindSpots.length > 0).map(r => r.agentId),
        timestamp: new Date().toISOString(),
      });
    }

    return results;
  }

  /**
   * Aggregate blind spots across agents to find fleet-wide patterns.
   * If multiple agents fail on the same category, it's a systemic issue.
   */
  private aggregateFleetBlindSpots(results: SegmlCpoIntegrationResult[]): Array<{
    category: string;
    affectedAgents: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
  }> {
    const categoryCounts = new Map<string, number>();

    for (const result of results) {
      for (const spot of result.blindSpots) {
        categoryCounts.set(spot.category, (categoryCounts.get(spot.category) || 0) + 1);
      }
    }

    return Array.from(categoryCounts.entries())
      .map(([category, count]) => ({
        category,
        affectedAgents: count,
        severity: count >= 5 ? 'critical' as const :
                  count >= 3 ? 'high' as const :
                  count >= 2 ? 'medium' as const : 'low' as const,
      }))
      .filter(s => s.affectedAgents >= 2);
  }

  /**
   * Get SEGML status for CPO dashboard.
   */
  getStatus(agentId?: string): {
    monitoredAgents: number;
    latestCycles: Array<{ agentId: string; status: string; scoreDelta: number; timestamp: string }>;
  } {
    const agents = agentId ? [agentId] : Array.from(this.segmlLoops.keys());
    const latestCycles = agents.map(aid => {
      const loop = this.segmlLoops.get(aid);
      const latest = loop?.getLatestCycle();
      return {
        agentId: aid,
        status: latest?.status || 'unknown',
        scoreDelta: latest?.score_delta || 0,
        timestamp: latest?.completed_at || '',
      };
    });

    return {
      monitoredAgents: this.segmlLoops.size,
      latestCycles,
    };
  }
}
