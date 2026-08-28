const { randomUUID } = require('crypto');
const { DeepAgentExecutor } = require('../packages/server/dist/execution/executors/deep-agent-executor');
const { DeepAgentContractIssuer } = require('../packages/server/dist/services/deep-agent-contract-issuer');

async function main() {
  const actorId = process.env.DJIMIT_DEEP_CANARY_ACTOR_ID;
  if (!actorId) throw new Error('DJIMIT_DEEP_CANARY_ACTOR_ID is required');
  const task = {
    id: randomUUID(),
    description: 'Verify the contract-gated no-tool Deep Agents path',
    risk_level: 'low',
    owner_user_id: 'deep-agent-canary',
    created_by: null,
    metadata: {},
  };
  task.metadata.deep_agent_contract = new DeepAgentContractIssuer().issue(task, actorId);
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
