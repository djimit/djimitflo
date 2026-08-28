const { randomUUID } = require('crypto');
const { DeepAgentExecutor } = require('../packages/server/dist/execution/executors/deep-agent-executor');
const { DeepAgentContractIssuer } = require('../packages/server/dist/services/deep-agent-contract-issuer');

async function main() {
  const task = {
    id: randomUUID(),
    description: 'Verify the contract-gated no-tool Deep Agents path',
    risk_level: 'low',
    owner_user_id: 'deep-agent-canary',
    created_by: null,
    metadata: { tenant_id: 'djimit-platform', workload_id: `canary-${randomUUID()}` },
  };
  task.metadata.deep_agent_contract = new DeepAgentContractIssuer().issue(task);
  const session = await new DeepAgentExecutor().start(task, { timeout: 10_000 });
  const eventTypes = [];
  for await (const event of session.events) eventTypes.push(event.event_type);
  const result = await session.result;
  console.log(JSON.stringify({
    execution_id: task.metadata.deep_agent_contract.identity.execution_id,
    event_types: eventTypes,
    status: result.status,
    error: result.status === 'failed' ? result.error : undefined,
  }));
  if (result.status !== 'completed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
