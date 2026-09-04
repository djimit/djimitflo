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

export interface NasDocumentManifestEntry {
  relativePath: string;
  domain: string;
  confidence?: number;
  validUntil?: string | null;
}

export interface NasDocumentManifestResult {
  accepted: number;
  blocked: number;
  packets: NasDocumentEvidencePacket[];
  results: Array<NasDocumentManifestEntry & NasDocumentPreflightResult>;
}

export class NasDocumentSource {
  preflightManifest(root: string, entries: NasDocumentManifestEntry[], maxBytes?: number): NasDocumentManifestResult {
    const results = entries.map((entry) => ({
      ...entry,
      ...this.preflight({ ...entry, root, maxBytes }),
    }));
    return {
      accepted: results.filter((result) => result.accepted).length,
      blocked: results.filter((result) => !result.accepted).length,
      packets: results.flatMap((result) => result.packet ? [result.packet] : []),
      results,
    };
  }

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
        const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
        // Bounded read (Kilo P2): validate the open descriptor with fstatSync
        // and cap the bytes actually consumed — statSync/readFileSync leaves a
        // TOCTOU window where the file grows past maxBytes between check and
        // read.
        let fd: number;
        try {
          fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        } catch {
          fd = fs.openSync(canonical, fs.constants.O_RDONLY); // O_NOFOLLOW unsupported (e.g. older libuv on some fs)
        }
        let text: string;
        try {
          const fstat = fs.fstatSync(fd);
          if (!fstat.isFile()) { blocked.push('not_a_file'); text = ''; }
          else if (fstat.size > maxBytes) { blocked.push('file_too_large'); text = ''; }
          else {
            // read at most maxBytes+1 so growth past the limit is detected
            const buf = Buffer.alloc(maxBytes + 1);
            const bytesRead = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
            if (bytesRead > maxBytes) { blocked.push('file_too_large'); text = ''; }
            else text = buf.subarray(0, bytesRead).toString('utf8');
          }
        } finally {
          fs.closeSync(fd);
        }
        if (text) {
          if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) blocked.push('secret_like_content');
          if (PII_PATTERNS.some((pattern) => pattern.test(text))) riskFlags.push('pii_like_content');
          if (text.trim().length === 0) blocked.push('empty_document');
        }
        if (blocked.length === 0 && text) {
          const title = this.titleFrom(input.relativePath, text);
          return {
            accepted: true,
            blocked_reasons: [],
            packet: {
              source_path: input.relativePath,
              title,
              domain: input.domain,
              claim: path.extname(input.relativePath).toLowerCase() === '.html' ? title : firstTextLine(text, title),
              confidence: input.confidence ?? 0.7,
              valid_until: input.validUntil ?? null,
              risk_flags: riskFlags,
            },
          };
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

function firstTextLine(text: string, fallback: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line && !line.startsWith('<')) || fallback;
}
