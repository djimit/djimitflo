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

  constructor(configs: TelegramBotConfig[], ops: TelegramGatewayService['ops']) {
    this.configs = configs;
    this.ops = ops;
  }

  async startAll(): Promise<void> {
    const { Bot } = await import('grammy');

    for (const cfg of this.configs) {
      try {
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
        const msg = e?.description || e?.message || String(e);
        console.error(`❌ Bot ${cfg.name} init fout:`, msg);
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.bots.map(b => b.stop()));
    this.bots = [];
  }
}

