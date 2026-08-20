/**
 * BundleBuilder — emits a structured explainer bundle to disk and SQLite.
 *
 * Bundle layout:
 *   bundles/:owner/:repo/:commit/
 *     manifest.json
 *     explainer.md
 *     llms.txt
 *     facts.json
 *     sections/
 *       overview.md
 *       architecture.md
 *       health.md
 *       dependencies.md
 *     assets/
 *       (opengraph.png, favicon, etc.)
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type {
  ExplainerManifest,
  ExplainerFact,
  ExplainerBundleContent,

  GraphSummary,
} from '@djimitflo/shared';

export interface BuildBundleInput {
  taskId: string;
  repositoryFullName: string;
  repositoryUrl: string;
  sourceCommit: string;
  bundleRoot: string;
  graphSummary: GraphSummary;
  scanSummary: Record<string, unknown>;
  sections: Record<string, string>;
  facts: ExplainerFact[];
  openmythosScore: number | null;
}

export interface BuildBundleResult {
  bundleId: string;
  bundlePath: string;
  manifestPath: string;
  markdownPath: string;
  llmsTxtPath: string;
  factsPath: string;
  sectionsPath: string;
  assetsPath: string;
  contentHash: string;
}

export class BundleBuilder {
  constructor(private db: Database.Database) {}

  build(input: BuildBundleInput): BuildBundleResult {
    const bundleId = randomUUID();
    const { owner, repo } = this.parseOwnerRepo(input.repositoryFullName);
    const bundlePath = join(input.bundleRoot, owner, repo, input.sourceCommit, bundleId);

    const sectionsPath = join(bundlePath, 'sections');
    const assetsPath = join(bundlePath, 'assets');
    mkdirSync(sectionsPath, { recursive: true });
    mkdirSync(assetsPath, { recursive: true });

    const manifestPath = join(bundlePath, 'manifest.json');
    const markdownPath = join(bundlePath, 'explainer.md');
    const llmsTxtPath = join(bundlePath, 'llms.txt');
    const factsPath = join(bundlePath, 'facts.json');

    const manifest = this.buildManifest(bundleId, input);
    const explainerMd = this.buildExplainerMarkdown(input, manifest);
    const llmsTxt = this.buildLlmsTxt(input);

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(markdownPath, explainerMd);
    writeFileSync(llmsTxtPath, llmsTxt);
    writeFileSync(factsPath, JSON.stringify(input.facts, null, 2));

    for (const [sectionType, content] of Object.entries(input.sections)) {
      const safeName = sectionType.replace(/[^a-z0-9_-]/gi, '_');
      writeFileSync(join(sectionsPath, `${safeName}.md`), content);
    }

    const contentHash = this.hashBundle(bundlePath);

    const insert = this.db.prepare(`
      INSERT INTO explainer_bundles (
        id, task_id, bundle_path, manifest_path, markdown_path, llms_txt_path,
        facts_path, sections_path, assets_path, status, content_hash, openmythos_score,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const status = 'pending';
    const now = new Date().toISOString();
    insert.run(
      bundleId,
      input.taskId,
      bundlePath,
      manifestPath,
      markdownPath,
      llmsTxtPath,
      factsPath,
      sectionsPath,
      assetsPath,
      status,
      contentHash,
      input.openmythosScore,
      JSON.stringify({ owner, repo, source_commit: input.sourceCommit }),
      now,
      now,
    );

    // Persist sections to explainer_sections table for querying
    const sectionInsert = this.db.prepare(`
      INSERT INTO explainer_sections (id, bundle_id, section_type, title, content, sort_order, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let sortOrder = 0;
    for (const [sectionType, content] of Object.entries(input.sections)) {
      sectionInsert.run(
        randomUUID(),
        bundleId,
        sectionType,
        this.sectionTitle(sectionType),
        content,
        sortOrder++,
        '{}',
        now,
        now,
      );
    }

    return {
      bundleId,
      bundlePath,
      manifestPath,
      markdownPath,
      llmsTxtPath,
      factsPath,
      sectionsPath,
      assetsPath,
      contentHash,
    };
  }

  loadBundleContent(bundleId: string): ExplainerBundleContent {
    const row = this.db.prepare('SELECT * FROM explainer_bundles WHERE id = ?').get(bundleId) as Record<string, string> | undefined;
    if (!row) throw new Error(`Bundle not found: ${bundleId}`);

    const manifest: ExplainerManifest = JSON.parse(this.readFile(row.manifest_path));
    const explainer_md = this.readFile(row.markdown_path);
    const llms_txt = this.readFile(row.llms_txt_path);
    const facts: ExplainerFact[] = JSON.parse(this.readFile(row.facts_path));
    const sectionRows = this.db.prepare('SELECT section_type, content FROM explainer_sections WHERE bundle_id = ? ORDER BY sort_order').all(bundleId) as Array<{ section_type: string; content: string }>;
    const sections: Record<string, string> = {};
    for (const s of sectionRows) sections[s.section_type] = s.content;

    return {
      manifest,
      explainer_md,
      llms_txt,
      facts,
      sections,
      metadata: {
        task_id: row.task_id,
        repository_url: manifest.repository_url,
        local_path: row.bundle_path,
        generated_at: manifest.generated_at,
      },
      graph_summary: {
        total_nodes: 0,
        total_edges: 0,
        total_files: 0,
        risk_score: null,
        communities: [],
        top_flows: [],
        hub_nodes: [],
        bridge_nodes: [],
        ...((manifest as unknown as Record<string, unknown>).graph_summary ?? {}),
      } as GraphSummary,
      openmythos_scores: null,
    };
  }

  private parseOwnerRepo(fullName: string): { owner: string; repo: string } {
    const [owner, repo, ...rest] = fullName.split('/');
    if (!owner || !repo || rest.length > 0) {
      throw new Error(`Invalid repository_full_name: ${fullName}`);
    }
    return { owner, repo };
  }

  private buildManifest(bundleId: string, input: BuildBundleInput): ExplainerManifest {
    const now = new Date().toISOString();
    const sectionFiles = Object.keys(input.sections).map((type) => ({
      type,
      title: this.sectionTitle(type),
      file: `sections/${type}.md`,
      citations: input.facts.filter((f) => f.source_type === 'file_line').map((f) => f.source_ref),
    }));

    return {
      schema_version: '1.0.0',
      bundle_id: bundleId,
      task_id: input.taskId,
      repository_full_name: input.repositoryFullName,
      repository_url: input.repositoryUrl,
      source_commit: input.sourceCommit,
      pipeline_version: '0.1.0',
      generated_at: now,
      openmythos_score: input.openmythosScore,
      content_hash: '', // filled after write
      sections: sectionFiles,
      assets: [],
    };
  }

  private buildExplainerMarkdown(input: BuildBundleInput, manifest: ExplainerManifest): string {
    const lines: string[] = [
      `# ${input.repositoryFullName}`,
      '',
      `Source: [${input.repositoryFullName}](${input.repositoryUrl}) @ ${input.sourceCommit}`,
      '',
      '## Sections',
      '',
    ];
    for (const section of Object.entries(input.sections)) {
      lines.push(`### ${this.sectionTitle(section[0])}`, '', section[1], '');
    }
    lines.push('', '## Facts', '');
    for (const fact of input.facts) {
      lines.push(`- ${fact.claim} ([${fact.source_ref}](${fact.source_ref}))`);
    }
    lines.push('', `---`, '', `Generated by Djimit Explore · ${manifest.generated_at}`);
    return lines.join('\n');
  }

  private buildLlmsTxt(input: BuildBundleInput): string {
    return [
      `# ${input.repositoryFullName}`,
      `Source: ${input.repositoryUrl}`,
      `Commit: ${input.sourceCommit}`,
      '',
      '## tl;dr',
      input.sections.overview || 'No overview available.',
      '',
      '## Sections',
      ...Object.keys(input.sections).map((type) => `- ${this.sectionTitle(type)}: sections/${type}.md`),
      '',
      '## Facts',
      ...input.facts.map((f) => `- ${f.claim} (source: ${f.source_ref})`),
      '',
      `OpenMythos score: ${input.openmythosScore ?? 'pending'}`,
    ].join('\n');
  }

  private sectionTitle(sectionType: string): string {
    const titles: Record<string, string> = {
      overview: 'Overview',
      architecture: 'Architecture',
      components: 'Components',
      dependencies: 'Dependencies',
      api: 'API',
      flows: 'Flows',
      deployment: 'Deployment',
      security: 'Security',
      testing: 'Testing',
      governance: 'Governance',
      health: 'Health',
    };
    return titles[sectionType] ?? sectionType;
  }

  private hashBundle(bundlePath: string): string {
    const hash = createHash('sha256');
    const files = [join(bundlePath, 'manifest.json'), join(bundlePath, 'explainer.md'), join(bundlePath, 'llms.txt'), join(bundlePath, 'facts.json')];
    for (const file of files) {
      if (existsSync(file)) {
        hash.update(this.readFile(file));
      }
    }
    return hash.digest('hex');
  }

  private readFile(path: string): string {
    return readFileSync(path, 'utf-8');
  }

}
