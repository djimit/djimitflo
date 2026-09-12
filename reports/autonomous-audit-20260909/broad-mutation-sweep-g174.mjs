import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { schema, explainerSchema } from '../../packages/server/dist/database/schema.js';
import { runMigrations } from '../../packages/server/dist/database/migrate.js';
import { AuthService } from '../../packages/server/dist/services/auth-service.js';
import { createAuthMiddleware } from '../../packages/server/dist/middleware/auth.js';
import { createRoutes } from '../../packages/server/dist/routes/index.js';
import { errorHandler } from '../../packages/server/dist/middleware/error-handler.js';
import { UserRole } from '../../packages/shared/dist/index.js';
import inventory from './evidence/contract-inventory-g186.json' with { type: 'json' };

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(schema);
db.exec(explainerSchema);
runMigrations(db);
const authService = new AuthService(db);
const user = authService.createUser('g174-admin@example.test', 'Disposable-fixture-password-123!', UserRole.ADMIN);
const auth = createAuthMiddleware(authService);
const app = express().use(express.json()).use('/api', createRoutes(db, undefined, authService, auth)).use(errorHandler);
const token = authService.generateToken(user);
const routes = inventory.routes.items.filter(route => !['GET', 'HEAD', 'OPTIONS'].includes(route.method) && route.mounted_paths?.length);
const substitute = path => path.replace(/:[A-Za-z0-9_]+/g, 'g186-missing-fixture-id');
const results = [];
for (const route of routes) {
  const path = substitute(route.mounted_paths[0]);
  const method = route.method.toLowerCase();
  const response = await request(app)[method](path).set('Authorization', `Bearer ${token}`).send({});
  results.push({ method: route.method, path, source: route.id, status: response.status, code: response.body?.error?.code ?? null });
}
const byStatus = Object.groupBy(results, result => String(result.status));
console.log(JSON.stringify({ total: results.length, by_status: Object.fromEntries(Object.entries(byStatus).map(([status, rows]) => [status, rows.length])), server_errors: results.filter(result => result.status >= 500), empty_successes: results.filter(result => result.status >= 200 && result.status < 300) }, null, 2));
db.close();
process.exit(0);
