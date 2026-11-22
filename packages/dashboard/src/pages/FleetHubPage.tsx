import { TabbedPage } from '../components/TabbedPage';
import { FleetHostsPage } from './FleetHostsPage';
import { FleetCockpitPage } from './FleetCockpitPage';

/** Nav cut (UX-30): Fleet hosts and the Lab's Fleet Cockpit (worker pool) were two menu items for one fleet. */
export function FleetHubPage() {
  return <TabbedPage title="Fleet" tabs={[
    { id: 'hosts', label: 'Hosts', element: <FleetHostsPage /> },
    { id: 'workers', label: 'Worker pool', element: <FleetCockpitPage /> },
  ]} />;
}
