# Council Review — Explain My Repo for Djimit
## From Level 0 General-Purpose Plan to Level 3 / PhD-Grade Autonomous Product

---

## 1. EXECUTIVE_SUMMARY

The submitted plan is a credible skeleton for a per-repo explainer pipeline, but it is unmistakably **level 0**: it enumerates five sequential work packages without defining the product surface, quality contract, adversarial controls, or the institutional narrative that would make "Explain My Repo" a recognizable Djimit offering. The current `ExplainerGenerationService` confirms this diagnosis: remote ingestion is stubbed (`throw new Error("Remote repository ingestion not implemented")`), graph construction returns zero nodes/edges and a hard-coded file count, the author emits a six-section markdown template with mostly static placeholders, and the evaluator uses keyword heuristics (`text.includes("verify")`) rather than calibrated judges. The MCP server tools are likewise mocked (`bundle_path: "/tmp/mock-bundle-" + id`). The dashboard has no explainer page, no public route, and no sitemap. In short, the plan describes *how to finish a prototype*, not *how to ship a professional, autonomous, repeatable product*.

This council review upgrades the proposal to **level 3 / PhD-grade** by treating "Explain My Repo" as a **standard Djimit landing-page-as-a-service** for every public GitHub repository under the `Djimit` organization. The upgraded product must: (a) clone any public repo deterministically and safely; (b) build a real structural knowledge graph via `code-review-graph`, `ast-grep`, and repository-specific scanners; (c) author fact-grounded, citation-linked prose and visuals through an LLM pipeline that is judged by independent critic agents; (d) render a polished, SEO-ready, accessibility-compliant static site; (e) expose the result as an MCP-accessible knowledge pack in Qdrant; and (f) integrate with OpenMythos governance scoring so that every generated artifact carries a trust score, a provenance chain, and a human-review queue when confidence is insufficient. The final deliverable is not a markdown file in `/tmp` but a **published explainer site** (e.g., `https://explore.djimit.nl/djimitflo`) plus an embeddable widget that any Djimit repo can reference from its README.

---

## 2. STRENGTHS

1. **Sensible five-phase sequencing.** The plan moves from core pipeline → scheduling → authoring → rendering → knowledge pack in the right dependency order. A reader can follow the incremental path from "run once on one repo" to "run continuously on thirty-two repos."
2. **Reuses existing Djimitflo primitives.** The proposal correctly identifies `code-review-graph`, the database schema, `RepositoryScanner`, REST routes, and service tests as reusable foundations rather than greenfield code. This avoids inventing a second orchestration plane.
3. **Benchmark orientation.** By naming `explainmyrepo.isovision.ai` and its seven-station pipeline, the plan establishes a concrete quality target. That reference prevents scope collapse into a trivial README summarizer.
4. **Includes quality intent.** Phase 3 introduces a critic agent and a retry loop, and Phase 5 proposes a vector knowledge base. These are the right conceptual ingredients; they just lack calibration, architecture, and integration detail.
5. **Security awareness begins in the scanner.** `RepositoryScanner` already detects secret-file patterns, dirty git states, and missing AGENTS.md. This is a valuable seed for a fuller security engineering posture.
6. **OpenMythos adjacency.** The plan asks to leverage OpenMythos capabilities; the codebase already contains a sophisticated `OpenMythosEvalService` with JudgeService integration, oracle anchors, discrimination gating, and worker-pool execution. This is a genuine accelerant if wired correctly.
7. **MCP packaging intent.** Phase 5's "MCP server manifest generation" shows foresight: the output should not only be human-readable but also machine-consumable by agent clients.
8. **Dashboard hosting is in scope.** Rendering static HTML inside the existing dashboard route structure is cheaper than building a separate Netlify micro-site and keeps Djimitflo as the single control plane.

---

## 3. GAPS (Why It Is Still Level 0)

### 3.1 Product definition gaps
- **No persona or success metric.** Who is the reader? A visitor, a recruiter, a potential customer, an internal agent? The plan never defines the user journey, the desired "aha" moment, or the KPI (e.g., "average OpenMythos hallucination score ≥ 0.90 on 90% of repos").
- **No public entry point.** The benchmark product offers a web UI with "repo URL + email." The plan only mentions dashboard routes, and the dashboard is authenticated. A public Djimit landing page is never specified.
- **No standard output contract.** `explainer.md`, `llms.txt`, `facts.json`, and `sections/` are named but not defined. What must each section contain? What is the schema? What is the SLA for freshness?

