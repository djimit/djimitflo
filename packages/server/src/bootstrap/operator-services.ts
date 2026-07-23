/**
 * Operator runtime services.
 * Only initialized when runtime profile enables operator mode.
 * Extracted from index.ts for separation of concerns.
 */
import { lifecycleManager } from '../services/lifecycle-manager';
import { PromptIntelService } from '../services/prompt-intel-service';

export function initOperatorServices(db: any): void {
  try {
    const promptIntel = new PromptIntelService(db);
    lifecycleManager.register({ serviceName: 'PromptIntel', stop: () => (promptIntel as any)?.stop?.() });
    const pendingPath = process.env.PROMPT_INTEL_PENDING || (process.env.HOME || '/Users/djimit') + '/.djimit/roborev/paperclip-tasks.pending.jsonl';
    const result = promptIntel.ingestFromPending(pendingPath);
    if (result.imported > 0 || result.skipped > 0) {
      console.log(`🔍 PromptIntel: imported ${result.imported} findings, skipped ${result.skipped} (threshold filter)`);
    }
  } catch (error) {
    console.warn('⚠️  PromptIntel ingestion failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }
}
