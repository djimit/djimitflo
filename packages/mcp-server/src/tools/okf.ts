/**
 * OKF (Open Knowledge Format) MCP tools.
 * Exposes: okf_search, okf_get, okf_related, okf_validate, okf_status
 *
 * These tools operate on the canonical OKF bundle at djimitflo-knowledge/okf/
 * and provide file-based knowledge graph traversal for agents.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

function resolveOkfBase(): string {
  const envBase = process.env.OKF_BASE?.trim();
  if (envBase) return path.resolve(envBase);

  const candidates = [
    path.resolve(__dirname, '../../../../djimitflo-knowledge/okf'),
    path.resolve(process.cwd(), 'djimitflo-knowledge/okf'),
    path.resolve(process.cwd(), '../djimitflo-knowledge/okf'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error('OKF bundle not found. Set OKF_BASE env var or ensure djimitflo-knowledge/okf/ exists.');
}

function extractFrontmatter(content: string): Record<string, string | string[]> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, string | string[]> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      fm[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      fm[key] = value;
    }
  }
  return fm;
}

function extractMarkdownLinks(content: string): string[] {
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = linkRegex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return links;
}

interface OkfFile {
  path: string;
  relativePath: string;
  type: string;
  title: string;
  content: string;
  links: string[];
}

function loadAllFiles(baseDir: string): OkfFile[] {
  const files: OkfFile[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.md') && entry.name !== 'FRONTMATTER_AUDIT.md') {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const fm = extractFrontmatter(content);
        files.push({
          path: fullPath,
          relativePath: path.relative(baseDir, fullPath),
          type: (Array.isArray(fm?.type) ? fm?.type[0] : fm?.type) || 'Unknown',
          title: (Array.isArray(fm?.title) ? fm?.title[0] : fm?.title) || entry.name,
          content,
          links: extractMarkdownLinks(content),
        });
      }
    }
  }

  walk(baseDir);
  return files;
}

export function registerOkfTools(server: McpServer) {
  server.registerTool(
    'okf_search',
    {
      description: 'Search OKF knowledge bundle by keyword, with optional type filter',
      inputSchema: {
        query: z.string().describe('Search query string'),
        type: z.string().optional().describe('Filter by OKF type (Agent, Service, Skill, Model, Repo, Concept, Memory, Run)'),
        limit: z.number().int().min(1).max(50).default(10).optional(),
      },
    },
    async ({ query, type, limit = 10 }) => {
      try {
        const baseDir = resolveOkfBase();
        const allFiles = loadAllFiles(baseDir);
        const queryLower = query.toLowerCase();

        let results = allFiles.filter(f => {
          const matchesQuery = f.title.toLowerCase().includes(queryLower) ||
            f.content.toLowerCase().includes(queryLower) ||
            f.type.toLowerCase().includes(queryLower);
          const matchesType = !type || f.type.toLowerCase() === type.toLowerCase();
          return matchesQuery && matchesType;
        });

        results = results.slice(0, limit);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              query,
              type: type || 'any',
              total: results.length,
              results: results.map(f => ({
                path: f.relativePath,
                type: f.type,
                title: f.title,
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'okf_get',
    {
      description: 'Get a specific OKF concept by its path (e.g. agents/djimitnl.md)',
      inputSchema: {
        conceptPath: z.string().describe('Relative path to the concept file'),
      },
    },
    async ({ conceptPath }) => {
      try {
        const baseDir = resolveOkfBase();
        const filePath = path.join(baseDir, conceptPath);

        if (!fs.existsSync(filePath)) {
          return {
            content: [{ type: 'text' as const, text: 'Concept not found: ' + conceptPath }],
            isError: true,
          };
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = extractFrontmatter(content);
        const links = extractMarkdownLinks(content);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              path: conceptPath,
              frontmatter: fm,
              links,
              content,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'okf_related',
    {
      description: 'Find related concepts via markdown links (graph traversal)',
      inputSchema: {
        conceptPath: z.string().describe('Starting concept path'),
        depth: z.number().int().min(1).max(3).default(1).optional(),
      },
    },
    async ({ conceptPath, depth = 1 }) => {
      try {
        const baseDir = resolveOkfBase();
        const allFiles = loadAllFiles(baseDir);

        const startFile = allFiles.find(f => f.relativePath === conceptPath);
        if (!startFile) {
          return {
            content: [{ type: 'text' as const, text: 'Concept not found: ' + conceptPath }],
            isError: true,
          };
        }

        const visited = new Set<string>();
        const related: Array<{ path: string; title: string; type: string; depth: number }> = [];

        function traverse(file: OkfFile, currentDepth: number) {
          if (currentDepth > depth) return;
          for (const link of file.links) {
            if (visited.has(link)) continue;
            visited.add(link);
            const linked = allFiles.find(f => f.relativePath === link || f.relativePath.replace('.md', '') === link);
            if (linked) {
              related.push({ path: linked.relativePath, title: linked.title, type: linked.type, depth: currentDepth });
              traverse(linked, currentDepth + 1);
            }
          }
        }

        traverse(startFile, 1);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              start: conceptPath,
              depth,
              related_count: related.length,
              related,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'okf_validate',
    {
      description: 'Validate OKF bundle conformance (frontmatter, types, links)',
      inputSchema: {
        strict: z.boolean().default(false).optional(),
      },
    },
    async ({ strict = false }) => {
      try {
        const baseDir = resolveOkfBase();
        const allFiles = loadAllFiles(baseDir);

        const required = ['type', 'title', 'description', 'timestamp', 'tags'];
        const issues: Array<{ path: string; issue: string }> = [];
        const typeCounts: Record<string, number> = {};

        for (const file of allFiles) {
          const fm = extractFrontmatter(file.content);
          if (!fm) {
            issues.push({ path: file.relativePath, issue: 'Missing frontmatter' });
            continue;
          }

          for (const field of required) {
            if (!fm[field]) {
              issues.push({ path: file.relativePath, issue: 'Missing field: ' + field });
            }
          }

          typeCounts[file.type] = (typeCounts[file.type] || 0) + 1;

          for (const link of file.links) {
            const exists = allFiles.some(f => f.relativePath === link || f.relativePath.replace('.md', '') === link);
            if (!exists) {
              issues.push({ path: file.relativePath, issue: 'Broken link: ' + link });
            }
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total_files: allFiles.length,
              type_counts: typeCounts,
              issues_count: issues.length,
              issues: issues.slice(0, 50),
              status: issues.length === 0 ? 'PASS' : 'FAIL',
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'okf_status',
    {
      description: 'Get OKF bundle health status (file counts, types, links)',
      inputSchema: {},
    },
    async () => {
      try {
        const baseDir = resolveOkfBase();
        const allFiles = loadAllFiles(baseDir);

        const typeCounts: Record<string, number> = {};
        let withFrontmatter = 0;
        let totalLinks = 0;

        for (const file of allFiles) {
          typeCounts[file.type] = (typeCounts[file.type] || 0) + 1;
          if (extractFrontmatter(file.content)) withFrontmatter++;
          totalLinks += file.links.length;
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              okf_base: baseDir,
              total_files: allFiles.length,
              with_frontmatter: withFrontmatter,
              total_links: totalLinks,
              type_counts: typeCounts,
              status: 'healthy',
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error instanceof Error ? error.message : String(error)) }],
          isError: true,
        };
      }
    }
  );
}
