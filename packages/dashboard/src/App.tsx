import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
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
import { useStore } from './lib/store';
import { api } from './lib/api';

function DataLoader({ children }: { children: React.ReactNode }) {
  const { setTasks, setAgents } = useStore();

  useEffect(() => {
    // Load initial data
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
  return (
    <BrowserRouter>
      <WebSocketProvider>
        <DataLoader>
          <Routes>
            <Route path="/" element={<Layout />}>
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
              <Route path="agents" element={<AgentsPage />} />
            </Route>
          </Routes>
        </DataLoader>
      </WebSocketProvider>
    </BrowserRouter>
  );
}
