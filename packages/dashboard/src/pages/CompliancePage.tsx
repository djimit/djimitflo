import { SpecComplianceWidget } from '../components/SpecComplianceWidget';

export function CompliancePage() {
  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Assurance &amp; SDD Compliance</h1>
        <p className="text-foreground-secondary mt-2">Current Speckit and OpenSpec evidence, missing quality layers, and the next safe action.</p>
      </div>
      <SpecComplianceWidget controls />
    </div>
  );
}
