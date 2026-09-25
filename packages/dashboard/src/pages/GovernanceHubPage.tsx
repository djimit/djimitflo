import { TabbedPage } from '../components/TabbedPage';
import { GovernanceScorecardPage } from './GovernanceScorecardPage';
import { CompliancePage } from './CompliancePage';

/** Governance scorecard and Assurance & SDD were two menu items for one subject. */
export function GovernanceHubPage() {
  return <TabbedPage tabs={[
    { id: 'scorecard', label: 'Scorecard', element: <GovernanceScorecardPage /> },
    { id: 'assurance', label: 'Assurance & SDD', element: <CompliancePage /> },
  ]} />;
}
