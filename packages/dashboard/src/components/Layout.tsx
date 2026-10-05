import { useEffect, useState, type ReactNode } from 'react';
import { ConnectionBanner } from './WebSocketProvider';
import { Outlet, Link, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Activity, GraduationCap, ListTodo, Users, Shield, ShieldCheck, CheckSquare, PlugZap, BarChart3, ScrollText, FolderGit, LogOut, DollarSign, Network, Cpu, Workflow, BrainCircuit, Gauge, BookUser, Brain, Menu, X, MessageSquare, Sparkles, SlidersHorizontal, Library } from 'lucide-react';
import { useAuthStore } from '../lib/auth-store';
import { OrganizationSelector } from './OrganizationSelector';
import { PendingApprovalsBanner } from './PendingApprovalsBanner';
import { usePendingApprovals } from '../hooks/usePendingApprovals';
import { api } from '../lib/api';
import { NAV_PERMISSIONS } from '../lib/permissions';


// W4 (2026-09-30): one operator's jobs, ≤ 20 top-level items; experimental or dormant pages live in a collapsed Lab.
// Page-view telemetry (S4, 28-30 Sep) decided what is top-level; Lab pages stay reachable, once each.
const NAV_SECTIONS: Array<{ title: string; lab?: boolean; items: Array<{ to: string; label: string; icon: LucideIcon }> }> = [
  { title: 'Operate', items: [
    { to: '/', label: 'Cockpit', icon: Activity },
    { to: '/decisions', label: 'Decisions', icon: CheckSquare },
    { to: '/goals-loops', label: 'Goals & Loops', icon: Workflow },
    { to: '/tasks', label: 'Tasks', icon: ListTodo },
    { to: '/repositories', label: 'Repositories', icon: FolderGit },
  ] },
  { title: 'Improve', items: [
    { to: '/improvement-funnel', label: 'Improvement funnel', icon: Gauge },
    { to: '/observability', label: 'Observability', icon: BarChart3 },
    { to: '/usage', label: 'Usage', icon: DollarSign },
  ] },
  { title: 'Knowledge', items: [
    { to: '/knowledge', label: 'Knowledge', icon: Library },
    { to: '/frontier-experts', label: 'Frontier Experts', icon: GraduationCap },
    { to: '/agent-commons', label: 'Agent Commons', icon: Sparkles },
  ] },
  { title: 'Fleet', items: [
    { to: '/fleet', label: 'Fleet hosts', icon: Network },
    { to: '/agents', label: 'Agents', icon: Users },
    { to: '/swarm-resources', label: 'Swarm Resources', icon: Network },
  ] },
  { title: 'Govern', items: [
    { to: '/policies', label: 'Policies', icon: Shield },
    { to: '/governance', label: 'Governance & Assurance', icon: ShieldCheck },
    { to: '/mcp-permissions', label: 'MCP Permissions', icon: PlugZap },
    { to: '/audit', label: 'Audit', icon: ScrollText },
    { to: '/authority', label: 'Authority ledger', icon: ShieldCheck },
    { to: '/configuration', label: 'Configuration', icon: SlidersHorizontal },
  ] },
  { title: 'Lab', lab: true, items: [
    { to: '/dashboard', label: 'Activity overview', icon: Activity },
    { to: '/swarm', label: 'Swarm', icon: Cpu },
    { to: '/fleet-cockpit', label: 'Fleet Cockpit', icon: Gauge },
    { to: '/swarm-mission-control', label: 'Swarm Mission Control', icon: BrainCircuit },
    { to: '/explainers', label: 'Repository explainers', icon: BookUser },
    { to: '/pipeline-builder', label: 'Pipeline drafts', icon: Workflow },
    { to: '/catalog', label: 'Agent Catalog', icon: BookUser },
    { to: '/interaction-board', label: 'Interaction Board', icon: MessageSquare },
    { to: '/self-driving', label: 'Self-Driving', icon: Activity },
    { to: '/cognitive', label: 'Cognitive', icon: Brain },
    { to: '/consensus-debates', label: 'Consensus debates', icon: MessageSquare },
    { to: '/agi-reasoning', label: 'Goal reasoning', icon: Brain },
    { to: '/predictive-analytics', label: 'Predictive analytics', icon: BarChart3 },
    { to: '/self-healing', label: 'Health checks', icon: Activity },
    { to: '/economy', label: 'Economy', icon: DollarSign },
    { to: '/federation', label: 'Federation', icon: Network },
  ] },
];