### 3.2 Engineering depth gaps
- **Remote ingestion is unimplemented.** The most important capability—pulling any public Djimit repo—is a TODO. There is no design for shallow clones, caching, sparse checkouts, branch selection, tag awareness, or concurrency backpressure.
- **Graph construction is a stub.** `buildGraph` returns zero nodes and zero edges. The plan says "integrate code-review-graph" but does not say *how* to map its communities, flows, symbols, and bridge nodes into prose and visuals.
- **Authoring is template-based, not evidence-based.** The generated markdown contains hard-coded strings ("- README.md\n- src/index.ts\n- package.json"). It does not cite files, quote symbols, or ground claims in the actual repository.
- **Evaluation is heuristic theater.** `evaluateBundle` scans for substrings like "verify" and "score." This is not a critic; it is a regex. There is no rubric, no LLM-as-judge, no oracle anchors, no human baseline dataset, and no inter-rater reliability.
- **Retry loop lacks policy.** "Retry loop until threshold or human review queue" is hand-wavy. What is the threshold? How many retries? What triggers human review? What is the queue implementation?

### 3.3 Security and governance gaps
- **No secret scanning beyond filename patterns.** `RepositoryScanner` flags `.pem` and `.env` but does not run entropy scans (e.g., `secretscan`), SAST, or dependency audit. The generated site could leak sensitive snippets.
- **No content safety gate for generated prose.** LLM authors can hallucinate architecture claims, invent API contracts, or misrepresent security posture. There is no fact-checking step before publication.
- **No license and attribution layer.** Public repos have licenses, authors, and third-party dependencies. The plan does not address how to surface license headers, dependency notices, or copyright metadata.
- **No compliance posture for an AI-generated public page.** AVG/GDPR, EU AI Act transparency, and Djimit's own governance branding require disclosure that content is machine-generated and a mechanism to report inaccuracies.

### 3.4 OpenMythos integration gaps
- **OpenMythos is only a name in the plan.** The existing `OpenMythosEvalService` can judge governance behavior, but the plan does not wire it into explainer authoring, fact-checking, or the published trust score.
- **No calibration loop.** There is no mechanism to feed human corrections back into the judge model or the prompt templates.
- **No discrimination gating for explainer-specific cases.** The OpenMythos discrimination filter is a powerful idea for corpus quality; it could be extended to a dedicated "repo explainer" benchmark corpus.

### 3.5 Visual and UX gaps
- **No design system.** The dashboard has a `Layout` and `RepositoriesPage`, but there is no explainer design language, no dark-mode consistency, no typography scale, and no responsive information architecture.
- **No generated visuals.** The benchmark has "art direction + generated visuals/diagrams." The plan mentions none: no architecture diagrams, no commit-timeline charts, no stack-badges, no network graphs.
- **No SEO, accessibility, or performance requirements.** Sitemap, OpenGraph, structured data, alt text, Core Web Vitals, and social previews are absent.

### 3.6 Operational gaps
- **No change detection or refresh schedule.** A "fully autonomous" product must know when a repo has new commits and regenerate incrementally. The plan is batch-only.
- **No failure taxonomy or observability.** Failed tasks, drift between runs, and human-review queue depth need metrics, alerts, and a runbook.
- **No cost and rate-limit governance.** Cloning and LLM inference thirty-two public repos repeatedly can exhaust tokens, disk, and GitHub API limits. There is no budget gate.

---

## 4. UPGRADES_PER_PHASE

### Phase 1 — Core Pipeline Extension (upgrade from prototype to production-grade ingestion & graph extraction)

Current state: local-only scanning, stub graph, static markdown.

