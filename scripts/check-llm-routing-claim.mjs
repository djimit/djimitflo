import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const messages = execFileSync('git', ['log', '-30', '--format=%s'], { encoding: 'utf8' });
if (!/^feat(?:\([^)]*\))?:.*llm[- ]routing/im.test(messages)) process.exit(0);

const source = readFileSync(new URL('../packages/server/src/services/llm-router-service.ts', import.meta.url), 'utf8');
for (const marker of ['class LlmRouterService', 'route(request:', 'recordPerformance(']) {
  if (!source.includes(marker)) {
    console.error(`LLM routing feature claim lacks runtime marker: ${marker}`);
    process.exit(1);
  }
}
