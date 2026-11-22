import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { WebSocketProvider } from './components/WebSocketProvider';
import { GlobalErrorBoundary } from './components/GlobalErrorBoundary';
import { useStore } from './lib/store';
import { useAuthStore } from './lib/auth-store';
import { api } from './lib/api';

// UX-28: every page is a lazy chunk; a stale chunk after a deploy is handled by lib/chunk-reload (main.tsx + GlobalErrorBoundary).
const LoginPage = lazy(() => import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then((module) => ({ default: module.TasksPage })));
const AgentsPage = lazy(() => import('./pages/AgentsPage').then((module) => ({ default: module.AgentsPage })));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage').then((module) => ({ default: module.TaskDetailPage })));
const PolicyCenterPage = lazy(() => import('./pages/PolicyCenterPage').then((module) => ({ default: module.PolicyCenterPage })));
const MCPPermissionsPage = lazy(() => import('./pages/MCPPermissionsPage').then((module) => ({ default: module.MCPPermissionsPage })));
const ObservabilityPage = lazy(() => import('./pages/ObservabilityPage').then((module) => ({ default: module.ObservabilityPage })));
const ReviewPage = lazy(() => import('./pages/ReviewPage').then((module) => ({ default: module.ReviewPage })));
const AuditHubPage = lazy(() => import('./pages/AuditHubPage').then((module) => ({ default: module.AuditHubPage })));
const EvolutionPage = lazy(() => import('./pages/EvolutionPage').then((module) => ({ default: module.EvolutionPage })));
const KnowledgePage = lazy(() => import('./pages/KnowledgePage').then((module) => ({ default: module.KnowledgePage })));
const OperatorCockpitPage = lazy(() => import('./pages/OperatorCockpitPage').then((module) => ({ default: module.OperatorCockpitPage })));
const DecisionsInboxPage = lazy(() => import('./pages/DecisionsInboxPage').then((module) => ({ default: module.DecisionsInboxPage })));
const ConfigurationPage = lazy(() => import('./pages/ConfigurationPage').then((module) => ({ default: module.ConfigurationPage })));
const ImprovementFunnelPage = lazy(() => import('./pages/ImprovementFunnelPage').then((module) => ({ default: module.ImprovementFunnelPage })));
const AuthorityTracePage = lazy(() => import('./pages/AuthorityTracePage').then((module) => ({ default: module.AuthorityTracePage })));
const RepositoriesPage = lazy(() => import('./pages/RepositoriesPage').then((module) => ({ default: module.RepositoriesPage })));
const RepositoryDetailPage = lazy(() => import('./pages/RepositoryDetailPage').then((module) => ({ default: module.RepositoryDetailPage })));
const FleetHubPage = lazy(() => import('./pages/FleetHubPage').then((module) => ({ default: module.FleetHubPage })));
const AgentCommonsHubPage = lazy(() => import('./pages/AgentCommonsHubPage').then((module) => ({ default: module.AgentCommonsHubPage })));
const GoalsLoopsPage = lazy(() => import('./pages/GoalsLoopsPage').then((module) => ({ default: module.GoalsLoopsPage })));
const SwarmMissionControlPage = lazy(() => import('./pages/SwarmMissionControlPage').then((module) => ({ default: module.SwarmMissionControlPage })));
const FrontierExpertsPage = lazy(() => import('./pages/FrontierExpertsPage').then((module) => ({ default: module.FrontierExpertsPage })));
const ProofRunDetailPage = lazy(() => import('./pages/ProofRunDetailPage').then((module) => ({ default: module.ProofRunDetailPage })));
const MissionDetailPage = lazy(() => import('./pages/MissionDetailPage').then((module) => ({ default: module.MissionDetailPage })));
const UsagePage = lazy(() => import('./pages/UsagePage').then((module) => ({ default: module.UsagePage })));
const GovernanceHubPage = lazy(() => import('./pages/GovernanceHubPage').then((module) => ({ default: module.GovernanceHubPage })));

