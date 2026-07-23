/**
 * Djimitflo Server
 * Express + TypeScript + SQLite backend for agent orchestration control plane.
 * 
 * Bootstrap modules handle service initialization.
 * This file is the entry point — it wires modules together.
 */
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { createRoutes } from './routes';
import { errorHandler } from './middleware/error-handler';
import { requestLogger } from './middleware/request-logger';
import { lifecycleManager } from './services/lifecycle-manager';
import { resolveRuntimeProfile, runtimeProfileEnablesAutonomy, runtimeProfileEnablesOperator } from './config/runtime-profile';
import { PORT, HOST, logRansomwareStatus, ensureControlUrl } from './bootstrap/constants';
import { initDatabase, recoverInterruptedRuns } from './bootstrap/recovery';
import { initAutonomousServices } from './bootstrap/autonomous-services';
import { initOperatorServices } from './bootstrap/operator-services';
import { initCoreServices } from './bootstrap/core-services';

type TelegramBotConfig = { token: string; machineId: string; agentType: string; hostIp: string; name: string };

async function main() {
  console.log('🚀 Starting Djimitflo Server...');
  ensureControlUrl();
  logRansomwareStatus();

  const runtimeProfile = resolveRuntimeProfile();
  const operatorRuntime = runtimeProfileEnablesOperator(runtimeProfile);
  const autonomousRuntime = runtimeProfileEnablesAutonomy(runtimeProfile);
  console.log(`🧭 Runtime profile: ${runtimeProfile}`);

  // Database + recovery
  const db = initDatabase();
  const recoverySvc = recoverInterruptedRuns(db);
  new (await import('./services/self-model-service')).SelfModelService(db);

  // Autonomous services
  if (autonomousRuntime) {
    initAutonomousServices(db, recoverySvc);
  } else {
    console.log('⏸️  Autonomous services disabled by runtime profile');
  }

  // Operator services
  if (operatorRuntime) {
    initOperatorServices(db);
  }

  // Core services (always)
  const app = express();
  app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  }));
  app.use(express.json());
  app.use(requestLogger);

  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime() });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const core = initCoreServices(db, app, wss, autonomousRuntime, operatorRuntime);

  // API routes
  app.use('/api', createRoutes(db, core.executionEngine, core.authService, core.auth, core.wsService, core.metaOrchestration, operatorRuntime));

  // Telegram gateway
  await initTelegram(db, operatorRuntime);

  // Heartbeat window
  scheduleHeartbeat();

  // Static dashboard
  serveDashboard(app);

  // Error handler + start
  app.use(errorHandler);
  httpServer.listen(Number(PORT), HOST as string, () => {
    console.log(`✅ Djimitflo Server running on http://${HOST}:${PORT}`);
    console.log(`🔌 WebSocket server running on ws://${HOST}:${PORT}/ws`);
  });

  lifecycleManager.initSignalHandlers(httpServer);
}

async function initTelegram(db: any, operatorRuntime: boolean): Promise<void> {
  try {
    const raw = process.env.TELEGRAM_BOTS_CONFIG;
    if (!raw || !operatorRuntime) {
      if (raw) console.log('ℹ️ TELEGRAM_BOTS_CONFIG gezet, maar gateway uitgeschakeld door runtime profile');
      else console.log('ℹ️ TELEGRAM_BOTS_CONFIG niet gezet — gateway uitgeschakeld');
      return;
    }
    const configs = JSON.parse(raw) as TelegramBotConfig[];
    const { TelegramGatewayService } = await import('@djimitflo/telegram') as { TelegramGatewayService: new (c: TelegramBotConfig[], ops: any) => any };
    const tg = new TelegramGatewayService(configs, {
      createTask: async (prompt: string, machineId: string) => {
        const id = randomUUID();
        db.prepare(
          `INSERT INTO tasks (id, title, description, status, priority, risk_level, execution_mode, created_at, updated_at, created_by) VALUES (?, ?, ?, 'pending', 'medium', 'low', 'local', datetime('now'), datetime('now'), ?)`
        ).run(id, prompt.slice(0, 80) || 'Telegram Task', prompt, machineId);
        return id;
      },
      getStatus: async (machineId: string) => {
        const count = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('pending','queued','running') AND created_by = ?").get(machineId) as any).c;
        const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(machineId) as any;
        return `Machine ${machineId}: ${count} actieve/pending tasks. Status: ${agent?.status || 'unknown'}`;
      },
    });
    tg.startAll().catch((e: any) => console.warn('⚠️ Telegram startAll fout:', e?.message || e));
  } catch (e) {
    console.warn('⚠️ Telegram gateway init fout:', e);
  }
}

function scheduleHeartbeat(): void {
  try {
    const jitterMinutes = Math.floor(Math.random() * 180);
    const targetHour = 3 + Math.floor(jitterMinutes / 60);
    const targetMinute = jitterMinutes % 60;
    console.log(`🫀 Heartbeat window scheduled daily at ~${targetHour.toString().padStart(2, '0')}:${targetMinute.toString().padStart(2, '0')}`);
  } catch {}
}

function serveDashboard(app: import('express').Express): void {
  const dashboardPath = process.env.DASHBOARD_PATH || join(__dirname, '../../dashboard/dist');
  const serveDashboard = process.env.DASHBOARD_SERVE_ENABLED !== 'false';
  if (!serveDashboard) {
    console.log('📱 Dashboard serving disabled — running in API-only mode');
    return;
  }
  if (!existsSync(dashboardPath)) {
    console.log('📱 Dashboard not found at', dashboardPath, '— running in API-only mode');
    return;
  }
  console.log(`🖥️  Serving dashboard from ${dashboardPath}`);
  app.use(express.static(dashboardPath));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path === '/health') return next();
    const acceptHeader = req.headers.accept || '';
    if (req.method === 'GET' && acceptHeader.includes('text/html')) {
      res.sendFile(join(dashboardPath, 'index.html'), (err) => { if (err) next(err); });
      return;
    }
    next();
  });
}

main().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
