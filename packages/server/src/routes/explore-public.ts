/**
 * Public explore routes — serve generated explainer pages without authentication.
 */

import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Database } from "better-sqlite3";
import { ExplorePublicPageService } from "../services/explore-public-page-service";
import { ExploreOpenGraphService } from "../services/explore-opengraph-service";
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
