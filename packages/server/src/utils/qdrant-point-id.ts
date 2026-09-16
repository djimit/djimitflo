import { createHash } from 'crypto';

/**
 * Qdrant point ids must be an unsigned integer or a UUID. DjimFlo task ids are
 * UUIDs or composite strings (e.g. `loop-worker-<uuid>-<hex>`), so derive a
 * stable UUIDv5-shaped id: deterministic and therefore idempotent on re-upsert.
 */
export function pointIdForTask(taskId: string): string {
  const hex = createHash('sha256').update(taskId).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
