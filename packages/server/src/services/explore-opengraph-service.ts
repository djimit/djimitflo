/**
 * ExploreOpenGraphService — generates a shareable SVG OpenGraph card for a
 * published explainer bundle. Kept dependency-free (no canvas/sharp) by using
 * an inline SVG with gradients and metrics.
 */

import type { ExplainerBundleContent } from "@djimitflo/shared";

export interface OpenGraphInput {
  bundleContent: ExplainerBundleContent;
}

export class ExploreOpenGraphService {
  render({ bundleContent }: OpenGraphInput): { svg: string; contentType: string } {
    const manifest = bundleContent.manifest;
    const sections = bundleContent.sections || {};
    const tagline = this.extractTagline(sections.overview);
    const score = manifest.openmythos_score ?? null;
    const scoreLabel = score === null ? "—" : score.toFixed(0);
    const scoreColor = score === null ? "#94a3b8" : score >= 85 ? "#34d399" : score >= 60 ? "#fbbf24" : "#fb7185";

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#1e1b4b" />
    </linearGradient>
    <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.4" />
      <stop offset="100%" stop-color="#818cf8" stop-opacity="0.05" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)" />
  <rect x="900" y="-100" width="400" height="400" rx="200" fill="url(#glow)" />

  <text x="80" y="120" fill="#818cf8" font-family="system-ui, sans-serif" font-size="28" font-weight="700" letter-spacing="2">DJIMIT EXPLORE</text>
  <text x="80" y="210" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="56" font-weight="700">${this.escape(manifest.repository_full_name)}</text>
  <text x="80" y="290" fill="#cbd5e1" font-family="system-ui, sans-serif" font-size="32">${this.ellipsis(this.escape(tagline), 90)}</text>

  <g transform="translate(80, 460)">
    <rect width="220" height="100" rx="16" fill="#1e293b" stroke="#334155" stroke-width="2" />
    <text x="110" y="40" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="18" text-anchor="middle">OpenMythos</text>
    <text x="110" y="80" fill="${scoreColor}" font-family="system-ui, sans-serif" font-size="42" font-weight="700" text-anchor="middle">${scoreLabel}</text>
  </g>

  <g transform="translate(340, 460)">
    <rect width="220" height="100" rx="16" fill="#1e293b" stroke="#334155" stroke-width="2" />
    <text x="110" y="40" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="18" text-anchor="middle">Health</text>
    <text x="110" y="80" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="42" font-weight="700" text-anchor="middle">${this.extractHealth(sections.health)}</text>
  </g>

  <text x="80" y="610" fill="#64748b" font-family="system-ui, sans-serif" font-size="20">AI-generated repository explainer · ${this.escape(manifest.source_commit.slice(0, 7))}</text>
</svg>`;

    return { svg, contentType: "image/svg+xml" };
  }

  private extractTagline(overviewMarkdown?: string): string {
    if (!overviewMarkdown) return "An AI-generated explainer for this repository.";
    const lines = overviewMarkdown.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const firstBody = lines.find((l, i) => i > 0 && !l.startsWith("#") && l.length > 20) || "";
    if (firstBody) return firstBody.replace(/\.$/, "").trim();
    return lines[0]?.replace(/^#\s*/, "").trim() || "An AI-generated explainer for this repository.";
  }

  private extractHealth(healthMarkdown?: string): string {
    if (!healthMarkdown) return "—";
    const match = healthMarkdown.match(/Overall score[:\s]+(\d+)/);
    return match ? match[1] : "—";
  }

  private escape(text: string | number | null | undefined): string {
    if (text === null || text === undefined) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  private ellipsis(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 1).trimEnd() + "…";
  }
}
