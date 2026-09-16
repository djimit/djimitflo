import { describe, expect, it } from 'vitest';
import { pointIdForTask } from '../utils/qdrant-point-id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('pointIdForTask', () => {
  it('derives a UUIDv5-shaped id that Qdrant accepts', () => {
    expect(pointIdForTask('827510fa-f65c-4ca4-8d5f-8399dc17b7e3')).toMatch(UUID_RE);
    expect(pointIdForTask('loop-worker-024dbca4-434e-469b-aee2-66431a03734e-724bec77')).toMatch(UUID_RE);
    expect(pointIdForTask('task-1')).toMatch(UUID_RE);
  });

  it('is deterministic so re-upserts are idempotent', () => {
    expect(pointIdForTask('same-task')).toBe(pointIdForTask('same-task'));
    expect(pointIdForTask('a')).not.toBe(pointIdForTask('b'));
  });
});
