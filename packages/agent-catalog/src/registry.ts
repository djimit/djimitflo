import type { CatalogDB } from './db';
import { compile, type Target } from './compiler';

export class ActivationRegistry {
  constructor(private db: CatalogDB) {}

  activate(profileId: string, target: Target) {
    const profile = this.db.getProfile(profileId);
    if (!profile) throw new Error(`profile not found: ${profileId}`);
    const ev = this.db.getEvaluation(profileId);
    if (!ev) throw new Error('no evaluation record — activation blocked (no-active-without-eval)');
    if (ev.status !== 'passed') throw new Error(`evaluation not passed: ${ev.status}`);
    if (!target || !['openclaw', 'codex'].includes(target)) throw new Error(`activation target must be openclaw|codex (got ${target})`);
    const artifact = compile(profile, target);
    this.db.setActivation(profileId, 'active', target, JSON.stringify(artifact));
    this.db.audit(profileId, 'activate', JSON.stringify({ target, evaluation: ev.id }));
    return { profileId, status: 'active' as const, target, artifact };
  }

  deactivate(profileId: string) {
    const act = this.db.getActivation(profileId);
    if (!act) throw new Error(`no activation for ${profileId}`);
    this.db.setActivation(profileId, 'deactivated', null, null);
    this.db.audit(profileId, 'deactivate', JSON.stringify({ prior: act.status, target: act.target }));
    return { profileId, status: 'deactivated' as const };
  }

  status(profileId: string) {
    const act = this.db.getActivation(profileId);
    return act ? { profileId, status: act.status, target: act.target } : { profileId, status: 'draft' as const };
  }
}
