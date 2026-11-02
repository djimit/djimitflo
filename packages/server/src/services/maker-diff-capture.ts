import { createHash } from 'crypto';
import { redactSecrets } from './secret-patterns';

/**
 * MAKER_DIFF_CAPTURE=on (default off): a completed production maker lease stores its working-tree diff (the same text
 * diff_lines is counted from) in lease metadata as `diff` + `diff_sha256` / `diff_truncated` / `diff_redacted`, so the
 * training-dataset exporter (#894, reads worker_leases.metadata.diff) has prod rows with a diff. Record-only: nothing a
 * maker, checker or panel sees changes, and a capture error never changes the outcome — the lease then carries no diff,
 * only `diff_capture_error`.
 *
 * Same redaction and cap as the gym's prepareGymDiff (remote-gym-service.ts is the frozen TG-001 surface, so nothing is
 * imported or moved from it): redactSecrets first, then a byte cap equal to GYM_DIFF_MAX_BYTES (pinned by a test).
 */
export const MAKER_DIFF_MAX_BYTES = 50_000;
export const makerDiffCaptureOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.MAKER_DIFF_CAPTURE === 'on';

export function captureMakerDiff(raw: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  if (!makerDiffCaptureOn(env)) return {};
  try {
    if (!raw) return { diff_capture_error: 'empty_diff' };
    // redact before the cap, so a cut never leaves half a secret the patterns no longer match
    const { redacted: text, count } = redactSecrets(raw.slice(0, 4 * MAKER_DIFF_MAX_BYTES));
    const bytes = Buffer.from(text, 'utf8');
    const truncated = bytes.length > MAKER_DIFF_MAX_BYTES || raw.length > 4 * MAKER_DIFF_MAX_BYTES;
    // a byte cut can split a multi-byte character; drop the replacement char it leaves
    const diff = bytes.length > MAKER_DIFF_MAX_BYTES ? bytes.subarray(0, MAKER_DIFF_MAX_BYTES).toString('utf8').replace(/�+$/, '') : text;
    return { diff, diff_sha256: createHash('sha256').update(diff).digest('hex'), diff_truncated: truncated, diff_redacted: count };
  } catch (err) {
    return { diff_capture_error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}
