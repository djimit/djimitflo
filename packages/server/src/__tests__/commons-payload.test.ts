import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../database/schema';
import { runMigrations } from '../database/migrate';
import { AgentCommunicationService } from '../services/agent-communication-service';

describe('listSocialCommons payload', () => {
  let db: Database.Database;
  let comms: AgentCommunicationService;
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec(schema); runMigrations(db); comms = new AgentCommunicationService(db); });
  afterEach(() => db.close());

  const question = (thread: string, context: string) => comms.send({
    from: 'a', to: 'b', type: 'question', action: 'social.question', context, evidence: ['e'], threadId: `social:${thread}`,
    epistemicRole: 'question', ttl: 86_400, params: { topic: thread, topic_ref: `topic:${thread}` },
  });

  it('loads only the newest threads, reports the total, and clips long text', () => {
    question('one', 'first'); question('two', 'second'); question('three', 'x'.repeat(5_000));
    const commons = comms.listSocialCommons(2);
    expect(commons.total_threads).toBe(3);
    expect(commons.threads).toHaveLength(2);
    const long = commons.threads.flatMap((t) => t.messages).find((m) => m.text.length > 100)!;
    expect(long.text.length).toBeLessThanOrEqual(501);
    expect(long.text.endsWith('…')).toBe(true);
  });
});
