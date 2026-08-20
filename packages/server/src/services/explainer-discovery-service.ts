/**
 * ExplainerDiscoveryService — fleet-wide GitHub repository enumeration.
 *
 * Syncs non-fork, non-archived public repositories for a GitHub owner into the
 * `discovered_repositories` table. Uses fetch (Node 18+) with an optional token,
 * handles pagination, basic rate-limit backoff, and owner-type fallback.
 */

import { randomUUID } from "crypto";
import type { Database } from "better-sqlite3";

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  fork: boolean;
  archived: boolean;
  html_url: string;
  clone_url: string;
  language: string | null;
  license: { spdx_id: string | null } | null;
  stargazers_count: number;
  open_issues_count: number;
  pushed_at: string | null;
  updated_at: string | null;
}

export interface DiscoverySyncResult {
  owner: string;
  discovered: number;
  active: number;
  deactivated: number;
  errors: string[];
}

export interface ExplainerDiscoveryOptions {
  githubToken?: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  pageSize?: number;
}

export interface DiscoveredRepositoryRow {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  last_commit_sha: string | null;
  last_commit_at: string | null;
  repo_category: "platform" | "plugin" | "tool" | "experimental" | "other";
  language: string | null;
  license: string | null;
  stargazers_count: number;
  open_issues_count: number;
  priority_tier: number;
  html_url: string;
  clone_url: string;
  is_active: number;
  last_discovered_at: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_PAGE_SIZE = 100;

function chooseCategory(repo: GitHubRepo): DiscoveredRepositoryRow["repo_category"] {
  const name = repo.name.toLowerCase();
  if (name.includes("plugin") || name.includes("extension") || name.includes("skill")) return "plugin";
  if (name.includes("tool") || name.includes("cli") || name.includes("util")) return "tool";
  if (name.includes("platform") || name.includes("core") || name.includes("framework")) return "platform";
  if (name.includes("experiment") || name.includes("proto") || name.includes("demo")) return "experimental";
  return "other";
}

function choosePriorityTier(repo: GitHubRepo): number {
  if (repo.stargazers_count >= 50 || repo.name.toLowerCase().includes("core")) return 1;
  if (repo.stargazers_count >= 10 || repo.language === "TypeScript") return 2;
  return 3;
}

export class ExplainerDiscoveryService {
  private baseUrl: string;
  private token?: string;
  private fetcher: typeof fetch;
  private pageSize: number;

  constructor(
    private db: Database,
    options: ExplainerDiscoveryOptions = {},
  ) {
    this.baseUrl = options.baseUrl || process.env.GITHUB_API_BASE_URL || DEFAULT_BASE_URL;
    this.token = options.githubToken || process.env.GITHUB_TOKEN;
    this.fetcher = options.fetcher || fetch;
    this.pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  }

  /**
   * Fetch a single page of repositories from the GitHub API.
   */
  private async fetchPage(owner: string, page: number, type: "orgs" | "users"): Promise<{ repos: GitHubRepo[]; hasMore: boolean; rateLimited: boolean }> {
    const url = new URL(`${this.baseUrl}/${type}/${encodeURIComponent(owner)}/repos`);
    url.searchParams.set("per_page", String(this.pageSize));
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "pushed");
    url.searchParams.set("direction", "desc");

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const response = await this.fetcher(url.toString(), { headers });

    if (response.status === 403) {
      return { repos: [], hasMore: false, rateLimited: true };
    }