Required upgrades:
- **Implement `RemoteGitService`** that performs authenticated-but-minimal GitHub clones. Use shallow clones (`--depth 1 --single-branch --branch main`) by default, with an opt-in deep clone for history-aware timelines. Cache clones under `$DJIMITFLO_EXPLAINER_CACHE/repos/:owner/:repo/:commit/` with lockfiles to prevent concurrent mutation. Add a `git ls-remote` preflight to avoid cloning empty or archived repos.
- **Add a `RepoGraphBuilder`** adapter around `code-review-graph`. On every clone, run `code-review-graph_build_or_update_graph_tool` (full_rebuild=false after first run), then persist `list_communities_tool`, `list_flows_tool`, `get_hub_nodes_tool`, `get_bridge_nodes_tool`, and `get_surprising_connections_tool` results into a normalized `repo_graph_snapshots` table. The graph must become a first-class data product, not a side effect.
- **Extend `RepositoryScanner`** to emit a `RepositoryProfile` object: stack, health score, AGENTS.md hierarchy, CI matrix, secret-scan summary, dependency manifest, license, top contributors, and recent release tags. Store every finding in typed tables (`repository_health_findings`, `repo_secret_findings`, `repo_dependency_findings`).
- **Replace the static markdown generator** with a structured `BundleBuilder` that emits:
  - `manifest.json` — bundle metadata, schema version, source commit, pipeline version.
  - `explainer.md` — human-facing narrative.
  - `llms.txt` — compressed LLM context.
  - `facts.json` — atomic, citation-linked facts with file:line references.
  - `sections/` — one markdown file per section (overview, stack, architecture, health, security, compliance, roadmap).
  - `assets/` — generated SVG diagrams and OpenGraph images.
- **Keep tests green by adding contract tests, not only happy-path tests.** Every new service must have a Vitest suite with mocked git, mocked graph tool responses, and mocked LLM calls. Establish a `fixtures/repos/` directory containing minimal synthetic repos (TypeScript monorepo, Python package, Rust crate) so tests run offline.

### Phase 2 — Autonomous Batch Discovery + Scheduler (upgrade from ad-hoc tasks to fleet-aware orchestration)

Current state: manual task creation, SQLite background worker mentioned but unspecified.

Required upgrades:
- **Build `ExplainerDiscoveryService`** that queries the GitHub GraphQL API (`search_repositories` / `organization repos`) to enumerate all non-fork, non-archived `Djimit/*` public repos. Persist discovered repos in a `discovered_repositories` table with fields: `owner`, `name`, `default_branch`, `last_commit_sha`, `last_commit_at`, `repo_category` (platform/plugin/experimental), `language`, `license`, `stargazers`, `open_issues`, `priority_tier`, `discovered_at`.
- **Implement incremental scheduling**, not just batch triggers. A `RepoExplainerScheduler` computes a priority score per repo based on: (a) time since last explainer, (b) new commits since last run, (c) repo tier, (d) health score degradation, (e) manual user request. Use a SQLite-backed queue table (`explainer_jobs`) with `scheduled_at`, `started_at`, `finished_at`, `worker_id`, `retry_count`, and `status`. Run workers via the existing `WorkerPool` with a configurable concurrency ceiling and per-job timeout.
- **Add a public dashboard page** at `/explainers` that shows a matrix of all Djimit repos: last generated at, OpenMythos trust score, health score, freshness indicator, and a "Regenerate" action for authorized users. Add a per-repo status page at `/explainers/:owner/:repo`.
- **Expose REST endpoints** for fleet operations: `POST /api/explainer/fleet/sync` (trigger discovery), `POST /api/explainer/fleet/refresh-stale` (refresh repos older than N hours), `GET /api/explainer/fleet/status` (counts by status), and `POST /api/explainer/fleet/pause` (emergency stop).
- **Add cost/rate-limit governance.** Track per-run token spend, GitHub API calls, and LLM invocation counts. Enforce a daily budget and a per-repo minimum interval between full regenerations. Use exponential backoff on GitHub rate-limit headers.

### Phase 3 — LLM Author + Quality Gate (upgrade from template filling to evidence-based synthesis with calibrated critics)

Current state: hard-coded markdown sections and substring-based scoring.

