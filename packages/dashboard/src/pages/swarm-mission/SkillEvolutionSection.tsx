import { useEffect, useState } from 'react';
import { api, type SkillEvolutionReadiness } from '../../lib/api';

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const tone = ['routable', 'available', 'start', 'truth-gated', 'supported', 'validated'].includes(normalized)
    ? 'border-status-success/30 bg-status-success/10 text-status-success'
    : ['blocked', 'contradicted', 'review_required', 'skip', 'draft', 'candidate'].includes(normalized)
      ? 'border-status-warning/30 bg-status-warning/10 text-status-warning'
      : 'border-border bg-background-elevated text-foreground-secondary';
  return <span className={`rounded border px-2 py-1 text-xs font-medium ${tone}`}>{status}</span>;
}

type InventorySkill = { id: string; version: string; content_hash: string; source_tasks: string[] };
/** The page's action runner: sets the busy id, clears the error, runs the action, refreshes; a failure shows `failure`. */
export type SkillAction = (id: string, failure: string, action: () => Promise<unknown>) => Promise<void>;

const field = 'mt-1 block w-full rounded border border-border bg-background px-2 py-1 text-sm';

/** Skill Evolution Readiness: the existing promotion-gate evidence plus bounded instruction candidates, paired OpenMythos
 *  comparison and rollback (#1147). Every write goes through the server's gates; this section only collects inputs. */
