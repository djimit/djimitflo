import { describe, it, expect } from "vitest";
import { ExploreOpenGraphService } from "../services/explore-opengraph-service";
import type { ExplainerBundleContent } from "@djimitflo/shared";

const baseBundle = (overrides: Partial<ExplainerBundleContent> = {}): ExplainerBundleContent => ({
  manifest: {
    schema_version: "1.0.0",
    bundle_id: "bundle-1",
    task_id: "task-1",
    repository_full_name: "djimit/juraregel",
    repository_url: "https://github.com/djimit/juraregel",
    source_commit: "abc123def456",
    pipeline_version: "0.1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    openmythos_score: 72,
    content_hash: "sha256-deadbeef",
    sections: [],
    assets: [],
  },
  explainer_md: "",
  llms_txt: "",
  facts: [],
  sections: {
    overview: "# Overview\n\nThis is a Python project for rule-based validation of legal documents.",
    health: "## Health\n\nOverall score: 88",
  },
  metadata: {
    task_id: "task-1",
    repository_url: "https://github.com/djimit/juraregel",
    local_path: null,
    generated_at: "2026-01-01T00:00:00.000Z",
  },
  graph_summary: {
    total_nodes: 10,
    total_edges: 12,
    total_files: 5,
    risk_score: null,
    communities: [],
    top_flows: [],
    hub_nodes: [],
    bridge_nodes: [],
  },
  openmythos_scores: null,
  ...overrides,
});