Required upgrades:
- **Design a two-stage author architecture.**
  - **Stage A — Evidence Assembler:** Build a `RepoEvidencePacket` containing the most salient symbols, community summaries, surprising connections, health findings, AGENTS.md instructions, README fragments, and dependency metadata. Limit the packet to a token budget (e.g., 32k tokens) using a relevance-ranking pass over graph nodes and README sections.
  - **Stage B — Synthesis Author:** Prompt an LLM (default `longcat/LongCat-2.0` or the configured small model) to write each section with explicit instructions: every claim must cite a `file:line` or graph node ID; every section must follow a style guide; every generated code diagram must be grounded in real import edges.
- **Introduce a dedicated `ExplainerCriticService`** with three independent critics:
  - **Factuality critic** — verifies that every citation in `facts.json` resolves to a real file/line/symbol in the cloned repo.
  - **Hallucination critic** — uses `HallucinationDetectionService` (already present) to flag claims that contradict the source or invent APIs.
  - **Quality critic** — scores clarity, completeness, visual hierarchy, and Djimit brand voice on a 0-100 rubric.
- **Implement a structured grade-loop.** If the overall OpenMythos-style score is below 85, retry up to three times with targeted prompt corrections (e.g., "add missing security section", "replace generic description with concrete import graph"). If still below 85, move the bundle to a `human_review_queue` table and mark the public page with a "Pending editorial review" banner rather than publishing stale or low-confidence content.
- **Create a feedback loop.** Allow dashboard users to flag incorrect facts. Persist corrections in `explainer_feedback` and use them as few-shot examples for the next run on the same repo. This is how the system becomes PhD-grade: it learns from correction.

### Phase 4 — HTML Renderer + Dashboard Hosting (upgrade from markdown dump to professional static site)

Current state: markdown in a scratch directory, no dashboard integration.

Required upgrades:
- **Build `ExplainerSiteRenderer`** — a Vite/React-based static-site generator that consumes a bundle and emits:
  - `index.html` — landing page with hero, repo title, stack badges, health score, trust score, and auto-generated architecture diagram.
  - `architecture.html` — interactive graph visualization (D3/Cytoscape.js or lightweight SVG) of communities, hubs, and flows.
  - `health.html` — health findings, secret-scan results, dependency audit, and CI status.
  - `llms.txt` and `manifest.json` — machine-readable endpoints.
  - `sitemap.xml` and `robots.txt` — SEO basics.
- **Generate OpenGraph and social images server-side.** Use a headless SVG-to-PNG pipeline (e.g., `sharp` or `resvg-js`) to produce `og-image.png` per repo showing the repo name, health score, and primary stack badges. This is the difference between a back-office page and a shareable landing page.
- **Serve rendered sites under a canonical route.** In development: `/explainers/:owner/:repo`. In production: mount via nginx/traefik at `https://explore.djimit.nl/:owner/:repo` with cache headers and invalidation on regeneration.
- **Add accessibility compliance.** Every diagram must have an aria-describedby link to a textual equivalent. Color must not be the sole indicator of severity. Keyboard navigation must work for the graph view.
- **Add a README embed widget.** Generate a small snippet any Djimit repo can paste into its README: a badge linking to the explainer page and a summary card rendered via shields.io or an SVG micro-summary.

### Phase 5 — AI Knowledge Pack (upgrade from vague vector mention to first-class MCP knowledge product)

Current state: "Vector chunks into Qdrant" and "MCP server manifest generation."

Required upgrades:
- **Define a canonical chunking strategy.** Split each explainer bundle into:
  - Atomic facts (from `facts.json`).
  - Section summaries.
  - Symbol definitions (from graph nodes).
  - Health findings.
  - AGENTS.md instructions per sub-project.
- **Embed chunks into Qdrant** with metadata: `repo`, `section`, `file_path`, `line_start`, `line_end`, `symbol`, `bundle_version`, `generated_at`. Use the existing local Qdrant at `:6333` or make it configurable. Run `qdrant_qdrant_collections` to verify collection health.
- **Expose search via REST and MCP.** Add `GET /api/explainer/knowledge/search?q=&repos=` returning ranked chunks with citations. Update `packages/mcp-server/src/tools/explainer.ts` to provide real tools: `explainer_search_repo`, `explainer_get_fact`, `explainer_compare_repos`. Remove the mocked `runPipeline` stub.
- **Generate an MCP server manifest per repo** (`mcp.json`) that declares the repo as a knowledge source: name, description, version, tools, endpoints, auth requirements, and a trust score. This manifest becomes the "AI knowledge pack" that other agents can consume.
- **Add a cross-repo semantic layer.** Allow queries like "Which Djimit repos use the `RepositoryScanner` pattern?" by embedding symbol-level nodes across all repos and linking them via shared package names or import patterns.
- **Implement freshness contracts.** Each Qdrant payload includes `valid_until` derived from the source commit date. Stale chunks are down-ranked in search and flagged in the dashboard.

