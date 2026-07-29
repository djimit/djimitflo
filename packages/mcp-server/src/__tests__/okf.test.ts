import { afterEach, describe, expect, it } from 'vitest';
import { resolveOkfBase } from '../tools/okf.js';

const original = process.env.OKF_BASE;

afterEach(() => {
  if (original === undefined) delete process.env.OKF_BASE;
  else process.env.OKF_BASE = original;
});

describe('OKF path resolution', () => {
  it('uses the explicit OKF base in ESM', () => {
    process.env.OKF_BASE = './okf';
    expect(resolveOkfBase()).toBe(`${process.cwd()}/okf`);
  });
});
