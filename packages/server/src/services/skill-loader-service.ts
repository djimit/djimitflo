/**
 * SkillLoaderService — dynamic skill loading from OKF markdown files.
 *
 * Based on OpenClaw skills pattern + Deep Agents skills:
 * - Skills are SKILL.md files in a directory structure
 * - Each skill has: name, description, instructions, tools, triggers
 * - Skills are loaded dynamically and can be hot-reloaded
 * - Per-agent skill assignment (security agent ≠ dev agent)
 * - Public skill registry API for community sharing
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Database } from 'better-sqlite3';

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  instructions: string;
  tools: string[];
  triggers: string[];
  author: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
  contentHash: string;
}

interface AgentSkillAssignment {
  agentId: string;
  skillId: string;
  enabled: boolean;
  assignedAt: string;
}

const SKILLS_DIR = process.env.DJIMITFLO_SKILLS_DIR || join(process.cwd(), '.opencode/skills/generated');

export class SkillLoaderService {
  private skills: Map<string, SkillDefinition> = new Map();

  constructor(private db: Database, private skillsDir = SKILLS_DIR) {
    this.ensureTables();
    this.loadSkills();
  }

  /**
   * Load all skills from the skills directory.
   */
  loadSkills(): SkillDefinition[] {
    const loaded: SkillDefinition[] = [];

    if (!existsSync(this.skillsDir)) {
      return loaded;
    }

    const entries = readdirSync(this.skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(this.skillsDir, entry.name);
      const skillMdPath = join(skillPath, 'SKILL.md');

      if (!existsSync(skillMdPath)) continue;

      try {
        const content = readFileSync(skillMdPath, 'utf8');
        const skill = this.parseSkillMd(content, entry.name);
        this.skills.set(skill.id, skill);
        loaded.push(skill);
      } catch { /* skip invalid skills */ }
    }

    return loaded;
  }

  /**
   * Get a skill by ID.
   */
  getSkill(id: string): SkillDefinition | null {
    return this.skills.get(id) || null;
  }

  /**
   * List all loaded skills.
   */
  listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Enable/disable a skill.
   */
  setSkillEnabled(id: string, enabled: boolean): void {
    const skill = this.skills.get(id);
    if (skill) skill.enabled = enabled;
  }

  /**
   * Assign a skill to an agent.
   */
  assignSkillToAgent(agentId: string, skillId: string): AgentSkillAssignment {
    const assignment: AgentSkillAssignment = {
      agentId,
      skillId,
      enabled: true,
      assignedAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT OR REPLACE INTO agent_skills (agent_id, skill_id, enabled, assigned_at)
      VALUES (?, ?, 1, ?)
    `).run(agentId, skillId, assignment.assignedAt);

    return assignment;
  }

  /**
   * Remove a skill from an agent.
   */
  removeSkillFromAgent(agentId: string, skillId: string): void {
    this.db.prepare('DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?').run(agentId, skillId);
  }

  /**
   * Get skills assigned to an agent.
   */
  getAgentSkills(agentId: string): SkillDefinition[] {
    const rows = this.db.prepare(`
      SELECT skill_id FROM agent_skills WHERE agent_id = ? AND enabled = 1
    `).all(agentId) as Array<{ skill_id: string }>;

    return rows
      .map((row) => this.skills.get(row.skill_id))
      .filter((s): s is SkillDefinition => s !== undefined);
  }

  /**
   * Find skills matching a trigger.
   */
  findSkillsByTrigger(trigger: string): SkillDefinition[] {
    return Array.from(this.skills.values()).filter(
      (skill) => skill.enabled && skill.triggers.some((t) => t.toLowerCase().includes(trigger.toLowerCase()))
    );
  }

  /**
   * Get skill statistics.
   */
  getStats(): {
    totalSkills: number;
    enabledSkills: number;
    assignedSkills: number;
  } {
    const assigned = (this.db.prepare('SELECT COUNT(*) as c FROM agent_skills WHERE enabled = 1').get() as any)?.c || 0;

    return {
      totalSkills: this.skills.size,
      enabledSkills: Array.from(this.skills.values()).filter((s) => s.enabled).length,
      assignedSkills: assigned,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private parseSkillMd(content: string, dirName: string): SkillDefinition {
    // Parse YAML frontmatter + markdown body
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    const metadata: Record<string, unknown> = {};
    let body = content;

    if (frontmatterMatch) {
      // Simple YAML parsing (key: value pairs)
      const lines = frontmatterMatch[1].split('\n');
      for (const line of lines) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          metadata[match[1]] = match[2].trim();
        }
      }
      body = frontmatterMatch[2];
    }

    return {
      id: dirName,
      name: (metadata.name as string) || dirName,
      description: (metadata.description as string) || '',
      version: (metadata.version as string) || '0.1.0',
      instructions: body.trim(),
      tools: metadata.tools ? String(metadata.tools).split(',').map((t) => t.trim()) : [],
      triggers: metadata.triggers ? String(metadata.triggers).split(',').map((t) => t.trim()) : [],
      author: (metadata.author as string) || 'unknown',
      enabled: true,
      metadata,
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_skills (
        agent_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, skill_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_skills_agent_id ON agent_skills(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_skills_skill_id ON agent_skills(skill_id);
    `);
  }
}
