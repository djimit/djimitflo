import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { AgentCommunicationService } from '../services/agent-communication-service';
import { AgentLureService } from '../services/agent-lure-service';
import { validateSpawnToken } from '../services/spawn-token';
import { createTestDb } from './helpers/test-db';

describe('agent commons lure (honeypot)', () => {
  let db: Database.Database;
  let comms: AgentCommunicationService;
  let lure: AgentLureService;
  let dir: string;
  const secret = 'test-lure-runtime-secret-with-enough-entropy';

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    dir = mkdtempSync(join(tmpdir(), 'lure-'));
    db = createTestDb();
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('present', 'Present', 'active'), ('silent', 'Silent', 'idle'), ('paused', 'Paused', 'paused')").run();
    comms = new AgentCommunicationService(db);
    comms.heartbeat('present', 'codex');
    lure = new AgentLureService(db, comms);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.JWT_SECRET;
  });

  it('invites only absent eligible agents, issues scoped tokens once and exports to Paperclip', () => {
    const pending = join(dir, 'pending.jsonl');
    const cast = lure.castLure({ by: 'operator@test', baseUrl: 'http://127.0.0.1:3001', paperclipPath: pending });
    expect(cast.lure.invited).toEqual(['silent']);
    expect(cast.invitations).toHaveLength(1);
    const [invitation] = cast.invitations;
    expect(validateSpawnToken(secret, invitation.token, 'silent', 'social-runtime')).toBe(true);
    expect(validateSpawnToken(secret, invitation.token, 'present', 'social-runtime')).toBe(false);
    expect(invitation.poller_env).toContain("DJIMITFLO_AGENT_ID='silent'");

    const [invite] = comms.receive('silent');
    expect(invite.payload.action).toBe('social.invite');
    expect(invite.payload.thread_id).toBe(cast.lure.id);
    expect(JSON.stringify(invite)).not.toContain(invitation.token);
    expect(comms.receiveSocial('silent')).toHaveLength(0);

    const exported = JSON.parse(readFileSync(pending, 'utf8').trim());
    expect(exported).toMatchObject({ event: 'social.invite', task_type: 'skill_candidate', dedupe_key: `agent-commons:${cast.lure.id}` });
    expect(JSON.stringify(exported)).not.toContain(invitation.token);

    let status = lure.status();
    expect(status.lures[0].invitees).toEqual([expect.objectContaining({ agent_id: 'silent', state: 'seen' })]);

    comms.heartbeat('silent', 'ollama', 'qwen');
    status = lure.status();
    expect(status.lures[0]).toMatchObject({ bites: 1, invitees: [expect.objectContaining({ agent_id: 'silent', state: 'bit' })] });
  });

  it('shell-quotes untrusted ids in the poller command and persists nothing when nobody is absent', () => {
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('evil;rm -rf /', 'Evil', 'active')").run();
    const cast = lure.castLure({ by: 'op', baseUrl: 'http://127.0.0.1:3001', paperclipPath: null });
    const evil = cast.invitations.find((invitation) => invitation.agent_id === 'evil;rm -rf /')!;
    expect(evil.poller_env).toContain("DJIMITFLO_AGENT_ID='evil;rm -rf /'");
    expect(evil.poller_env).toContain(`DJIMITFLO_SOCIAL_TOKEN='${evil.token}'`);
    comms.heartbeat('silent', 'codex');
    comms.heartbeat('evil;rm -rf /', 'codex');
    const empty = lure.castLure({ by: 'op', baseUrl: 'http://127.0.0.1:3001', paperclipPath: null });
    expect(empty.lure.invited).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM social_lures').get() as { n: number }).n).toBe(1);
    expect(lure.castIfQuiet({ by: 'loop', baseUrl: 'http://127.0.0.1:3001', paperclipPath: null })).toBeNull();
  });

  it('logs probes with a bounded history', () => {
    lure.recordProbe('intruder', '10.0.0.9', 'token_invalid');
    lure.recordProbe('', '', 'token_missing');
    const status = lure.status();
    expect(status.probe_count).toBe(2);
    expect(status.probes[0]).toMatchObject({ agent_id: expect.any(String), reason: expect.stringMatching(/token_/) });
    expect(status.probes.map((probe) => probe.agent_id)).toContain('unknown');
  });

  it('never lures loop workers, tells lapsed from never-connected agents, and baits with real open work (prod 2026-09-24)', () => {
    db.prepare("INSERT INTO agents (id, name, status, capabilities_json, metadata) VALUES ('maker-x', 'opencode-maker', 'active', '[\"opencode\",\"maker\"]', '{}'), ('lapsed', 'Lapsed', 'active', '[\"claude\"]', ?)")
      .run(JSON.stringify({ social_runtime: { enabled: true, runtime: 'claude', last_heartbeat_at: '2026-09-13T19:33:37.041Z' } }));
    db.prepare("INSERT INTO swarm_claims (id, claim, claim_type, subject_ref, predicate, status, created_from) VALUES ('g-h', 'Knowledge gap: Sparse claim inventory: 1 distinct normalized active statements', 'observation', 'd', 'gap', 'proposed', 'curiosity-service')").run();
    const cast = lure.castLure({ by: 'operator@test', baseUrl: 'http://x', paperclipPath: null });
    expect(cast.lure.invited.sort()).toEqual(['lapsed', 'silent']);          // no loop worker
    expect(cast.lure.topic).not.toContain('Sparse claim inventory');        // heuristic gap is not bait
    const invitees = lure.status().lures[0].invitees;
    expect(Object.fromEntries(invitees.map((i) => [i.agent_id, i.reach]))).toEqual({ lapsed: 'lapsed', silent: 'never' });
  });

  it('the autonomous lure only invites agents that were connected before', () => {
    db.prepare("INSERT INTO agents (id, name, status, metadata) VALUES ('lapsed', 'Lapsed', 'active', ?)")
      .run(JSON.stringify({ social_runtime: { enabled: true, last_heartbeat_at: '2026-09-13T19:33:37.041Z' } }));
    expect(lure.castIfQuiet({ by: 'loop', baseUrl: 'http://x', paperclipPath: null })?.lure.invited).toEqual(['lapsed']);
  });
});
