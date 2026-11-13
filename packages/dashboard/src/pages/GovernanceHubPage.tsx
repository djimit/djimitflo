import { TabbedPage } from '../components/TabbedPage';
import { GovernanceScorecardPage } from './GovernanceScorecardPage';
import { CompliancePage } from './CompliancePage';
import { SwarmGovernanceSection } from './SwarmResourcesSections';

/** Governance scorecard and Assurance & SDD were two menu items for one subject; the nav cut adds the swarm mutation gate and panels. */
export function GovernanceHubPage() {
  return <TabbedPage title="Governance & Assurance" tabs={[
    { id: 'scorecard', label: 'Scorecard', element: <GovernanceScorecardPage /> },
    { id: 'assurance', label: 'Assurance & SDD', element: <CompliancePage /> },
    { id: 'swarm', label: 'Swarm safety & panels', element: <SwarmGovernanceSection /> },
  ]} />;
}
