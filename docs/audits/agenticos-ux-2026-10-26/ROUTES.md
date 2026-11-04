# Route inventory

Source declarations, not browser coverage. See JSON for API call names, extraction limits and source locations.

| Route | Component / redirect | Navigation | Coverage |
|---|---|---|---|
| `/login` | LoginPage | contextual / not in sidebar | source indexed only; not functionally verified |
| `/` | OperatorCockpitPage | Operate | source reviewed; no browser evidence |
| `/dashboard` | DashboardPage | Lab | source indexed only; not functionally verified |
| `/tasks` | TasksPage | Operate | source indexed only; not functionally verified |
| `/tasks/:taskId` | TaskDetailPage | contextual / not in sidebar | source indexed only; not functionally verified |
| `/agents` | AgentsPage | Fleet | source reviewed; no browser evidence |
| `/agents/:agentId` | AgentsPage | contextual / not in sidebar | source reviewed; no browser evidence |
| `/catalog` | AgentCatalogPage | Lab | source indexed only; not functionally verified |
| `/swarm` | SwarmOverviewPage | Lab | source reviewed; no browser evidence |
| `/approvals` | /decisions#approvals | contextual / not in sidebar | source indexed only; not functionally verified |
| `/policies` | PolicyCenterPage | Govern | source indexed only; not functionally verified |
| `/governance` | GovernanceHubPage | Govern | source reviewed; no browser evidence |
| `/compliance` | /governance?tab=assurance | contextual / not in sidebar | source indexed only; not functionally verified |
| `/mcp-permissions` | MCPPermissionsPage | Govern | source indexed only; not functionally verified |
| `/observability` | ObservabilityPage | Improve | source reviewed; no browser evidence |
| `/tasks/:taskId/review` | ReviewPage | contextual / not in sidebar | source indexed only; not functionally verified |
| `/audit` | AuditHubPage | Govern | source reviewed; no browser evidence |
| `/audit/logs` | /audit?tab=logs | contextual / not in sidebar | source indexed only; not functionally verified |
| `/cockpit` | / | contextual / not in sidebar | source indexed only; not functionally verified |
| `/decisions` | DecisionsInboxPage | Operate | source indexed only; not functionally verified |
| `/configuration` | ConfigurationPage | Govern | source reviewed; no browser evidence |
| `/fleet` | FleetHostsPage | Fleet | source indexed only; not functionally verified |
| `/improvement-funnel` | ImprovementFunnelPage | Improve | source indexed only; not functionally verified |
| `/authority` | AuthorityTracePage | Govern | source indexed only; not functionally verified |
| `/usage` | UsagePage | Improve | source indexed only; not functionally verified |
| `/repositories` | RepositoriesPage | Operate | source indexed only; not functionally verified |
| `/repositories/:id` | RepositoryDetailPage | contextual / not in sidebar | source indexed only; not functionally verified |
| `/goals-loops` | GoalsLoopsPage | Operate | source indexed only; not functionally verified |
| `/fleet-cockpit` | FleetCockpitPage | Lab | source indexed only; not functionally verified |
| `/swarm-resources` | SwarmResourcesPage | Lab | source indexed only; not functionally verified |
| `/swarm-mission-control` | SwarmMissionControlPage | Lab | source reviewed; no browser evidence |
| `/interaction-board` | InteractionBoardPage | Lab | source indexed only; not functionally verified |
| `/agent-commons` | AgentCommonsPage | Knowledge | source reviewed; no browser evidence |
| `/evolution` | EvolutionPage | Improve | source reviewed; no browser evidence |
| `/knowledge` | KnowledgePage | Knowledge | source reviewed; no browser evidence |
| `/frontier-experts` | FrontierExpertsPage | Knowledge | source indexed only; not functionally verified |
| `/frontier-experts/:expertId` | FrontierExpertsPage | contextual / not in sidebar | source indexed only; not functionally verified |
| `/swarm-mission-control/proof-runs/:proofRunId` | ProofRunDetailPage | contextual / not in sidebar | source indexed only; not functionally verified |
| `/swarm-mission-control/missions/:missionId` | MissionDetailPage | contextual / not in sidebar | source reviewed; no browser evidence |
| `/economy` | EconomyPage | Lab | source indexed only; not functionally verified |
| `/pipeline-builder` | PipelineBuilderPage | Lab | source indexed only; not functionally verified |
| `/federation` | FederationPage | Lab | source indexed only; not functionally verified |
| `/agi-reasoning` | AgiReasoningPage | Lab | source indexed only; not functionally verified |
| `/consensus-debates` | ConsensusDebatePage | Lab | source indexed only; not functionally verified |
| `/predictive-analytics` | PredictiveAnalyticsPage | Lab | source indexed only; not functionally verified |
| `/self-healing` | SelfHealingPage | Lab | source indexed only; not functionally verified |
| `/cognitive` | CognitiveRuntimePage | Lab | source indexed only; not functionally verified |
| `/self-driving` | SelfDrivingDashboard | Lab | source indexed only; not functionally verified |
| `/explainers` | ExplainerFleetPage | Lab | source indexed only; not functionally verified |
| `*` | NotFoundPage | contextual / not in sidebar | source indexed only; not functionally verified |