export function Layout() {
  const location = useLocation();
  const { user, logout, hasPermission } = useAuthStore();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => setMobileNavOpen(false), [location.pathname]);
  // S4: count page views locally (route path only, ids masked server-side) — which pages are used at all
  useEffect(() => {
    void api.request('/telemetry/pageview', { method: 'POST', body: JSON.stringify({ path: location.pathname }) }).catch(() => undefined);
  }, [location.pathname]);

  const pending = usePendingApprovals();
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '');
    document.title = pending.count > 0 ? `(${pending.count}) ${base}` : base;
    return () => { document.title = base; };
  }, [pending.count]);

  // The authority ledger is provisioned outside this repo; hide its nav entry where the server says it is absent.
  const [authorityAvailable, setAuthorityAvailable] = useState(true);
  useEffect(() => {
    let active = true;
    api.getAuthorityStats().catch((error: unknown) => {
      if (active && error instanceof Error && /not been provisioned|AUTHORITY_LEDGER_UNAVAILABLE/.test(error.message)) setAuthorityAvailable(false);
    });
    return () => { active = false; };
  }, []);
  
  const isActive = (path: string) => {
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };
  
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-background-secondary transition-transform md:static md:translate-x-0 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        {/* Logo */}
        <div className="flex items-start justify-between border-b border-border p-6">
           <div className="flex min-w-0 w-full flex-col gap-2">
             <div>
               <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                 <Activity className="w-6 h-6 text-accent" />
                 Djimitflo
               </h1>
               <p className="text-sm text-foreground-tertiary mt-1">
                 Agent Control Plane
               </p>
             </div>
             <div className="hidden md:block">
               <OrganizationSelector />
             </div>
           </div>
          <button type="button" aria-label="Close navigation" className="p-1 text-foreground-secondary md:hidden" onClick={() => setMobileNavOpen(false)}>
            <X className="h-5 w-5" />
          </button>
        </div>
        
        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-4" aria-label="Main">
          {NAV_SECTIONS.map((section) => {
            const links = (
              <div className="space-y-1">
                {section.items.filter((item) => (item.to !== '/authority' || authorityAvailable) && (!NAV_PERMISSIONS[item.to] || hasPermission(NAV_PERMISSIONS[item.to]))).map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    icon={<item.icon className="w-5 h-5" />}
                    label={item.label}
                    active={item.to === '/' ? location.pathname === '/' : isActive(item.to)}
                    badge={item.to === '/decisions' ? pending.count : undefined}
                  />
                ))}
              </div>
            );
            // Lab: native <details>, collapsed unless the current page lives in it (no state, no storage)
            return section.lab ? (
              <details key={section.title} className="mb-4" open={section.items.some((item) => isActive(item.to))}>
                <summary className="cursor-pointer px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-foreground-muted">{section.title} · experimental</summary>
                {links}
              </details>
            ) : (
              <div key={section.title} className="mb-4">
                <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-foreground-muted">{section.title}</div>
                {links}
              </div>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-border">
          {user && (
            <div className="mb-3 px-3 py-2 bg-background-elevated rounded-lg">
              <div className="text-sm font-medium text-foreground truncate">{user.email}</div>
              <div className="text-xs text-foreground-tertiary capitalize">{user.role}</div>
            </div>
          )}
          <button
            onClick={logout}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-foreground-secondary hover:bg-background-elevated hover:text-foreground transition-colors"
          >
            <LogOut className="w-5 h-5" />
            <span className="font-medium">Sign out</span>
          </button>
          <div className="mt-4 text-xs text-foreground-muted">
            v{import.meta.env.VITE_APP_VERSION} • {new Date().getFullYear()}
          </div>
        </div>
      </aside>
      
      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-border bg-background-secondary px-4 md:hidden">
          <button type="button" aria-label="Open navigation" className="p-2 text-foreground" onClick={() => setMobileNavOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <span className="ml-2 font-semibold text-foreground">Djimitflo</span>
        </header>
        {location.pathname !== '/decisions' && <PendingApprovalsBanner {...pending} />}
        <main className="min-w-0 flex-1 overflow-auto">
          <ConnectionBanner />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

interface NavLinkProps {
  to: string;
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: number;
}

function NavLink({ to, icon, label, active, badge }: NavLinkProps) {
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
      {badge ? <span aria-label={`${badge} pending`} className="ml-auto rounded-full bg-status-error px-2 py-0.5 text-xs font-semibold text-white">{badge}</span> : null}
    </Link>
  );
}
