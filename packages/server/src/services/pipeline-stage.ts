/**
 * PipelineStage — composable pipeline abstraction (x-algorithm candidate pipeline pattern).
 *
 * Each stage is independently testable, replaceable, and supports rollback.
 * Stages compose: Source → Hydrate → Filter → Score → Select → SideEffect.
 */

export interface PipelineContext {
  runId: string;
  agentId: string;
  startTime: number;
  budgetMs: number;
  metadata: Record<string, unknown>;
}

export interface ScoredCandidate<T = unknown> {
  candidate: T;
  score: number;
  scores: Record<string, number>;
  provenance: string[];
  timestamp: string;
}

export interface PipelineStageResult<T> {
  output: T;
  stageName: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface PipelineStage<I, O> {
  readonly name: string;
  execute(input: I, ctx: PipelineContext): Promise<O>;
  rollback?(input: I, output: O): Promise<void>;
}

/**
 * Compose multiple stages into a pipeline.
 * If any stage fails, rollback is called on all previous stages in reverse order.
 */
export async function composeStages<I, O>(
  stages: PipelineStage<unknown, unknown>[],
  input: I,
  ctx: PipelineContext,
): Promise<PipelineStageResult<O>> {
  const results: PipelineStageResult<unknown>[] = [];
  let current: unknown = input;

  for (const stage of stages) {
    const start = Date.now();
    try {
      const output = await stage.execute(current, ctx);
      results.push({ output, stageName: stage.name, durationMs: Date.now() - start, success: true });
      current = output;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.push({ output: current, stageName: stage.name, durationMs: Date.now() - start, success: false, error: errorMsg });

      // Rollback in reverse order
      for (let i = results.length - 2; i >= 0; i--) {
        const prevStage = stages[i];
        if (prevStage.rollback) {
          try {
            await prevStage.rollback(results[i].output, results[i].output);
          } catch {
            // Rollback errors are swallowed — best effort
          }
        }
      }

      return { output: current as O, stageName: stage.name, durationMs: Date.now() - start, success: false, error: errorMsg };
    }
  }

  return results[results.length - 1] as PipelineStageResult<O>;
}
