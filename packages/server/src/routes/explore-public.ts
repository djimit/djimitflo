/**
 * Public explore routes — serve generated explainer pages without authentication.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Database } from "better-sqlite3";
import { ExplorePublicPageService } from "../services/explore-public-page-service";
import { ExploreOpenGraphService } from "../services/explore-opengraph-service";
import { OpenMythosEvalService } from "../services/openmythos-eval-service";
import { securityHeaders } from "../middleware/security-headers";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function createExplorePublicRoutes(db: Database): Router {
  const router = Router();
  const service = new ExplorePublicPageService(db);
  const ogService = new ExploreOpenGraphService();
  const publicOrigin = resolvePublicOrigin();

  router.use(securityHeaders);

  // Public read rate limit for generated explore pages.
  const publicPageLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  // GET /explore/:owner/:repo — public explainer page
  router.get("/:owner/:repo", publicPageLimiter, (req, res) => {
    const { owner, repo } = req.params;
    if (!validRepositoryPath(owner, repo)) {
      res.status(400).type("text/plain").send("Invalid repository path.");
      return;
    }
    const bundleContent = service.findPublishedBundle(owner, repo);
    if (!bundleContent) {
      res.status(404).type("text/plain").send(`No published explainer for ${owner}/${repo}.`);
      return;
    }

    const result = service.render({ owner, repo, bundleContent, baseUrl: publicOrigin });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(result.html);
  });

  // GET /explore/:owner/:repo/llms.txt — plain text knowledge pack
  router.get("/:owner/:repo/llms.txt", publicPageLimiter, (req, res) => {
    const { owner, repo } = req.params;
    if (!validRepositoryPath(owner, repo)) {
      res.status(400).type("text/plain").send("Invalid repository path.");
      return;
    }
    const bundleContent = service.findPublishedBundle(owner, repo);
    if (!bundleContent || !bundleContent.llms_txt) {
      res.status(404).type("text/plain").send("No llms.txt available for this repository.");
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(bundleContent.llms_txt);
  });

  // GET /explore/:owner/:repo/opengraph.svg — shareable card
  router.get("/:owner/:repo/opengraph.svg", publicPageLimiter, (req, res) => {
    const { owner, repo } = req.params;
    if (!validRepositoryPath(owner, repo)) {
      res.status(400).type("text/plain").send("Invalid repository path.");
      return;
    }
    const bundleContent = service.findPublishedBundle(owner, repo);
    if (!bundleContent) {
      res.status(404).type("text/plain").send("No published bundle for this repository.");
      return;
    }
    const { svg, contentType } = ogService.render({ bundleContent });
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(svg);
  });

  // GET /explore/sitemap.xml — index of published explainer pages
  router.get("/sitemap.xml", publicPageLimiter, (_req, res) => {
    const repos = service.listPublishedRepositories();
    const urls = repos
      .map((full_name) => `  <url><loc>${publicOrigin}/explore/${full_name}</loc><changefreq>weekly</changefreq></url>`)
      .join("\n");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`);
  });

  // GET /explore/robots.txt — allow crawling of published pages only
  router.get("/robots.txt", publicPageLimiter, (_req, res) => {
    res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${publicOrigin}/explore/sitemap.xml\n`);
  });

  // GET /explore/:owner/:repo/badge.svg — README embed widget
  router.get("/:owner/:repo/badge.svg", publicPageLimiter, (req, res) => {
    const { owner, repo } = req.params;
    if (!validRepositoryPath(owner, repo)) {
      res.status(400).type("text/plain").send("Invalid repository path.");
      return;
    }
    const bundleContent = service.findPublishedBundle(owner, repo);
    if (!bundleContent) {
      res.status(404).type("text/plain").send("No published bundle for this repository.");
      return;
    }
    const score = bundleContent.manifest.openmythos_score;
    const label = score === null || score === undefined ? "explainer" : `explainer ${Math.round(score)}`;
    const color = score === null || score === undefined ? "6b7280" : score >= 85 ? "10b981" : score >= 60 ? "f59e0b" : "ef4444";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="20" role="img" aria-label="Djimit Explainer score: ${label}"><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="150" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="82" height="20" fill="#555"/><rect x="82" width="68" height="20" fill="#${color}"/><rect width="150" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="41" y="14">djimit explore</text><text x="115" y="14">${label}</text></g></svg>`;
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(svg);
  });

  // GET /explore/leaderboard — public governance-eval scores (scores only:
  // agent id, score, case counts — no case content, no prompts).
  // Restricted to model-only governance runs (metadata.evaluation_mode =
  // 'model_only'): excludes explainer-critic rows (0-100 scale) and skill-id
  // runs so the public ranking stays comparable (1-5 scale). Kilo P1.
  // Off unless OPENMYTHOS_LEADERBOARD_PUBLIC=true.
  router.get("/leaderboard", publicPageLimiter, (_req, res) => {
    if (process.env.OPENMYTHOS_LEADERBOARD_PUBLIC !== "true") {
      res.status(404).type("text/plain").send("Leaderboard is not published.");
      return;
    }
    const all = new OpenMythosEvalService(db).getLeaderboard();
    const modeStmt = db.prepare(
      "SELECT CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.evaluation_mode') END AS m FROM openmythos_eval_runs WHERE agent_id = ? AND status='completed' LIMIT 1",
    );
    const rows = all.filter((r) => (modeStmt.get(r.agentId) as { m: string | null } | undefined)?.m === "model_only");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.json({
      generated_at: new Date().toISOString(),
      leaderboard: rows.map((r) => ({
        agent_id: r.agentId,
        overall_score: r.overallScore,
        total_cases: r.totalCases,
        last_eval_at: r.lastEvalAt,
        trend: r.trend,
      })),
    });
  });

  return router;
}

function validRepositoryPath(owner: string, repo: string): boolean {
  return OWNER_PATTERN.test(owner) && REPO_PATTERN.test(repo);
}

function resolvePublicOrigin(): string {
  if (process.env.NODE_ENV === "production" && !process.env.DJIMITFLO_PUBLIC_ORIGIN) {
    throw new Error("DJIMITFLO_PUBLIC_ORIGIN is required in production");
  }
  const value = process.env.DJIMITFLO_PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || "3001"}`;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("DJIMITFLO_PUBLIC_ORIGIN must use http or https");
  return url.origin;
}
