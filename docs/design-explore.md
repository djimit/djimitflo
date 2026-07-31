# Djimit Explore — Design System

Djimit Explore is the public-facing sub-brand for generated repository explainers. It is rendered as static HTML from a bundle and served at `/explainers/:owner/:repo`.

## Brand identity

- **Name:** Djimit Explore
- **Tagline:** "Understand every Djimit repository"
- **Palette (dark-first):**
  - Background: `slate-950` (#020617)
  - Surface: `slate-900` (#0f172a)
  - Border: `slate-800` (#1e293b)
  - Primary accent: `indigo-500` (#6366f1)
  - Secondary accent: `violet-500` (#8b5cf6)
  - Success: `emerald-400` (#34d399)
  - Warning: `amber-400` (#fbbf24)
  - Error: `rose-500` (#f43f5e)
  - Foreground: `slate-100` (#f1f5f9)
  - Muted: `slate-400` (#94a3b8)
- **Typography:** Inter for prose, JetBrains Mono for code (system fallbacks allowed)
- **Radius:** 12px cards, 999px pills/badges
- **Shadow:** subtle colored glow on trust badge (`box-shadow: 0 0 20px rgba(99,102,241,0.25)`)

## Page sections

1. **Hero**
   - Repo full name (owner/repo)
   - One-sentence value proposition / tagline
   - Stack badges row with "detected from ..." micro-caption
   - Trust badge: OpenMythos score with tooltip showing dimensions
   - Health score donut
   - "View on GitHub" CTA
   - "Last generated" freshness text

2. **Architecture**
   - Constellation diagram (SVG): communities as colored nodes, hub nodes larger, bridge nodes glowing, cross-community edges dashed
   - Textual community summary below diagram
   - Citation hover: every node links to file:line

3. **Health**
   - Overall health meter
   - Per-dimension meters: version control, tests, lint, type safety, CI, AGENTS.md, secrets, dependencies
   - Findings list with severity, recommendation, and file path

4. **Dependencies**
   - Detected stacks and package manager
   - Dependency audit summary (critical/high/low findings)
   - License card

5. **Knowledge Pack**
   - Link to `llms.txt`
   - Link to `manifest.json`
   - MCP server manifest download
   - Qdrant search hint

6. **Footer**
   - License + attribution
   - AI-generated transparency notice
   - "Report inaccuracy" link
   - Djimit logo + link to fleet index

## Components

- `ExploreHero` — hero section
- `ExploreHealthPanel` — health meters
- `ExploreArchitectureDiagram` — SVG diagram
- `ExploreOpenGraph` — 1200×630 PNG/SVG generator
- `ExploreReadmeWidget` — README embed snippet

## Responsive behavior

- Desktop: hero side-by-side, architecture full-width
- Tablet: hero stacked, architecture scrollable
- Mobile: sections stacked, diagram replaced by community list, badges wrap

## Accessibility

- All diagrams have `aria-describedby` pointing to a textual summary
- Color is never the sole severity indicator (icons + text)
- Focus states visible on all interactive elements
- Reduced motion respected for glow/pulse animations

## Assets

- OpenGraph image per repo: 1200×630, includes repo name, Djimit Explore branding, primary stack icon, trust score
- Favicon: reuse Djimitflo favicon
- Social preview text: auto-generated 150-char summary

## Notes

- This design system is intentionally decoupled from data fetching. Components receive plain props and render static markup. Data assembly is the responsibility of `ExplainerSiteRenderer` (phase 5).
