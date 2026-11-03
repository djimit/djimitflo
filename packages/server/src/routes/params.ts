import type { Request } from 'express';

/**
 * Read a named path param as a string. @types/express-serve-static-core >= 5.1 types
 * `req.params` values as `string | string[]` (wildcard params are arrays); named
 * `:param` segments are always strings at runtime, so this is a typed no-op for them.
 */
export const param = (req: Pick<Request, 'params'>, key: string): string => {
  const v = req.params[key];
  return Array.isArray(v) ? v[0] : v;
};
