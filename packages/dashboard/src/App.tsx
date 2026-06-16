import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { WebSocketProvider } from './components/WebSocketProvider';
import { DashboardPage } from './pages/DashboardPage';
import { TasksPage } from './pages/TasksPage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { ApprovalQueuePage } from './pages/ApprovalQueuePage';
import { PolicyCenterPage } from './pages/PolicyCenterPage';
import { MCPPermissionsPage } from './pages/MCPPermissionsPage';
import { ObservabilityPage } from './pages/ObservabilityPage';
import { ReviewPage } from './pages/ReviewPage';
import { AuditPage } from './pages/AuditPage';
import { RepositoriesPage } from './pages/RepositoriesPage';
import { RepositoryDetailPage } from './pages/RepositoryDetailPage';
import { GoalsLoopsPage } from './pages/GoalsLoopsPage';
import { SwarmResourcesPage } from './pages/SwarmResourcesPage';
import { LoginPage } from './pages/LoginPage';
import { UsagePage } from './pages/UsagePage';
import { SwarmPage } from './pages/SwarmPage';
import { WorkstationUrlsPage } from './pages/WorkstationUrlsPage';
import { useStore } from './lib/store';
import { useAuthStore } from './lib/auth-store';
import { api } from './lib/api';

function DataLoader({ children }: { children: React.ReactNode }) {
  const { setTasks, setAgents } = useStore();

  useEffect(() => {
    async function loadData() {
      try {
        const [tasksRes, agentsRes] = await Promise.all([
          api.getTasks(),
          api.getAgents(),
        ]);
        setTasks(tasksRes.tasks);
        setAgents(agentsRes.agents);
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
    <BrowserRouter>
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
          <Route path="approvals" element={<ApprovalQueuePage />} />
          <Route path="policies" element={<PolicyCenterPage />} />
          <Route path="mcp-permissions" element={<MCPPermissionsPage />} />
          <Route path="observability" element={<ObservabilityPage />} />
          <Route path="tasks/:taskId/review" element={<ReviewPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="repositories" element={<RepositoriesPage />} />
          <Route path="repositories/:id" element={<RepositoryDetailPage />} />
          <Route path="goals-loops" element={<GoalsLoopsPage />} />
          <Route path="swarm-resources" element={<SwarmResourcesPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="swarm" element={<SwarmPage />} />
          <Route path="usage" element={<UsagePage />} />
          <Route path="workstation-urls" element={<WorkstationUrlsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
