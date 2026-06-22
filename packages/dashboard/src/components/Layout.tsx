import type { ReactNode } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { Activity, ListTodo, Users, Settings, Shield, CheckSquare, PlugZap, BarChart3, ScrollText, FolderGit, LogOut, DollarSign, Network, Cpu, Workflow, BrainCircuit, Gauge, BookUser } from 'lucide-react';
import { useAuthStore } from '../lib/auth-store';

export function Layout() {
  const location = useLocation();
  const { user, logout } = useAuthStore();
  
  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };
  
  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-64 bg-background-secondary border-r border-border flex flex-col">
        {/* Logo */}
        <div className="p-6 border-b border-border">
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Activity className="w-6 h-6 text-accent" />
            Djimitflo
          </h1>
          <p className="text-sm text-foreground-tertiary mt-1">
            Agent Control Plane
          </p>
        </div>
        
        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1">
          <NavLink
            to="/"
            icon={<Activity className="w-5 h-5" />}
            label="Dashboard"
            active={location.pathname === '/'}
          />
          <NavLink
            to="/tasks"
            icon={<ListTodo className="w-5 h-5" />}
            label="Tasks"
            active={isActive('/tasks')}
          />
          <NavLink
            to="/agents"
            icon={<Users className="w-5 h-5" />}
            label="Agents"
            active={isActive('/agents')}
          />
          <NavLink
            to="/catalog"
            icon={<BookUser className="w-5 h-5" />}
            label="Agent Catalog"
            active={isActive('/catalog')}
          />
          <NavLink
            to="/swarm"
            icon={<Cpu className="w-5 h-5" />}
            label="Swarm"
            active={isActive('/swarm')}
          />
          <NavLink
            to="/approvals"
            icon={<CheckSquare className="w-5 h-5" />}
            label="Approvals"
            active={isActive('/approvals')}
          />
          <NavLink
            to="/policies"
            icon={<Shield className="w-5 h-5" />}
            label="Policies"
            active={isActive('/policies')}
          />
          <NavLink
            to="/mcp-permissions"
            icon={<PlugZap className="w-5 h-5" />}
            label="MCP Permissions"
            active={isActive('/mcp-permissions')}
          />
          <NavLink
            to="/observability"
            icon={<BarChart3 className="w-5 h-5" />}
            label="Observability"
            active={isActive('/observability')}
          />
          <NavLink
            to="/audit"
            icon={<ScrollText className="w-5 h-5" />}
            label="Audit Trail"
            active={isActive('/audit')}
          />
          <NavLink
            to="/repositories"
            icon={<FolderGit className="w-5 h-5" />}
            label="Repositories"
            active={isActive('/repositories')}
          />
          <NavLink
            to="/goals-loops"
            icon={<Workflow className="w-5 h-5" />}
            label="Goals & Loops"
            active={isActive('/goals-loops')}
          />
          <NavLink
            to="/fleet-cockpit"
            icon={<Gauge className="w-5 h-5" />}
            label="Fleet Cockpit"
            active={isActive('/fleet-cockpit')}
          />
          <NavLink
            to="/usage"
            icon={<DollarSign className="w-5 h-5" />}
            label="Usage"
            active={isActive('/usage')}
          />
          <NavLink
            to="/workstation-urls"
            icon={<Network className="w-5 h-5" />}
            label="Workstation URLs"
            active={isActive('/workstation-urls')}
          />
          <NavLink
            to="/swarm-resources"
            icon={<Network className="w-5 h-5" />}
            label="Swarm Resources"
            active={isActive('/swarm-resources')}
          />
          <NavLink
            to="/swarm-mission-control"
            icon={<BrainCircuit className="w-5 h-5" />}
            label="Mission Control"
            active={isActive('/swarm-mission-control')}
          />
        </nav>
        
        {/* Footer */}
        <div className="p-4 border-t border-border">
          {user && (
            <div className="mb-3 px-3 py-2 bg-background-elevated rounded-lg">
              <div className="text-sm font-medium text-foreground truncate">{user.email}</div>
              <div className="text-xs text-foreground-tertiary capitalize">{user.role}</div>
            </div>
          )}
          <NavLink
            to="/settings"
            icon={<Settings className="w-5 h-5" />}
            label="Settings"
            active={isActive('/settings')}
          />
          <button
            onClick={logout}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-foreground-secondary hover:bg-background-elevated hover:text-foreground transition-colors"
          >
            <LogOut className="w-5 h-5" />
            <span className="font-medium">Sign out</span>
          </button>
          <div className="mt-4 text-xs text-foreground-muted">
            v0.5.2 • {new Date().getFullYear()}
          </div>
        </div>
      </aside>
      
      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

interface NavLinkProps {
  to: string;
  icon: ReactNode;
  label: string;
  active: boolean;
}

function NavLink({ to, icon, label, active }: NavLinkProps) {
  return (
    <Link
      to={to}
      className={`
        flex items-center gap-3 px-3 py-2 rounded-lg transition-colors
        ${active
          ? 'bg-accent/10 text-accent border border-accent/20'
          : 'text-foreground-secondary hover:bg-background-elevated hover:text-foreground'
        }
      `}
    >
      {icon}
      <span className="font-medium">{label}</span>
    </Link>
  );
}
