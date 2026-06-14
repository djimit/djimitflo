// TelegramGatewayService scaffold — grammy will be added after approval to install deps
export type TelegramBotConfig = {
  token: string;
  machineId: string;
  agentType: 'hermes' | 'openclaw' | 'deerflow';
  hostIp: string;
  name: string;
};

export class TelegramGatewayService {
  private configs: TelegramBotConfig[];
  private ops: {
    createTask: (prompt: string, machineId: string) => Promise<string>;
    getStatus: (machineId: string) => Promise<string>;
  };

  constructor(configs: TelegramBotConfig[], ops: TelegramGatewayService['ops']) {
    this.configs = configs;
    this.ops = ops;
  }

  startAll(): void {
    // Lazy import grammy to avoid hard dependency at load time
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Bot } = require('grammy');
    for (const cfg of this.configs) {
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

      bot.start({ allowed_updates: ['message'] });
      console.log(`🤖 Telegram bot gestart: ${cfg.name} (${cfg.machineId})`);
    }
  }
}

