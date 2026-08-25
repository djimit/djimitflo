import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DbHandle } from './db.js';
import { registerAgentTools } from './tools/agents.js';
import { registerExplainerTools } from './tools/explainer.js';
import { registerGoalTools } from './tools/goals.js';
import { registerGovernanceTools } from './tools/governance.js';
import { registerLoopTools } from './tools/loops.js';
import { registerMissionControlTools } from './tools/mission-control.js';
import { registerNotebookTools } from './tools/notebooks.js';
import { registerOkfTools } from './tools/okf.js';
import { registerOpenMythosTools } from './tools/openmythos.js';
import { registerOrchestrationTools } from './tools/orchestration.js';

export function registerTools(server: McpServer, db: DbHandle): void {
  registerLoopTools(server, db);
  registerGoalTools(server, db);
  registerAgentTools(server, db);
  registerMissionControlTools(server, db);
  registerOrchestrationTools(server, db);
  registerOkfTools(server);
  registerOpenMythosTools(server, db);
  registerNotebookTools(server);
  registerExplainerTools(server, db.db);
  registerGovernanceTools(server, db);
}