---

## 5. SECURITY_ENGINEERING_REQUIREMENTS

### 5.1 Pipeline security
- **Secure clone sandbox.** Clone into a dedicated directory with no execution permissions on downloaded scripts. Never run `npm install`, `make`, or arbitrary code from cloned repos during the explainer pipeline. If stack detection requires package inspection, parse manifests statically; do not execute them.
- **Secret scanning before ingestion.** Before any content enters the LLM context or the rendered site, run `secretscan` over the cloned repo. If high-entropy or known-pattern secrets are found, redact them in all outputs and surface a critical health finding. Never rely solely on filename heuristics.
- **Dependency audit integration.** Run `pkg_audit` and `osv_scan` on detected manifests. Include results in the health page and block publication of any dependency finding rated critical unless explicitly acknowledged.
- **SAST baseline for generated code examples.** If the author excerpts code snippets, run a lightweight SAST pass (`sast_scan`) to avoid publishing examples containing SQL injection, unsafe eval, or hardcoded credentials.
- **Authentication and authorization.** The public landing pages may be anonymous, but all mutation endpoints (`run`, `sync`, `regenerate`, `feedback`) must require `write:governance` or stronger via the existing `AuthMiddleware`. Public read endpoints must be rate-limited.
- **GitHub token hygiene.** Use a scoped `GITHUB_TOKEN` with read-only public-repo access. Rotate it via the existing secret management convention; never log or display it. Cache `git ls-remote` results to minimize token usage.
- **Resource limits and circuit breakers.** Cap clone depth, disk usage per repo, LLM output tokens, and total concurrent jobs. Reuse the `OllamaCircuitBreaker` pattern for external LLM calls and add a circuit breaker for GitHub API calls.

### 5.2 Generated content security
- **Hallucination guard on every claim.** Every factual sentence in `explainer.md` must be backed by a `facts.json` entry with a `source_ref` (file:line, graph node, or README heading). The factuality critic verifies this mapping before publication.
- **No invented security posture.** The author must never write " Djimitflo uses end-to-end encryption" unless the repo contains evidence of that implementation. Misrepresenting security claims is a compliance and liability risk.
- **License and copyright respect.** Surface the repo's `LICENSE` file, `package.json` author fields, and dependency licenses. Include a footer: "Content auto-generated from public source; verify critical claims." This satisfies EU AI Act transparency and Djimit brand integrity.
- **Inappropriate content filter.** Run a lightweight toxicity/privacy scan over generated prose before publication to prevent accidental exposure of names, emails, or internal URLs found in git history.
- **Immutable, versioned bundles.** Once published, a bundle receives a version and SHA-256 content hash. Regeneration produces a new bundle; the old one remains addressable for audit. This supports rollback and non-repudiation.
- **Human-review gate for low-confidence or sensitive repos.** Any repo tagged `security-review-commons`, `bio-security-baseline`, or containing a `SECURITY.md` with disclosure policy must require human approval before the public page goes live.

### 5.3 Compliance and operational security
- **Data retention policy.** Define how long clones, bundles, and Qdrant chunks are retained. Default: delete shallow clone working tree 24 hours after successful bundle generation; keep bundles and Qdrant vectors for 90 days unless archived.
- **Audit log.** Every pipeline run, manual regeneration, feedback submission, and publication decision is written to `explainer_audit_log` with actor, timestamp, and outcome.
- **Incident response.** If a published explainer is found to contain leaked secrets or false claims, provide a one-click "unpublish" endpoint that replaces the public page with a "Under review" state and purges the offending Qdrant chunks.

---

## 6. OPENMYTHOS_INTEGRATION

OpenMythos is not merely a quality score; it is the **governance backbone** of the explainer product. The existing `OpenMythosEvalService` should be reused directly.