export function SkillEvolutionSection({ skills, actionId, run }: { skills: SkillEvolutionReadiness[]; actionId: string | null; run: SkillAction }) {
  const [model, setModel] = useState('');
  const [caseIds, setCaseIds] = useState('');
  const [inventory, setInventory] = useState<InventorySkill[]>([]);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [inventoryVersion, setInventoryVersion] = useState(0);
  const [sourceId, setSourceId] = useState('');
  const [sourceTask, setSourceTask] = useState('');
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');

  useEffect(() => {
    api.getSkillEvolutionInventory()
      .then((result) => { setInventory(Array.isArray(result.skills) ? result.skills : []); setInventoryError(null); })
      .catch((err) => setInventoryError(err instanceof Error ? err.message : String(err)));
  }, [inventoryVersion]);

  const createCandidate = () => {
    const skill = inventory.find((item) => item.id === sourceId);
    if (!skill || !sourceTask || !find.trim() || !replace.trim()) return;
    void run('skill-candidate-create', 'Skill candidate creation failed', async () => {
      await api.createSkillEvolutionCandidate({ skill_id: skill.id, baseline_hash: skill.content_hash, source_task_id: sourceTask, find, replace });
      setFind(''); setReplace(''); setInventoryVersion((v) => v + 1);
    });
  };
  const pinnedCases = () => caseIds.split(',').map((value) => value.trim()).filter(Boolean);

  return (
    <section className="rounded-lg border border-border bg-background-secondary p-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Skill Evolution Readiness</h2>
        <p className="mt-1 text-sm text-foreground-secondary">Paired candidate checks are bound to exact skill hashes and pinned OpenMythos cases. Admission and the existing training gate still run during promotion.</p>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_2fr]">
        <label className="text-xs text-foreground-secondary">Declared model
          <input value={model} onChange={(event) => setModel(event.target.value)} className={field} placeholder="configured OpenMythos model" />
        </label>
        <label className="text-xs text-foreground-secondary">Pinned OpenMythos case IDs, comma separated
          <input value={caseIds} onChange={(event) => setCaseIds(event.target.value)} className={field} placeholder="case-001, case-002" />
        </label>
      </div>
      <button onClick={() => void run('skill-case-list', 'OpenMythos case manifest unavailable', async () => setCaseIds((await api.getOpenMythosCaseMetadata()).cases.map((item) => item.id).join(', ')))}
        disabled={actionId !== null} className="mt-2 rounded border border-border px-2 py-1 text-xs text-foreground-secondary disabled:opacity-50">
        Load IDs from the configured case manifest
      </button>
      {inventoryError && <p className="mt-2 text-xs text-status-warning">Skill inventory unavailable: {inventoryError}</p>}
      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <label className="text-xs text-foreground-secondary">Skill with a verified, delivered outcome
          <select value={sourceId} onChange={(event) => { setSourceId(event.target.value); setSourceTask(''); }} className={field}>
            <option value="">Select a skill</option>
            {inventory.filter((skill) => skill.source_tasks.length > 0).map((skill) => <option key={skill.id} value={skill.id}>{skill.id} · v{skill.version}</option>)}
          </select>
        </label>
        <label className="text-xs text-foreground-secondary">Source task
          <select value={sourceTask} onChange={(event) => setSourceTask(event.target.value)} className={field}>
            <option value="">Select a successful task</option>
            {inventory.find((skill) => skill.id === sourceId)?.source_tasks.map((taskId) => <option key={taskId} value={taskId}>{taskId}</option>)}
          </select>
        </label>
        <label className="text-xs text-foreground-secondary">Exact instruction text to replace
          <textarea value={find} onChange={(event) => setFind(event.target.value)} maxLength={2000} className={`${field} min-h-16`} />
        </label>
        <label className="text-xs text-foreground-secondary">Replacement instruction text
          <textarea value={replace} onChange={(event) => setReplace(event.target.value)} maxLength={2000} className={`${field} min-h-16`} />
        </label>
        <button onClick={createCandidate} disabled={actionId !== null || !sourceTask || !find.trim() || !replace.trim()}
          className="w-fit rounded border border-border px-3 py-2 text-sm text-foreground disabled:opacity-50">Create bounded candidate</button>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-foreground-tertiary">
            <tr>
              <th className="py-2 pr-4">Skill</th>
              <th className="py-2 pr-4">Assigned</th>
              <th className="py-2 pr-4">Candidate runs</th>
              <th className="py-2 pr-4">Baselines</th>
              <th className="py-2 pr-4">OpenMythos</th>
              <th className="py-2 pr-4">Paired comparison</th>
              <th className="py-2 pr-4">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => (
              <tr key={skill.capability_id} className="border-t border-border">
                <td className="py-2 pr-4">
                  <div className="font-medium text-foreground">{skill.skill_id || skill.capability_id}</div>
                  <div className="font-mono text-xs text-foreground-tertiary">v{skill.skill_version || '?'} · {skill.candidate_hash.slice(0, 12) || 'unattributed'}</div>
                </td>
                <td className="py-2 pr-4 text-foreground-secondary">{skill.assigned_agents}</td>
                <td className="py-2 pr-4 text-foreground-secondary">{skill.candidate_runs}</td>
                <td className="py-2 pr-4 text-foreground-secondary">{skill.baseline_hashes.length}</td>
                <td className="py-2 pr-4 font-mono text-xs text-foreground-secondary">{skill.openmythos_run_id || 'missing'}</td>
                <td className="py-2 pr-4 text-foreground-secondary">
                  <PairedComparison comparison={skill.candidate_comparison ?? null} />
                  {skill.artifact_lifecycle === 'active' && skill.candidate_id && <button
                    onClick={() => void run(`skill-rollback-${skill.candidate_id}`, 'Skill rollback failed', () => api.rollbackSkillEvolutionCandidate(skill.candidate_id!))}
                    disabled={actionId !== null}
                    className="mt-1 rounded border border-status-warning/40 px-2 py-1 text-xs text-status-warning disabled:opacity-50">
                    Roll back for new runs
                  </button>}
                  {skill.status === 'candidate' && skill.candidate_id && <button
                    onClick={() => void run(`skill-compare-${skill.candidate_id}`, 'Skill comparison failed', () => api.compareSkillEvolutionCandidate(skill.candidate_id!, model, pinnedCases()))}
                    disabled={actionId !== null || !model.trim() || !caseIds.trim()}
                    className="mt-1 rounded border border-border px-2 py-1 text-xs text-foreground-secondary disabled:opacity-50">
                    Run paired comparison
                  </button>}
                  {skill.status === 'candidate' && skill.evidence_ready && skill.promotion_input && <button
                    onClick={() => void run(`skill-promote-${skill.capability_id}`, 'Skill promotion was blocked', () => api.promoteSwarmCapability(skill.capability_id, skill.promotion_input!))}
                    disabled={actionId !== null}
                    className="mt-1 rounded border border-status-completed/40 px-2 py-1 text-xs text-status-completed disabled:opacity-50">
                    Submit to existing promotion gate
                  </button>}
                </td>
                <td className="py-2 pr-4">
                  <StatusBadge status={skill.evidence_ready ? 'ready' : 'blocked'} />
                  {!skill.evidence_ready && <div className="mt-1 max-w-xl text-xs text-status-warning">{skill.blocked_reasons.join(', ')}</div>}
                </td>
              </tr>
            ))}
            {!skills.length && <tr><td className="py-3 text-foreground-tertiary" colSpan={7}>No governed skill capabilities registered.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PairedComparison({ comparison }: { comparison: SkillEvolutionReadiness['candidate_comparison'] }) {
  if (!comparison) return <>not evaluated</>;
  return <>
    <StatusBadge status={comparison.verdict.toLowerCase()} />
    <div className="mt-1 text-xs">{comparison.baseline_score ?? '?'} → {comparison.candidate_score ?? '?'} · {comparison.reason}</div>
    <div className="text-xs">Run duration: {comparison.manifest?.baseline_run_ms ?? 'unknown'} ms → {comparison.manifest?.candidate_run_ms ?? 'unknown'} ms · cost: unknown</div>
    {comparison.candidate_eval_id && <div className="font-mono text-xs">{comparison.candidate_eval_id}</div>}
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer">Per-case evidence ({comparison.cases.length})</summary>
      <ul className="mt-1 max-h-40 overflow-auto">
        {comparison.cases.map((item) => <li key={item.case_id} className="font-mono">
          {item.case_id}: {item.baseline_score} → {item.candidate_score ?? '?'} · oracle {String(item.baseline_oracle_pass ?? '?')} → {String(item.candidate_oracle_pass ?? '?')} {item.oracle_regression ? '· REGRESSION' : ''}
        </li>)}
      </ul>
    </details>
  </>;
}
