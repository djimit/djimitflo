import type { ReactNode } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { Activity, ListTodo, Users, Settings } from 'lucide-react';

export function Layout() {
  const location = useLocation();
  
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
        </nav>
        
        {/* Footer */}
        <div className="p-4 border-t border-border">
          <NavLink
            to="/settings"
            icon={<Settings className="w-5 h-5" />}
            label="Settings"
            active={isActive('/settings')}
          />
          <div className="mt-4 text-xs text-foreground-muted">
            v0.1.0 • {new Date().getFullYear()}
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
