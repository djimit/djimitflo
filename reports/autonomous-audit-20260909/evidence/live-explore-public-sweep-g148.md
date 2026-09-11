# G148 live public Explore route sweep

Date: 2026-09-10
Target: `https://djimitflo.agentical.nl`

Read-only production probes covered every currently exposed public Explore index endpoint:

| Route | Status | Content type | Check |
|---|---:|---|---|
| `/explore/robots.txt` | 200 | `text/plain` | contains a sitemap directive |
| `/explore/sitemap.xml` | 200 | `application/xml` | contains a valid `<urlset>` |
| `/explore/leaderboard` | 200 | `application/json` | contains a leaderboard projection |

The sitemap currently contains no published repository URLs, so no repository-specific page was guessed or treated as live evidence. No mutation was sent.