    if (response.status === 404) {
      throw new Error(`OWNER_NOT_FOUND: ${owner} not found as ${type}`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GITHUB_API_ERROR ${response.status}: ${body}`);
    }

    const repos = (await response.json()) as GitHubRepo[];
    return { repos, hasMore: repos.length === this.pageSize, rateLimited: false };
  }

  /**
   * Enumerate repositories for an owner, trying orgs then users on 404.
   */
  async listRemoteRepositories(owner: string): Promise<{ repos: GitHubRepo[]; rateLimited: boolean; errors: string[] }> {
    const repos: GitHubRepo[] = [];
    const errors: string[] = [];
    let rateLimited = false;

    for (const type of ["orgs", "users"] as const) {
      let page = 1;
      try {
        while (true) {
          const { repos: pageRepos, hasMore, rateLimited: pageRateLimited } = await this.fetchPage(owner, page, type);
          if (pageRateLimited) {
            rateLimited = true;
            errors.push(`RATE_LIMITED on ${type} page ${page}`);
            break;
          }
          repos.push(...pageRepos);
          if (!hasMore) break;
          page += 1;
          if (page > 100) {
            errors.push(`PAGE_LIMIT reached for ${type}`);
            break;
          }
        }
        return { repos, rateLimited, errors };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("OWNER_NOT_FOUND")) {
          errors.push(`${type} endpoint returned 404`);
          continue;
        }
        errors.push(message);
        break;
      }
    }

    return { repos, rateLimited, errors };
  }

  /**
   * Sync remote repositories into `discovered_repositories`.
   * Deactivates entries that no longer appear in the remote list.
   */
  async syncDiscoveredRepositories(owner: string): Promise<DiscoverySyncResult> {
    const { repos, rateLimited, errors } = await this.listRemoteRepositories(owner);

    const filtered = repos.filter((repo) => !repo.fork && !repo.archived);
    const seenFullNames = new Set(filtered.map((r) => r.full_name.toLowerCase()));

    const upsert = this.db.prepare(`
      INSERT INTO discovered_repositories (
        id, owner, name, full_name, default_branch, last_commit_at, repo_category,
        language, license, stargazers_count, open_issues_count, priority_tier,
        html_url, clone_url, is_active, last_discovered_at, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(full_name) DO UPDATE SET
        default_branch = excluded.default_branch,
        last_commit_at = excluded.last_commit_at,
        repo_category = excluded.repo_category,
        language = excluded.language,
        license = excluded.license,
        stargazers_count = excluded.stargazers_count,
        open_issues_count = excluded.open_issues_count,
        priority_tier = excluded.priority_tier,
        html_url = excluded.html_url,
        clone_url = excluded.clone_url,
        is_active = 1,
        last_discovered_at = excluded.last_discovered_at,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    `);

    const now = new Date().toISOString();

    this.db.transaction(() => {
      for (const repo of filtered) {
        upsert.run(
          randomUUID(),
          repo.owner.login,
          repo.name,
          repo.full_name,
          repo.default_branch || "main",
          repo.pushed_at || repo.updated_at,
          chooseCategory(repo),
          repo.language,
          repo.license?.spdx_id || null,
          repo.stargazers_count,
          repo.open_issues_count,
          choosePriorityTier(repo),
          repo.html_url,
          repo.clone_url,
          now,
          JSON.stringify({ source: "github", rate_limited: rateLimited }),
          now,
          now,
        );
      }
    })();

    // Partial enumeration is not authoritative: update rows we received, but
    // never deactivate others after a rate limit, page cap, or fetch error.
    const deactivated = rateLimited || errors.length > 0 ? 0 : this.deactivateMissing(owner, seenFullNames);

    return {
      owner,
      discovered: filtered.length,
      active: this.countActive(owner),
      deactivated,
      errors,
    };
  }

  private deactivateMissing(owner: string, seenFullNames: Set<string>): number {
    const existing = this.db.prepare("SELECT full_name FROM discovered_repositories WHERE owner = ?").all(owner) as { full_name: string }[];
    let count = 0;
    for (const { full_name } of existing) {
      if (!seenFullNames.has(full_name.toLowerCase())) {
        this.db.prepare("UPDATE discovered_repositories SET is_active = 0, updated_at = ? WHERE full_name = ?").run(
          new Date().toISOString(),
          full_name,
        );
        count += 1;
      }
    }
    return count;
  }

  private countActive(owner: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM discovered_repositories WHERE owner = ? AND is_active = 1").get(owner) as { c: number };
    return row.c;
  }

  listDiscoveredRepositories(owner?: string, limit = 1000): DiscoveredRepositoryRow[] {
    let query = "SELECT * FROM discovered_repositories";
    const params: unknown[] = [];
    if (owner) {
      query += " WHERE owner = ?";
      params.push(owner);
    }
    query += " ORDER BY priority_tier ASC, stargazers_count DESC LIMIT ?";
    params.push(limit);
    return this.db.prepare(query).all(...params) as DiscoveredRepositoryRow[];
  }

  getDiscoveredRepository(fullName: string): DiscoveredRepositoryRow | null {
    return this.db.prepare("SELECT * FROM discovered_repositories WHERE full_name = ?").get(fullName) as DiscoveredRepositoryRow | null;
  }

  markRepositoryActive(fullName: string, isActive: boolean): void {
    this.db.prepare("UPDATE discovered_repositories SET is_active = ?, updated_at = ? WHERE full_name = ?").run(
      isActive ? 1 : 0,
      new Date().toISOString(),
      fullName,
    );
  }
}