- **Repo-specific OpenMythos benchmark corpus.** Create a new corpus file `corpus/explainer.corpus.jsonl` with cases such as:
  - Given a repo summary, does the author correctly identify the main entry point?
  - Given a health finding, does the author describe the remediation accurately?
  - Given a graph community, does the author avoid inventing relationships?
  - Given a README, does the author preserve the license and attribution?
- **Use JudgeService as the explainer critic.** The `judgeWithJudgeService` path already maps cases to `ExpertAnswer` objects and returns 1-5 scores. Adapt it to evaluate generated sections instead of agent responses. Reuse the oracle anchors for objective checks (e.g., "repo name must match the cloned repo name").
- **OpenMythos score as the trust badge.** Compute an overall `explainer_openmythos_score` from the five dimensions already present in the codebase: hallucination, calibration, tool_scope, contradiction, overthinking. Display it prominently on every explainer page as a "Confidence: 94/100" badge with a tooltip explaining the dimensions.
- **Discrimination gating for corpus quality.** Apply the existing `filterDiscriminatingCases` logic to the explainer corpus so that dead or too-easy cases are automatically excluded after enough historical runs. This keeps the benchmark meaningful as the model improves.
- **Calibration loop via human feedback.** When a dashboard user submits a correction, treat it as a new oracle anchor or a relabeled case. Periodically re-run the OpenMythos evaluator against the corrected bundles to measure drift and update the judge prompt.
- **Explainer score history.** Store per-repo, per-run OpenMythos scores in a time-series table. Render a sparkline on the dashboard showing whether a repo's explanation quality is improving, stable, or declining—exactly the `getGovernanceTrend` pattern already implemented.
- **OpenMythos-aware retry loop.** In Phase 3, use the per-dimension scores to decide what to fix on retry. For example, if `hallucination < 0.8`, tighten the citation requirement; if `tool_scope < 0.8`, inject more graph context; if `contradiction < 0.9`, run a contradiction-detection pass.

---

## 7. VISUAL_UX_PROFESSIONAL_IDEAS

### 7.1 Brand identity
- Create a sub-brand **"Djimit Explore"** with a clean logomark, distinct but aligned with the main dashboard. Use a dark-mode-first palette (slate-950 background, indigo-500 accent, amber-400 for warnings, emerald-400 for health) and a monospace typeface for code sections.
- Every explainer page must feel like a **product landing page**, not a README dump. Hero section: repo name, one-sentence value proposition, stack badges, health score donut, OpenMythos trust badge, and a "View on GitHub" CTA.

### 7.2 Generated visuals
- **Architecture constellation diagram.** Render graph communities as colored nodes; hub nodes larger; bridge nodes glowing; surprising cross-community edges dashed and annotated. Make it SVG so it scales and remains accessible.
- **Stack fingerprint card.** A horizontal row of detected stacks with iconography (TypeScript, Python, Rust, Docker, CI) and a "detected from `package.json`, `tsconfig.json`, `.github/workflows`" micro-caption.
- **Health dashboard.** A set of meters: version control, tests, lint, type safety, CI, AGENTS.md, secrets, dependencies. Red/yellow/green with textual recommendations.
- **Commit velocity sparkline.** If deep clone history is available, show commits per week over the last 90 days and highlight the most active contributors.
- **OpenGraph auto-image.** Generate a 1200×630 PNG with the repo name, Djimit Explore branding, primary stack icons, and the trust score. This makes sharing the explainer on LinkedIn/Twitter look professional.

### 7.3 Interaction design
- **Progressive disclosure.** The landing page shows the executive summary; tabs reveal Architecture, Health, Dependencies, Knowledge Pack, and Raw Bundle.
- **Interactive graph view.** Click a node to see its file path, inbound/outbound edges, and the generated natural-language summary. Include a "Focus on this community" button.
- **Citation hover.** Every factual claim links to its source. Hovering reveals the exact file:line and a one-line excerpt.
- **Feedback widget.** A subtle "Was this accurate?" thumbs-up/down at the bottom of each section. Down votes create a human-review task.
- **Responsive and accessible.** Mobile layout stacks sections vertically; graph view degrades to a textual community list. All charts have `aria-label` and data tables for screen readers.

