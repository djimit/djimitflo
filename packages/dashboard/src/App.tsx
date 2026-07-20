import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { WebSocketProvider } from './components/WebSocketProvider';
import { GlobalErrorBoundary } from './components/GlobalErrorBoundary';
import { DashboardPage } from './pages/DashboardPage';
import { TasksPage } from './pages/TasksPage';
import { AgentsPage } from './pages/AgentsPage';
import { LoginPage } from './pages/LoginPage';
import { useStore } from './lib/store';
import { useAuthStore } from './lib/auth-store';
import { api } from './lib/api';

const AgentCatalogPage = lazy(() => import('./pages/AgentCatalogPage').then((module) => ({ default: module.AgentCatalogPage })));
const AgiReasoningPage = lazy(() => import('./pages/AgiReasoningPage').then((module) => ({ default: module.AgiReasoningPage })));
const ConsensusDebatePage = lazy(() => import('./pages/ConsensusDebatePage').then((module) => ({ default: module.ConsensusDebatePage })));
const PredictiveAnalyticsPage = lazy(() => import('./pages/PredictiveAnalyticsPage').then((module) => ({ default: module.PredictiveAnalyticsPage })));
const SelfHealingPage = lazy(() => import('./pages/SelfHealingPage').then((module) => ({ default: module.SelfHealingPage })));
const CognitiveRuntimePage = lazy(() => import('./pages/CognitiveRuntimePage').then((module) => ({ default: module.CognitiveRuntimePage })));
const SelfDrivingDashboard = lazy(() => import('./pages/SelfDrivingDashboard').then((module) => ({ default: module.SelfDrivingDashboard })));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage').then((module) => ({ default: module.TaskDetailPage })));
const SwarmOverviewPage = lazy(() => import('./pages/SwarmOverviewPage').then((module) => ({ default: module.SwarmOverviewPage })));
const ApprovalQueuePage = lazy(() => import('./pages/ApprovalQueuePage').then((module) => ({ default: module.ApprovalQueuePage })));
const PolicyCenterPage = lazy(() => import('./pages/PolicyCenterPage').then((module) => ({ default: module.PolicyCenterPage })));
const MCPPermissionsPage = lazy(() => import('./pages/MCPPermissionsPage').then((module) => ({ default: module.MCPPermissionsPage })));
const ObservabilityPage = lazy(() => import('./pages/ObservabilityPage').then((module) => ({ default: module.ObservabilityPage })));
const ReviewPage = lazy(() => import('./pages/ReviewPage').then((module) => ({ default: module.ReviewPage })));
const AuditPage = lazy(() => import('./pages/AuditPage').then((module) => ({ default: module.AuditPage })));
const RepositoriesPage = lazy(() => import('./pages/RepositoriesPage').then((module) => ({ default: module.RepositoriesPage })));
const RepositoryDetailPage = lazy(() => import('./pages/RepositoryDetailPage').then((module) => ({ default: module.RepositoryDetailPage })));
const GoalsLoopsPage = lazy(() => import('./pages/GoalsLoopsPage').then((module) => ({ default: module.GoalsLoopsPage })));
const FleetCockpitPage = lazy(() => import('./pages/FleetCockpitPage').then((module) => ({ default: module.FleetCockpitPage })));
const SwarmResourcesPage = lazy(() => import('./pages/SwarmResourcesPage').then((module) => ({ default: module.SwarmResourcesPage })));
const SwarmMissionControlPage = lazy(() => import('./pages/SwarmMissionControlPage').then((module) => ({ default: module.SwarmMissionControlPage })));
const ProofRunDetailPage = lazy(() => import('./pages/ProofRunDetailPage').then((module) => ({ default: module.ProofRunDetailPage })));
const UsagePage = lazy(() => import('./pages/UsagePage').then((module) => ({ default: module.UsagePage })));
const WorkstationUrlsPage = lazy(() => import('./pages/WorkstationUrlsPage').then((module) => ({ default: module.WorkstationUrlsPage })));
const EconomyPage = lazy(() => import('./pages/EconomyPage').then((module) => ({ default: module.EconomyPage })));
const PipelineBuilderPage = lazy(() => import('./pages/PipelineBuilderPage').then((module) => ({ default: module.PipelineBuilderPage })));
const FederationPage = lazy(() => import('./pages/FederationPage').then((module) => ({ default: module.FederationPage })));
const SegmlGovernancePage = lazy(() => import('./pages/SegmlGovernancePage').then((module) => ({ default: module.SegmlGovernancePage })));

function DataLoader({ children }: { children: React.ReactNode }) {
  const { setTasks, setAgents } = useStore();

  useEffect(() => {
    async function loadData() {
      try {
        const [tasksRes, agentsRes] = await Promise.all([
          api.getTasks(),
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
          <Route index element={<DashboardPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="catalog" element={<AgentCatalogPage />} />
          <Route path="swarm" element={<SwarmOverviewPage />} />
          <Route path="approvals" element={<ApprovalQueuePage />} />
          <Route path="policies" element={<PolicyCenterPage />} />
          <Route path="mcp-permissions" element={<MCPPermissionsPage />} />
          <Route path="observability" element={<ObservabilityPage />} />
          <Route path="tasks/:taskId/review" element={<ReviewPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="repositories" element={<RepositoriesPage />} />
          <Route path="repositories/:id" element={<RepositoryDetailPage />} />
          <Route path="goals-loops" element={<GoalsLoopsPage />} />
          <Route path="fleet-cockpit" element={<FleetCockpitPage />} />
          <Route path="swarm-resources" element={<SwarmResourcesPage />} />
          <Route path="swarm-mission-control" element={<SwarmMissionControlPage />} />
          <Route path="swarm-mission-control/proof-runs/:proofRunId" element={<ProofRunDetailPage />} />
          <Route path="workstation-urls" element={<WorkstationUrlsPage />} />
          <Route path="economy" element={<EconomyPage />} />
          <Route path="pipeline-builder" element={<PipelineBuilderPage />} />
          <Route path="federation" element={<FederationPage />} />
          <Route path="segml-governance" element={<SegmlGovernancePage />} />
          <Route path="agi-reasoning" element={<AgiReasoningPage />} />
          <Route path="consensus-debates" element={<ConsensusDebatePage />} />
          <Route path="predictive-analytics" element={<PredictiveAnalyticsPage />} />
          <Route path="self-healing" element={<SelfHealingPage />} />
          <Route path="cognitive" element={<CognitiveRuntimePage />} />
          <Route path="self-driving" element={<SelfDrivingDashboard />} />
        </Route>
      </Routes>
      </Suspense>
    </BrowserRouter>
    </GlobalErrorBoundary>
  );
}
