import { TabbedPage } from '../components/TabbedPage';
import { AuditPage } from './AuditPage';
import { AuditLogViewer } from './AuditLogViewer';

/** Audit trail and audit log viewer were two pages (the second hidden in a collapsed menu) for one subject. */
export function AuditHubPage() {
  return <TabbedPage tabs={[
    { id: 'trail', label: 'Trail', element: <AuditPage /> },
    { id: 'logs', label: 'Log viewer', element: <AuditLogViewer /> },
  ]} />;
}