### 7.4 Public entry point
- Build a public index at `https://explore.djimit.nl/` showing the entire Djimit repo fleet as a filterable grid. Each card shows the repo, last refreshed time, trust score, and a short generated tagline. This becomes a standard Djimit landing surface for prospects and contributors.

---

## 8. PRIORITY_REORDER_AND_NEW_PHASES

The original phase order is mostly correct, but it needs three additions and one reordering to reach level 3.

### Recommended phase map

1. **Phase 0 — Spec + benchmark corpus + design system.** Before writing code, define the bundle schema, the OpenMythos explainer corpus, the public page wireframes, and the success metrics. This prevents rework.
2. **Phase 1 — Core pipeline extension** (as upgraded above: remote clone, real graph, structured bundle, tests).
3. **Phase 2 — Autonomous discovery + scheduler** (as upgraded above: GitHub enumeration, incremental queue, cost governance, dashboard fleet view).
4. **Phase 3 — LLM author + quality gate** (as upgraded above: evidence packet, critic trio, grade-loop, human-review queue).
5. **Phase 4 — HTML renderer + public hosting** (as upgraded above: Djimit Explore site, SEO, accessibility, README widget).
6. **Phase 5 — AI knowledge pack + MCP exposure** (as upgraded above: Qdrant chunks, search endpoint, real MCP tools, cross-repo semantic layer).
7. **Phase 6 — Continuous improvement + operations.** New phase: change detection, automated refresh of stale explainers, feedback-driven prompt tuning, cost reporting, and a monthly OpenMythos score review. This is what makes the product "fully autonomous" rather than "batch on demand."

### Priority reordering rationale
- Move **quality gate detail** earlier: the OpenMythos corpus and critic architecture should be designed in Phase 0 and implemented in Phase 3, not retrofitted after rendering.
- Add **Phase 6** because a professional service requires lifecycle management beyond the first successful generation.
- **Rendering** can wait until bundles are high-quality; otherwise the public pages will be embarrassing. Do not build the site in Phase 2 before the author exists.

---

## 9. RISKS_AND_GUARDRAILS

| Risk | Severity | Guardrail |
|------|----------|-----------|
| LLM hallucinates architecture or security claims in a public page. | Critical | Factuality critic + `facts.json` citations + human-review gate below 85 OpenMythos score. |
| Cloned public repo contains leaked secrets that get rendered. | Critical | `secretscan` + redaction pass before any content enters the LLM or renderer. |
| GitHub API rate limits block fleet-wide refresh. | High | `git ls-remote` caching, shallow clones, daily budget, exponential backoff, priority scheduling. |
| LLM costs explode during grade-loop retries. | High | Max 3 retries, token budget per run, fallback to cheaper small model (`gpt-oss:120b`) for critic passes. |
| Generated site is inaccessible or performs poorly. | Medium | Accessibility audit checklist, Core Web Vitals budget, SVG diagrams, static HTML. |
| Legal/compliance exposure from AI-generated public content. | Medium | License footer, EU AI Act transparency notice, one-click unpublish, correction workflow. |
| Stale explainers misrepresent current repo state. | Medium | Incremental scheduler, commit-aware change detection, freshness badge on every page. |
| Feedback loop is polluted by low-quality corrections. | Medium | Correction requires auth, review queue for contradictory feedback, versioned retraining dataset. |
| Dashboard authentication bypass on public pages. | Medium | Public pages read-only, all mutations gated by `write:governance`, rate limits on public reads. |
| Cross-repo Qdrant search returns irrelevant or stale chunks. | Low | Metadata filtering by `repo` and `valid_until`, re-embedding on schema changes, collection monitoring. |

### Guardrail operationalization
- Implement a **circuit breaker** for external LLM and GitHub calls, reusing `OllamaCircuitBreaker`.
- Add a **kill switch** endpoint that pauses all scheduled jobs and unpublishes the fleet index in under 30 seconds.
- Run a **pre-flight checklist** before any public page is marked `live`: secret scan clean, fact citations verified, OpenMythos score ≥ 85, license footer present, accessibility labels present.

---

