import { SpecComplianceWidget } from '../components/SpecComplianceWidget';
import { ImprovementInbox } from '../components/ImprovementInbox';

export function CompliancePage() {
  return (
    <div className="p-8 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">Assurance &amp; SDD Compliance</h2>
        <p className="text-foreground-secondary mt-2">Current Speckit and OpenSpec evidence, missing quality layers, and the next safe action.</p>
      </div>
      <ImprovementInbox />
      <SpecComplianceWidget controls />
    </div>
  );
}
