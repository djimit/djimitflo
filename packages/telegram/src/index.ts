import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentType = 'hermes' | 'openclaw' | 'deerflow' | 'overwatch' | 'djimitnl';

export type TelegramBotConfig = {
  token: string;
  machineId: string;
  agentType: AgentType;
  hostIp: string;
  name: string;
};

export class TelegramGatewayService {
  private configs: TelegramBotConfig[];
  private ops: {
    createTask: (prompt: string, machineId: string) => Promise<string>;
    getStatus: (machineId: string) => Promise<string>;
  };
  private bots: any[] = [];
  private leases: string[] = [];
  private leaseDir: string;
  private leaseTtlMs = 120_000; // 2 min; heartbeat ververs mtime elke 30s
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(configs: TelegramBotConfig[], ops: TelegramGatewayService['ops'], options: { leaseDir?: string } = {}) {
    this.configs = configs;
    this.ops = ops;
    this.leaseDir = options.leaseDir || process.env.DJIMIT_TELEGRAM_LEASE_DIR || path.join(os.tmpdir(), 'djimit-telegram-leases');
  }

  /** Refresh lease mtimes so a live owner never looks expired. */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const lease of this.leases) {
        try { const now = new Date(); fs.utimesSync(lease, now, now); } catch {}
      }
    }, 30_000);
    this.heartbeatTimer.unref();
  }

  private acquireLease(cfg: TelegramBotConfig): string | null {
    fs.mkdirSync(this.leaseDir, { recursive: true });
    const tokenHash = crypto.createHash('sha256').update(cfg.token).digest('hex').slice(0, 16);
    const leasePath = path.join(this.leaseDir, `${tokenHash}.lock`);
    const leasePayload = JSON.stringify({
      machineId: cfg.machineId,
      name: cfg.name,
      hostId: this.hostId(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    try {
      const fd = fs.openSync(leasePath, 'wx');
      fs.writeFileSync(fd, leasePayload);
      fs.closeSync(fd);
      this.leases.push(leasePath);
      return leasePath;
    } catch (e: any) {
      if (e?.code === 'EEXIST') {
        // Stale-owner recovery: a lease from an abnormal exit survives on the
        // lease dir. Host-qualified ownership: only a dead owner on THIS host
        // can be taken over by pid-probe (Kilo P1: pid namespaces differ across
        // hosts, so a pid we cannot see says nothing about a remote owner).
        try {
          const owner = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as { pid?: number; hostId?: string };
          const sameHost = !owner.hostId || owner.hostId === this.hostId();
          if (sameHost && owner.pid && owner.pid !== process.pid && !this.pidAlive(owner.pid)) {
            fs.unlinkSync(leasePath);
            return this.acquireLease(cfg);
          }
        } catch { /* unreadable JSON: fall through to mtime expiry below */ }
        // Expired lease takeover: a lease whose heartbeat is older than TTL
        // is stale regardless of host or readability (Kilo P2: a truncated
        // lease from a crashed writer must not disable polling forever).
        const stat = fs.statSync(leasePath);
        if (Date.now() - stat.mtimeMs > this.leaseTtlMs) {
          fs.unlinkSync(leasePath);
          return this.acquireLease(cfg);
        }
        return null;
      }
      throw e;
    }
  }

  private hostId(): string {
    return crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 12);
  }

  private pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  private releaseLeases(): void {
    for (const lease of this.leases.splice(0)) {
      try { fs.unlinkSync(lease); } catch {}
    }
  }

  async startAll(): Promise<void> {
    const { Bot } = await import('grammy');

    for (const cfg of this.configs) {
      let leasePath: string | null = null;
      try {
        leasePath = this.acquireLease(cfg);
        if (!leasePath) {
          // Overlapping restart (Kilo P1): a live owner may release its lease
          // shortly after. Retry with backoff instead of skipping forever.
          for (const delayMs of [2_000, 5_000, 15_000, 30_000, 60_000]) {
            await new Promise((r) => setTimeout(r, delayMs));
            leasePath = this.acquireLease(cfg);
            if (leasePath) {
              console.log(`Bot ${cfg.name}: lease overgenomen na retry (${delayMs / 1000}s)`);
              break;
            }
          }
        }
        if (!leasePath) {
          console.warn(`Bot ${cfg.name}: lease bestaat al na retries — skip polling`);
          continue;
        }
        const bot = new Bot(cfg.token);

        bot.command('start', (ctx: any) => ctx.reply(`Bot ${cfg.name} actief voor ${cfg.machineId} (${cfg.agentType}). Gebruik /task, /status.`));

        bot.command('status', async (ctx: any) => {
          try {
            const s = await this.ops.getStatus(cfg.machineId);
            await ctx.reply(s);
          } catch (e: any) {
            await ctx.reply(`Status fout: ${e?.message || e}`);
          }
        });

        bot.command('task', async (ctx: any) => {
          const text = (ctx?.message?.text || '').replace(/^\/task\s*/, '');
          if (!text) return ctx.reply('Gebruik: /task <beschrijving>');
          try {
            const id = await this.ops.createTask(text, cfg.machineId);
            await ctx.reply(`Task aangemaakt: ${id}`);
          } catch (e: any) {
            await ctx.reply(`Task fout: ${e?.message || e}`);
          }
        });

        bot.catch((err: any) => {
          const msg = err?.error?.description || err?.message || String(err);
          if (msg.includes('409') || msg.includes('Conflict')) {
            console.warn(`⚠️ Bot ${cfg.name}: 409 conflict — andere instantie actief, skip polling`);
          } else {
            console.error(`❌ Bot ${cfg.name} fout:`, msg);
          }
        });

        bot.start({
          allowed_updates: ['message'],
          onStart: (info: any) => console.log(`🤖 Telegram bot gestart: ${cfg.name} (${cfg.machineId}) als @${info.username}`),
        }).catch((e: any) => {
          const msg = e?.description || e?.message || String(e);
          if (msg.includes('409') || msg.includes('Conflict')) {
            console.warn(`⚠️ Bot ${cfg.name}: 409 conflict — andere instantie actief, gestopt`);
          } else {
            console.error(`❌ Bot ${cfg.name} converged fout:`, msg);
          }
        });
        this.bots.push(bot);
      } catch (e: any) {
        if (leasePath) {
          try { fs.unlinkSync(leasePath); } catch {}
          this.leases = this.leases.filter((lease) => lease !== leasePath);
        }
        const msg = e?.description || e?.message || String(e);
        console.error(`❌ Bot ${cfg.name} init fout:`, msg);
      }
    }
    if (this.leases.length > 0) this.startHeartbeat();
  }

  async stopAll(): Promise<void> {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    await Promise.allSettled(this.bots.map(b => b.stop()));
    this.bots = [];
    this.releaseLeases();
  }
}
