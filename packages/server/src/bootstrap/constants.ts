/**
 * Server constants and environment configuration.
 * Extracted from index.ts for separation of concerns.
 */

export const PORT = process.env.PORT || 3001;
export const HOST = process.env.HOST || '0.0.0.0';
export const RANSOMWARE_MODULE_ENABLED = process.env.RANSOMWARE_MODULE_ENABLED !== 'false';
export const RANSOMWARE_MODULE_MODE = process.env.RANSOMWARE_MODULE_MODE || 'detect';

export function ensureControlUrl(): void {
  if (!process.env.DJIMITFLO_CONTROL_URL) {
    const dialHost = HOST === '0.0.0.0' || HOST === 'localhost' ? '127.0.0.1' : HOST;
    process.env.DJIMITFLO_CONTROL_URL = `http://${dialHost}:${PORT}/api/swarms/spawns`;
  }
}

export function logRansomwareStatus(): void {
  if (RANSOMWARE_MODULE_ENABLED) {
    console.log(`🛡️  Anti-agentic ransomware module active (mode: ${RANSOMWARE_MODULE_MODE})`);
  }
}
