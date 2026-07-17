/**
 * SecretPatterns — comprehensive secret detection for diff capture.
 * Extends the built-in patterns with modern token formats.
 */
export const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'AWS Secret', pattern: /["']?AWS_SECRET_ACCESS_KEY["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/g },
  { name: 'GitHub PAT', pattern: /ghp_[a-zA-Z0-9]{36}/g },
  { name: 'GitHub Fine-grained PAT', pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g },
  { name: 'OpenAI Key', pattern: /sk-[a-zA-Z0-9]{48}/g },
  { name: 'OpenAI Project Key', pattern: /sk-proj-[a-zA-Z0-9]{48,}/g },
  { name: 'Anthropic Key', pattern: /sk-ant-[a-zA-Z0-9]{48,}/g },
  { name: 'Google API Key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'Slack Token', pattern: /xox[baprs]-[0-9]{12}-[0-9]{12}-[a-zA-Z0-9]{24}/g },
  { name: 'Slack Webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8}\/B[A-Z0-9]{8}\/[a-zA-Z0-9]{24}/g },
  { name: 'Private Key PEM', pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH |PRIVATE )?PRIVATE KEY-----/g },
  { name: 'Generic Secret', pattern: /["']?(?:secret|token|api_key|password|passwd)["']?\s*[:=]\s*["']?[^\s"'>]{16,}/gi },
  { name: 'High Entropy String', pattern: /["']?[A-Za-z0-9+/]{40,}={0,2}["']?/g },
  { name: 'Docker Registry Auth', pattern: /"auths"\s*:\s*\{[^}]*"auth"\s*:\s*"[A-Za-z0-9+/=]+"/g },
  { name: 'env_export', pattern: /^export\s+[A-Z_]+=[^\s]+$/gm },
];

/**
 * Redact secrets from text. Returns redacted text and count of redactions.
 */
export function redactSecrets(text: string): { redacted: string; count: number } {
  let count = 0;
  let result = text;
  for (const { name, pattern } of SECRET_PATTERNS) {
    const matches = result.match(pattern);
    if (matches) {
      count += matches.length;
      result = result.replace(pattern, `[REDACTED:${name}]`);
    }
  }
  return { redacted: result, count };
}