describe("ExploreOpenGraphService", () => {
  it("returns an svg+xml content type and a well-formed svg document", () => {
    const service = new ExploreOpenGraphService();
    const { svg, contentType } = service.render({ bundleContent: baseBundle() });
    expect(contentType).toBe("image/svg+xml");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
  });

  it("embeds the repository full name (escaped) and the short commit hash", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({ bundleContent: baseBundle() });
    expect(svg).toContain("djimit/juraregel");
    expect(svg).toContain("abc123d");
  });

  it("renders the OpenMythos score label and selects the amber color for midrange scores", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({ bundleContent: baseBundle() });
    expect(svg).toContain(">72<");
    expect(svg).toContain("#fbbf24");
  });

  it("renders the em-dash label and neutral color when the score is null", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        manifest: { ...baseBundle().manifest, openmythos_score: null },
      }),
    });
    expect(svg).toContain(">—<");
    expect(svg).toContain("#94a3b8");
  });

  it("uses the green color for high scores and red for low scores", () => {
    const service = new ExploreOpenGraphService();
    const green = service.render({
      bundleContent: baseBundle({
        manifest: { ...baseBundle().manifest, openmythos_score: 90 },
      }),
    }).svg;
    expect(green).toContain("#34d399");

    const red = service.render({
      bundleContent: baseBundle({
        manifest: { ...baseBundle().manifest, openmythos_score: 40 },
      }),
    }).svg;
    expect(red).toContain("#fb7185");
  });

  it("extracts the tagline from the overview section body", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({ bundleContent: baseBundle() });
    expect(svg).toContain("This is a Python project for rule-based validation of legal documents");
  });

  it("falls back to a default tagline when overview is absent", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({ sections: {} }),
    });
    expect(svg).toContain("An AI-generated explainer for this repository.");
  });

  it("extracts the numeric health score from the health section", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({ bundleContent: baseBundle() });
    expect(svg).toContain(">88<");
  });

  it("shows an em-dash when no health score is present", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({ sections: { overview: "# Overview\n\nbody text" } }),
    });
    expect(svg).toContain(">—<");
  });

  it("escapes XML-special characters in the repository name", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        manifest: {
          ...baseBundle().manifest,
          repository_full_name: 'a<b>&"c',
        },
      }),
    });
    expect(svg).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(svg).not.toContain('a<b>&"c');
  });

  it("truncates long taglines with an ellipsis", () => {
    const longLine = "A".repeat(120);
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: { overview: `# Title\n\n${longLine}`, health: "Overall score: 50" },
      }),
    });
    expect(svg).toContain("…");
    const renderedTagline = svg.match(/font-size="32">(.+?)<\/text>/);
    expect(renderedTagline).not.toBeNull();
    expect(renderedTagline![1].length).toBe(90);
  });

  it("selects green at the exact score 85 boundary", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        manifest: { ...baseBundle().manifest, openmythos_score: 85 },
      }),
    });
    expect(svg).toContain("#34d399");
    expect(svg).not.toContain("#fbbf24");
  });

  it("selects amber at the exact score 60 boundary", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        manifest: { ...baseBundle().manifest, openmythos_score: 60 },
      }),
    });
    expect(svg).toContain("#fbbf24");
    expect(svg).not.toContain("#fb7185");
  });

  it("renders 0 as the score label when score is zero (nullish coalescing)", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        manifest: { ...baseBundle().manifest, openmythos_score: 0 },
      }),
    });
    expect(svg).toContain(">0<");
    expect(svg).not.toContain(">—<");
  });

  it("escapes single quotes in the repository name", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        manifest: {
          ...baseBundle().manifest,
          repository_full_name: "a'b",
        },
      }),
    });
    expect(svg).toContain("a&apos;b");
    expect(svg).not.toContain("a'b");
  });

  it("strips a trailing period from the extracted tagline", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({ bundleContent: baseBundle() });
    const renderedTagline = svg.match(/font-size="32">(.+?)<\/text>/);
    expect(renderedTagline).not.toBeNull();
    expect(renderedTagline![1]).not.toMatch(/\.$/);
  });

  it("selects the second body line when the first body line is long (i > 0 guard)", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: {
          overview:
            "First long body line that should be skipped by the index guard\nSecond long body line that should be selected instead",
          health: "Overall score: 50",
        },
      }),
    });
    expect(svg).toContain("Second long body line that should be selected instead");
    expect(svg).not.toContain("First long body line that should be skipped by the index guard");
  });

  it("falls back to the heading text when the overview has no body", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: { overview: "# My Project Heading", health: "Overall score: 50" },
      }),
    });
    expect(svg).toContain(">My Project Heading<");
  });

  it("falls back to the default tagline when the heading is just a hash", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: { overview: "#", health: "Overall score: 50" },
      }),
    });
    expect(svg).toContain("An AI-generated explainer for this repository.");
  });

  it("does not select a body line of exactly 20 characters (length > 20 boundary)", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: { overview: "# MyHeading\n\n01234567890123456789", health: "Overall score: 50" },
      }),
    });
    expect(svg).toContain("MyHeading");
    expect(svg).not.toContain("01234567890123456789");
  });

  it("does not truncate a tagline of exactly 90 characters (length <= max boundary)", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: { overview: `# Title\n\n${"A".repeat(90)}`, health: "Overall score: 50" },
      }),
    });
    expect(svg).not.toContain("…");
    const renderedTagline = svg.match(/font-size="32">(.+?)<\/text>/);
    expect(renderedTagline).not.toBeNull();
    expect(renderedTagline![1].length).toBe(90);
  });

  it("does not add an ellipsis to a short tagline", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: { overview: "# Title\n\nShort body text here", health: "Overall score: 50" },
      }),
    });
    expect(svg).not.toContain("…");
  });

  it("trims trailing whitespace before appending the ellipsis", () => {
    const body = "A".repeat(85) + "    " + "B".repeat(30);
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: { overview: `# Title\n\n${body}`, health: "Overall score: 50" },
      }),
    });
    const renderedTagline = svg.match(/font-size="32">(.+?)<\/text>/);
    expect(renderedTagline).not.toBeNull();
    expect(renderedTagline![1].length).toBe(86);
    expect(renderedTagline![1]).not.toContain(" ");
  });

  it("renders an empty string when the repository name is null", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        manifest: {
          ...baseBundle().manifest,
          repository_full_name: null as unknown as string,
        },
      }),
    });
    expect(svg).not.toContain(">null<");
  });

  it("renders an empty string when the repository name is undefined", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        manifest: {
          ...baseBundle().manifest,
          repository_full_name: undefined as unknown as string,
        },
      }),
    });
    expect(svg).not.toContain(">undefined<");
  });

  it("shows an em-dash when the health section has no score pattern", () => {
    const service = new ExploreOpenGraphService();
    const { svg } = service.render({
      bundleContent: baseBundle({
        sections: { overview: "# Overview\n\nbody text", health: "Everything looks great" },
      }),
    });
    expect(svg).toContain(">—<");
    expect(svg).not.toContain(">great<");
  });
});