## 10. REVISED_ARCHITECTURE_SKETCH

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Public Surface: Djimit Explore                       │
│  explore.djimit.nl/          /:owner/:repo          /knowledge?q=...        │
│  (React/Vite static sites served via nginx/traefik with cache invalidation)  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         djimitflo Server Control Plane                      │
│                                                                              │
│  REST API                     Background Workers              MCP Server     │
│  ─────────                    ───────────────────             ───────────    │
│  /api/explainer/tasks         ExplainerDiscoveryService       explainer_*    │
│  /api/explainer/fleet/*       RepoExplainerScheduler          knowledge_*  │
│  /api/explainer/knowledge/*   WorkerPool (reused)                            │
│                                                                              │
│  Core Services                                                               │
│  ─────────────                                                               │
│  RemoteGitService        → shallow clone + cache + lockfiles                 │
│  RepositoryScanner       → stack, health, AGENTS.md, secrets, deps          │
│  RepoGraphBuilder        → code-review-graph adapters                         │
│  BundleBuilder           → manifest.json, explainer.md, llms.txt, facts.json │
│  ExplainerAuthorService  → evidence packet + LLM synthesis                   │
│  ExplainerCriticService  → factuality + hallucination + quality critics      │
│  ExplainerSiteRenderer   → Vite/React static site generator                   │
│  ExplainerKnowledgePack  → Qdrant chunking + embeddings + search              │
│                                                                              │
│  Governance / Quality                                                        │
│  ───────────────────                                                         │
│  OpenMythosEvalService   → explainer corpus + JudgeService scoring           │
│  HallucinationDetectionService → contradiction / citation drift            │
│  secretscan, sast_scan, pkg_audit, osv_scan → content safety gates           │
│  AuthMiddleware + rate limits + audit log                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Data & Knowledge Layer                               │
│                                                                              │
│  SQLite (djimitflo DB)                                                       │
│    discovered_repositories, explainer_tasks, explainer_jobs,                 │
│    explainer_bundles, explainer_feedback, human_review_queue,                │
│    repo_graph_snapshots, explainer_audit_log                                 │
│                                                                              │
│  File Store                                                                  │
│    $CACHE/repos/:owner/:repo/:commit/      (cloned source, ephemeral)       │
│    $BUNDLES/:owner/:repo/:bundle-id/       (manifest, markdown, assets)     │
│    $SITES/:owner/:repo/:bundle-id/         (rendered static HTML)           │
│                                                                              │
│  Qdrant (local :6333)                                                        │
│    Collection: djimit_repo_knowledge                                         │
│    Payloads: facts, sections, symbols, health findings, AGENTS.md snippets  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         External Services                                    │
│  GitHub API / git          Ollama Cloud / direct providers                   │
│  code-review-graph MCP     Qdrant MCP                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key architectural decisions
1. **Single control plane.** All explainer logic lives in `packages/server`; rendering artifacts are generated into `packages/dashboard/public/explainers` or a dedicated static-host path. No new microservice is introduced unless a concrete caller proves it necessary (Ponytail simplicity rule: security/runtime/project instructions override convenience).
2. **Bundle immutability.** Every successful run produces a new bundle directory keyed by UUID. The public route points to the latest approved bundle; old bundles remain for audit and rollback.
3. **Graph-first, not LLM-first.** The LLM author is constrained by a structured evidence packet derived from the graph. This reduces hallucination and grounds the narrative in real source topology.
4. **Governance by default.** OpenMythos scoring, secret scanning, and human-review gates are not optional add-ons; they are pipeline stages that block publication.
5. **MCP-native output.** The final knowledge pack is exposed both as a rendered website and as MCP tools so that other agents can query Djimit repo knowledge programmatically.

---

## Closing Recommendation

Do not execute the current plan as written. Use this review as the new requirements document. Begin with **Phase 0** (spec, corpus, design system, success metrics), then implement the upgraded phases in order. The immediate next action should be to draft the `BundleBuilder` output schema and the OpenMythos explainer corpus, because every downstream phase depends on those contracts. Treat the first public explainer of `djimitflo` itself as the tracer-bullet milestone: if that single page looks professional, is factually grounded, scores ≥ 85 on OpenMythos, and passes an accessibility check, the rest of the fleet is a scaling problem rather than a research problem.
