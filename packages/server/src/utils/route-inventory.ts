/**
 * Route inventory + OpenAPI 3.1 skeleton, derived from the aggregator's
 * actual router stack. Express 5 hides mount prefixes inside matcher closures;
 * mountRoutes records them on the actual layers created by router.use.
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

type Handler = RequestHandler & { requiresAuth?: boolean; stack?: Layer[] };
interface Layer {
  handle?: Handler;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack?: Layer[] };
}
const mountedLayers = new WeakMap<Layer, { prefix: string; authenticated: boolean }>();
const stackOf = (router: Router): Layer[] => (router as unknown as { stack: Layer[] }).stack;
const requiresAuth = (handler?: Handler): boolean => handler?.requiresAuth === true;

/** Register normally, retaining only metadata Express otherwise hides. */
export function mountRoutes(router: Router, mounts: RouteMount[]): void {
  for (const mount of mounts) {
    router.use(mount.prefix, ...mount.middleware, mount.router);
    const layer = stackOf(router).at(-1)!;
    mountedLayers.set(layer, {
      prefix: mount.prefix,
      authenticated: mount.middleware.some(requiresAuth),
    });
  }
}

function joinPath(...parts: string[]): string {
  const joined = parts.join('/').replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/** ':param' → '{param}' for OpenAPI path templates. */
function toOpenApiPath(path: string): string {
  return path.split('/').map((seg) => (seg.startsWith(':') ? `{${seg.slice(1)}}` : seg)).join('/');
}

export function collectRoutes(input: RouteMount[] | Router, basePath = '/api'): RouteEntry[] {
  const entries: RouteEntry[] = [];
  function walk(stack: Layer[], prefix: string, inheritedAuth: boolean): void {
    for (const layer of stack) {
      if (!layer.route) {
        if (layer.handle?.stack) {
          const mount = mountedLayers.get(layer);
          if (!mount) throw new Error(`Route inventory incomplete: unrecorded nested router at ${prefix}`);
          walk(layer.handle.stack, joinPath(prefix, mount.prefix), inheritedAuth || mount.authenticated);
        }
        continue;
      }
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const authenticated = inheritedAuth || Boolean(layer.route.stack?.some(({ handle }) => requiresAuth(handle)));
      for (const path of paths) {
        if (typeof path !== 'string') throw new Error('Route inventory requires an explicit string path');
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) entries.push({ method: method.toUpperCase(), path: joinPath(prefix, path), authenticated });
        }
      }
    }
  }
  if (Array.isArray(input)) {
    for (const mount of input) walk(stackOf(mount.router), joinPath(basePath, mount.prefix), mount.middleware.some(requiresAuth));
  } else {
    walk(stackOf(input), basePath, false);
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
