/**
 * Route inventory + OpenAPI 3.1 skeleton, derived from the aggregator's
 * declarative mount table (routes/index.ts). Express 5 hides mount prefixes
 * inside matcher closures, so the prefixes come from the table, and the
 * per-router paths/methods come from each subrouter's own stack.
 *
 * ponytail: paths + methods + auth flag only — no request/response schemas.
 * Upgrade path: attach zod schemas per route and render them here when a
 * consumer needs typed clients rather than an endpoint map.
 */

import type { RequestHandler, Router } from 'express';

export interface RouteMount {
  prefix: string;
  middleware: RequestHandler[];
  router: Router;
}

export interface RouteEntry {
  method: string;
  path: string;
  authenticated: boolean;
}

function joinPath(...parts: string[]): string {
  const joined = parts.join('/').replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/** ':param' → '{param}' for OpenAPI path templates. */
function toOpenApiPath(path: string): string {
  return path.split('/').map((seg) => (seg.startsWith(':') ? `{${seg.slice(1)}}` : seg)).join('/');
}

export function collectRoutes(mounts: RouteMount[], basePath = '/api'): RouteEntry[] {
  const entries: RouteEntry[] = [];
  for (const mount of mounts) {
    const authenticated = mount.middleware.length > 0;
    const stack: Array<{ route?: { path: string | string[]; methods: Record<string, boolean> } }> =
      (mount.router as unknown as { stack?: never[] }).stack ?? [];
    for (const layer of stack) {
      if (!layer.route) continue; // plain middleware; current factories don't nest routers
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          entries.push({ method: method.toUpperCase(), path: joinPath(basePath, mount.prefix, path), authenticated });
        }
      }
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function buildOpenApiSpec(entries: RouteEntry[], info: { title: string; version: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const path = toOpenApiPath(entry.path);
    paths[path] ??= {};
    paths[path][entry.method.toLowerCase()] = {
      summary: `${entry.method} ${entry.path}`,
      ...(entry.authenticated ? { security: [{ bearerAuth: [] }] } : {}),
      responses: { '200': { description: 'Success' } },
    };
  }
  return {
    openapi: '3.1.0',
    info,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    paths,
  };
}