function DataLoader({ children }: { children: React.ReactNode }) {
  const { setTasks, setAgents } = useStore();

  useEffect(() => {
    async function loadData() {
      try {
        // Truth audit 2026-11-12: no longer the full first page of tasks (1.2 MB) on every route. Pages that list or
        // count tasks read them themselves; the store only seeds running tasks (Agents "Current Task", live WS merges).
        const [tasksRes, agentsRes] = await Promise.all([
          api.getTasks({ status: 'running', view: 'summary' }),
          api.getAgents(),
        ]);
        setTasks(tasksRes?.tasks ?? []);
        setAgents(agentsRes?.agents ?? []);
      } catch (error) {
        console.error('Failed to load initial data:', error);
      }
    }
    loadData();
  }, [setTasks, setAgents]);

  return <>{children}</>;
}

export function App() {
  const { restoreSession } = useAuthStore();

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  return (
    <GlobalErrorBoundary>
    <BrowserRouter>
      <Suspense fallback={<div className="p-8 text-foreground-secondary">Loading...</div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={
          <ProtectedRoute>
            <WebSocketProvider>
              <DataLoader>
                <Layout />
              </DataLoader>
            </WebSocketProvider>
          </ProtectedRoute>
        }>
          <Route index element={<OperatorCockpitPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:agentId" element={<AgentsPage />} />
          <Route path="approvals" element={<Navigate to="/decisions#approvals" replace />} />
          <Route path="policies" element={<PolicyCenterPage />} />
          <Route path="governance" element={<GovernanceHubPage />} />
          <Route path="compliance" element={<Navigate to="/governance?tab=assurance" replace />} />
          <Route path="mcp-permissions" element={<MCPPermissionsPage />} />
          <Route path="observability" element={<ObservabilityPage />} />
          <Route path="tasks/:taskId/review" element={<ReviewPage />} />
          <Route path="audit" element={<AuditHubPage />} />
          <Route path="audit/logs" element={<Navigate to="/audit?tab=logs" replace />} />
          <Route path="cockpit" element={<Navigate to="/" replace />} />
          <Route path="decisions" element={<DecisionsInboxPage />} />
          <Route path="configuration" element={<ConfigurationPage />} />
          <Route path="fleet" element={<FleetHubPage />} />
          <Route path="improvement-funnel" element={<ImprovementFunnelPage />} />
          <Route path="authority" element={<AuthorityTracePage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="repositories" element={<RepositoriesPage />} />
          <Route path="repositories/:id" element={<RepositoryDetailPage />} />
          <Route path="goals-loops" element={<GoalsLoopsPage />} />
          <Route path="swarm-mission-control" element={<SwarmMissionControlPage />} />
          <Route path="agent-commons" element={<AgentCommonsHubPage />} />
          <Route path="evolution" element={<EvolutionPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="frontier-experts" element={<FrontierExpertsPage />} />
          <Route path="frontier-experts/:expertId" element={<FrontierExpertsPage />} />
          <Route path="swarm-mission-control/proof-runs/:proofRunId" element={<ProofRunDetailPage />} />
          <Route path="swarm-mission-control/missions/:missionId" element={<MissionDetailPage />} />
          {/* Nav cut (UX-30, truth audit 2026-11-12): retired pages and pages merged into another page keep their URL as a redirect */}
          <Route path="dashboard" element={<Navigate to="/" replace />} />
          <Route path="swarm" element={<Navigate to="/agents" replace />} />
          <Route path="economy" element={<Navigate to="/usage" replace />} />
          <Route path="explainers" element={<Navigate to="/repositories" replace />} />
          <Route path="cognitive" element={<Navigate to="/evolution" replace />} />
          <Route path="agi-reasoning" element={<Navigate to="/" replace />} />
          <Route path="predictive-analytics" element={<Navigate to="/improvement-funnel" replace />} />
          <Route path="consensus-debates" element={<Navigate to="/decisions" replace />} />
          <Route path="catalog" element={<Navigate to="/agents" replace />} />
          <Route path="federation" element={<Navigate to="/fleet" replace />} />
          <Route path="pipeline-builder" element={<Navigate to="/goals-loops" replace />} />
          <Route path="self-healing" element={<Navigate to="/observability#health-checks" replace />} />
          <Route path="interaction-board" element={<Navigate to="/agent-commons?tab=interactions" replace />} />
          <Route path="fleet-cockpit" element={<Navigate to="/fleet?tab=workers" replace />} />
          <Route path="self-driving" element={<Navigate to="/configuration#runtime-tuned" replace />} />
          <Route path="swarm-resources" element={<Navigate to="/governance?tab=swarm" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
      </Suspense>
    </BrowserRouter>
    </GlobalErrorBoundary>
  );
}
