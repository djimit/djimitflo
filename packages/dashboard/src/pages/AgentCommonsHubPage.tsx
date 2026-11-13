import { TabbedPage } from '../components/TabbedPage';
import { AgentCommonsPage } from './AgentCommonsPage';
import { InteractionBoardPage } from './InteractionBoardPage';

/** Nav cut (UX-30): the Lab's Interaction Board is the full interaction ledger behind the Commons conversations. */
export function AgentCommonsHubPage() {
  return <TabbedPage title="Agent Commons" tabs={[
    { id: 'commons', label: 'Commons', element: <AgentCommonsPage /> },
    { id: 'interactions', label: 'Interaction board', element: <InteractionBoardPage /> },
  ]} />;
}
