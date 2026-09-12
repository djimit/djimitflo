import type { AuthService } from './auth-service';
import { AuthorizationService } from './authorization-service';

/** Telegram is an authenticated API client, not another task/approval writer. */
export class TelegramApiService {
  constructor(private auth: AuthService, private baseUrl: string) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('TELEGRAM_API_MUST_BE_LOCAL');
    }
  }

  requireActor(ref: string, permission?: string) {
    const user = this.auth.findUserById(ref) || this.auth.findUserByEmail(ref);
    if (!user?.isActive) throw new Error('AUTH_DISABLED_OR_UNLINKED');
    if (permission && !AuthorizationService.hasPermission(user.role, permission)) throw new Error('FORBIDDEN');
    return user;
  }

  async request<T = any>(actor: string, route: string, method = 'GET', body?: unknown): Promise<T> {
    const user = this.requireActor(actor);
    const response = await fetch(`${this.baseUrl}${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.auth.generateToken(user)}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as any;
    if (!response.ok) throw new Error(data.error?.code || `DJIMFLO_API_HTTP_${response.status}`);
    return data as T;
  }

  createTask = async (prompt: string, machineId: string, actor: string): Promise<string> => {
    const task = await this.request(actor, '/tasks', 'POST', { title: prompt.slice(0, 120), description: prompt,
      execution_mode: 'local', use_swarm_context: false, tags: ['telegram'], metadata: { source: 'telegram', machineId } });
    return task.id;
  };

  getStatus = async (machineId: string, actor: string): Promise<string> => {
    const data = await this.request(actor, '/tasks');
    const active = data.tasks.filter((task: any) => task.metadata?.machineId === machineId && ['pending', 'queued', 'running'].includes(task.status));
    return `Machine ${machineId}: ${active.length} zichtbare actieve/pending tasks.`;
  };

  cancelTask = async (taskId: string, actor: string): Promise<void> => {
    await this.request(actor, `/tasks/${encodeURIComponent(taskId)}/cancel`, 'POST');
  };
}
