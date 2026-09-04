import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_BYTES = 256 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.jsonl', '.html']);
const BLOCKED_SEGMENTS = new Set(['chatgpt export', 'claude export', 'reports', '.git', 'node_modules']);
const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|token|secret|password|passwd|credential)s?\b\s*[:=]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
];
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:\+31|0)6[- ]?\d{8}\b/,
];

export interface NasDocumentSourceInput {
  root: string;
  relativePath: string;
  domain: string;
  confidence?: number;
  validUntil?: string | null;
  maxBytes?: number;
}

export interface NasDocumentEvidencePacket {
  source_path: string;
  title: string;
  domain: string;
  claim: string;
  confidence: number;
  valid_until: string | null;
  risk_flags: string[];
}

export interface NasDocumentPreflightResult {
  accepted: boolean;
  blocked_reasons: string[];
  packet: NasDocumentEvidencePacket | null;
}

export class NasDocumentSource {
  preflight(input: NasDocumentSourceInput): NasDocumentPreflightResult {
    const root = path.resolve(input.root);
    const fullPath = path.resolve(root, input.relativePath);
    const blocked = this.pathBlocks(root, fullPath);
    const riskFlags: string[] = [];

    if (blocked.length === 0) {
      // Symlink confinement (Kilo P2): lexical path checks pass when the path
      // itself is in-root but a symlink points outside. Resolve canonical
      // targets first and re-run confinement on the real location; open with
      // O_NOFOLLOW so the bytes we read are the ones we validated.
      let canonical = fullPath;
      try {
        const realRoot = fs.realpathSync(root);
        canonical = fs.realpathSync(fullPath);
        const rel = path.relative(realRoot, canonical);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          blocked.push('outside_root_symlink');
        }
      } catch { /* realpath failure handled by stat guard below */ }

      if (blocked.length === 0) {
        const stat = fs.existsSync(canonical) ? fs.statSync(canonical) : null;
        if (!stat?.isFile()) blocked.push('not_a_file');
        else if (stat.size > (input.maxBytes ?? DEFAULT_MAX_BYTES)) blocked.push('file_too_large');
        else {
          const fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          let text: string;
          try {
            text = fs.readFileSync(fd, 'utf8');
          } finally {
            fs.closeSync(fd);
          }
          if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) blocked.push('secret_like_content');
          if (PII_PATTERNS.some((pattern) => pattern.test(text))) riskFlags.push('pii_like_content');
          if (text.trim().length === 0) blocked.push('empty_document');
          if (blocked.length === 0) {
            return {
              accepted: true,
              blocked_reasons: [],
              packet: {
                source_path: input.relativePath,
                title: this.titleFrom(input.relativePath, text),
                domain: input.domain,
                claim: firstTextLine(text),
                confidence: input.confidence ?? 0.7,
                valid_until: input.validUntil ?? null,
                risk_flags: riskFlags,
              },
            };
          }
        }
      }
    }

    return { accepted: false, blocked_reasons: blocked, packet: null };
  }

  private pathBlocks(root: string, fullPath: string): string[] {
    const relative = path.relative(root, fullPath);
    const blocks: string[] = [];
    if (relative.startsWith('..') || path.isAbsolute(relative)) blocks.push('outside_root');
    if (!ALLOWED_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) blocks.push('unsupported_extension');
    const segments = relative.split(path.sep).map((segment) => segment.toLowerCase());
    if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) blocks.push('blocked_path_segment');
    return blocks;
  }

  private titleFrom(relativePath: string, text: string): string {
    return text.match(/^#\s+(.+)$/m)?.[1].trim() || path.basename(relativePath, path.extname(relativePath));
  }
}

function firstTextLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
}
