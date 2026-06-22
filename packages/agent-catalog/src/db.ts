import Database from 'better-sqlite3';

const MIGRATION = `
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  division TEXT NOT NULL,
  source_repo TEXT NOT NULL,
  source_path TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  version_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','passed','rejected')),
  schema_valid INTEGER NOT NULL,
  overlap_score REAL NOT NULL,
  injection_score INTEGER NOT NULL,
  risk_level TEXT NOT NULL,
  flags TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (profile_id, version_hash)
);
CREATE TABLE IF NOT EXISTS activations (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  status TEXT NOT NULL CHECK (status IN ('draft','active','rejected','deactivated')),
  target TEXT,
  compiled_artifact TEXT,
  activated_at TEXT,
  deactivated_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS overlaps (
  a TEXT NOT NULL REFERENCES profiles(id),
  b TEXT NOT NULL REFERENCES profiles(id),
  score REAL NOT NULL,
  PRIMARY KEY (a, b)
);
`;

export interface Profile {
  id: string; name: string; division: string; description?: string;
  source_repo: string; source_path: string; version_hash: string;
  persona: string; mission: string;
  rules: string[]; workflows: string[]; deliverables: string[];
  success_metrics: string[]; memory_policy: string;
  tools_required: string[]; runtime_targets: string[];
  risk_profile: { level: string; injection_score: number; overlap_score: number; flags: string[] };
  evaluation_status: 'pending' | 'passed' | 'rejected';
  activation_status: 'draft' | 'active' | 'rejected' | 'deactivated';
}

export interface Evaluation {
  profile_id: string; schema_valid: boolean; schema_errors: string[];
  injection_score: number; injection_flags: string[];
  overlap_score: number; overlap_with: string | null; overlaps: { id: string; score: number }[];
  risk_level: string; flags: string[]; status: 'pending' | 'passed' | 'rejected';
}

export class CatalogDB {
  private db: Database.Database;
  constructor(path = ':memory:') { this.db = new Database(path); this.db.exec(MIGRATION); }
  close() { this.db.close(); }

  upsertProfile(p: Profile) {
    this.db.prepare(
      `INSERT INTO profiles(id,name,division,source_repo,source_path,version_hash,document)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, division=excluded.division,
         source_repo=excluded.source_repo, source_path=excluded.source_path,
         version_hash=excluded.version_hash, document=excluded.document`
    ).run(p.id, p.name, p.division, p.source_repo, p.source_path, p.version_hash, JSON.stringify(p));
  }
  getProfile(id: string): Profile | null {
    const row: any = this.db.prepare('SELECT document FROM profiles WHERE id=?').get(id);
    return row ? JSON.parse(row.document) : null;
  }
  listProfiles(): Profile[] {
    return (this.db.prepare('SELECT document FROM profiles ORDER BY name').all() as any[])
      .map(r => JSON.parse(r.document));
  }
  setEvaluation(ev: Evaluation, versionHash: string) {
    const id = `${ev.profile_id}:${versionHash}`;
    this.db.prepare(
      `INSERT INTO evaluations(id,profile_id,version_hash,status,schema_valid,overlap_score,injection_score,risk_level,flags)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status, schema_valid=excluded.schema_valid,
         overlap_score=excluded.overlap_score, injection_score=excluded.injection_score,
         risk_level=excluded.risk_level, flags=excluded.flags`
    ).run(id, ev.profile_id, versionHash, ev.status, ev.schema_valid ? 1 : 0, ev.overlap_score, ev.injection_score, ev.risk_level, JSON.stringify(ev.flags));
  }
  getEvaluation(profileId: string): any {
    const row: any = this.db.prepare('SELECT * FROM evaluations WHERE profile_id=? ORDER BY created_at DESC LIMIT 1').get(profileId);
    if (!row) return null;
    return { ...row, flags: JSON.parse(row.flags), schema_valid: !!row.schema_valid };
  }
  setActivation(profileId: string, status: string, target: string | null, artifact: string | null) {
    const now = new Date().toISOString();
    if (status === 'active') {
      this.db.prepare(
        `INSERT INTO activations(profile_id,status,target,compiled_artifact,activated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(profile_id) DO UPDATE SET status=excluded.status, target=excluded.target,
           compiled_artifact=excluded.compiled_artifact, activated_at=excluded.activated_at, deactivated_at=NULL`
      ).run(profileId, status, target, artifact, now);
    } else {
      this.db.prepare(
        `INSERT INTO activations(profile_id,status) VALUES(?,?)
         ON CONFLICT(profile_id) DO UPDATE SET status=excluded.status, deactivated_at=?`
      ).run(profileId, status, now);
    }
  }
  getActivation(profileId: string): any {
    return this.db.prepare('SELECT * FROM activations WHERE profile_id=?').get(profileId) || null;
  }
  audit(profileId: string, action: string, detail: string) {
    this.db.prepare('INSERT INTO audit_ledger(profile_id,action,detail) VALUES(?,?,?)').run(profileId, action, detail);
  }
  setOverlap(a: string, b: string, score: number) {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.db.prepare('INSERT OR REPLACE INTO overlaps(a,b,score) VALUES(?,?,?)').run(x, y, score);
  }
  counts() {
    const q = (s: string) => (this.db.prepare(s).get() as any).n;
    return {
      total: q('SELECT COUNT(*) n FROM profiles'),
      evaluated: q('SELECT COUNT(DISTINCT profile_id) n FROM evaluations'),
      passed: q("SELECT COUNT(DISTINCT profile_id) n FROM evaluations WHERE status='passed'"),
      active: q("SELECT COUNT(*) n FROM activations WHERE status='active'"),
      duplicate: q('SELECT COUNT(*) n FROM overlaps WHERE score>=0.85'),
      rejected: q("SELECT COUNT(DISTINCT profile_id) n FROM evaluations WHERE status='rejected'"),
    };
  }
}
