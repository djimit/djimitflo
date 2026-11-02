import { vi } from 'vitest';
import type * as Admission from '../../execution/runtime-admission';

/**
 * Engine-path tests judge runtime admission at this fixed instant, not at the wall clock. The ledger's admissions expire
 * (djimitsec 2026-11-27, every legacy runtime 2026-12-31: execution/runtime-admission.ts), and a test that only needs
 * "this runtime is admitted" must not turn red on that date. Prod semantics are unchanged: the engine still calls
 * checkAdmission without `now`; only the test module swaps the default. An explicit `now` still wins.
 * The expiry itself is covered by runtime-admission-expiry.test.ts, which runs the engine at 2027-01-02.
 *
 * Use: vi.mock('../execution/runtime-admission', () => import('./helpers/admission-now').then((m) => m.admissionAtFixedNow()));
 */
export const ADMISSION_NOW = Date.parse('2026-10-29T12:00:00Z');

export async function admissionAtFixedNow(): Promise<typeof Admission> {
  const real = await vi.importActual<typeof Admission>('../../execution/runtime-admission');
  return { ...real, checkAdmission: (runtimeId, observed, now = ADMISSION_NOW, ledger) => real.checkAdmission(runtimeId, observed, now, ledger) };
}
