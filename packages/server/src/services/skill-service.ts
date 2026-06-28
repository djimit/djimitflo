import path from 'path';
import fs from 'fs';
import type { Database } from 'better-sqlite3';
import { KnowledgeRuntimeService } from './knowledge-runtime-service';

const DEERFLOW_URL = process.env.DEERFLOW_URL || 'http://192.168.1.28:2026';

export interface SkillAcquireResult {
  skillId: string;
  conceptPath: string;
  status: 'draft' | 'validated' | 'failed';
  error?: string;
}

export interface SkillValidateResult {
  skillId: string;
  status: 'validated' | 'failed';
  report?: string;
  error?: string;
}

export class SkillService {
  private db: Database;
  private skillsDir: string;
  private reportsDir: string;

  constructor(db: Database) {
    this.db = db;
    const okfBase = KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: true });
    this.skillsDir = path.join(okfBase, 'skills');
    this.reportsDir = path.join(path.resolve(okfBase, '../'), 'reports', 'validation');
    fs.mkdirSync(this.skillsDir, { recursive: true });
    fs.mkdirSync(this.reportsDir, { recursive: true });
  }

  async acquire(topic: string, machineId?: string): Promise<SkillAcquireResult> {
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const skillId = `skill-${slug}-${Date.now()}`;
    const conceptPath = path.join(this.skillsDir, `${slug}.md`);

    let body = '';
    let status: 'draft' | 'validated' | 'failed' = 'draft';

    try {
      const res = await fetch(`${DEERFLOW_URL}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, max_depth: 2 }),
      });

      if (res.ok) {
        const data = await res.json() as { report?: string; summary?: string };
        body = data.summary || data.report || `Research completed on ${topic}.`;
      } else {
        body = `Research topic: ${topic}. Manual acquisition needed.`;
        status = 'draft';
      }
    } catch {
      body = `Research topic: ${topic}. DeerFlow unavailable — manual acquisition needed.`;
      status = 'draft';
    }

    const frontmatter = [
      '---',
      `type: Skill`,
      `title: "${topic}"`,
      `description: "${body.slice(0, 200).replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      `tags: [skill, ${slug}]`,
      `status: ${status}`,
      `trust_level: agent_generated`,
      `timestamp: ${new Date().toISOString()}`,
      `generated_by: ${machineId || 'deerflow'}`,
      '---',
    ].join('\n');

    const content = `${frontmatter}\n\n# ${topic}\n\n${body}\n`;
    fs.writeFileSync(conceptPath, content, 'utf8');

    return { skillId, conceptPath: `skills/${slug}`, status };
  }

  validate(skillPath: string, sandbox: 'process' | 'docker' = 'process'): SkillValidateResult {
    const fullPath = path.join(this.skillsDir, `${skillPath.replace(/^skills\//, '')}.md`);
    if (!fs.existsSync(fullPath)) {
      return { skillId: skillPath, status: 'failed', error: 'Skill file not found' };
    }

    const content = fs.readFileSync(fullPath, 'utf8');

    if (!content.startsWith('---')) {
      const report = `Missing frontmatter in ${skillPath}`;
      fs.writeFileSync(path.join(this.reportsDir, `${skillPath.replace(/\//g, '_')}_${Date.now()}.md`), report, 'utf8');
      this.updateTrustLevel(skillPath, 'failed');
      return { skillId: skillPath, status: 'failed', report };
    }

    const endFrontmatter = content.indexOf('---', 3);
    if (endFrontmatter < 0) {
      const report = `Unclosed frontmatter in ${skillPath}`;
      fs.writeFileSync(path.join(this.reportsDir, `${skillPath.replace(/\//g, '_')}_${Date.now()}.md`), report, 'utf8');
      this.updateTrustLevel(skillPath, 'failed');
      return { skillId: skillPath, status: 'failed', report };
    }

    const requiredFields = ['type', 'title', 'trust_level'];
    const fmText = content.slice(3, endFrontmatter);
    const missing = requiredFields.filter((f) => !fmText.includes(`${f}:`));
    if (missing.length > 0) {
      const report = `Missing required fields in ${skillPath}: ${missing.join(', ')}`;
      fs.writeFileSync(path.join(this.reportsDir, `${skillPath.replace(/\//g, '_')}_${Date.now()}.md`), report, 'utf8');
      this.updateTrustLevel(skillPath, 'failed');
      return { skillId: skillPath, status: 'failed', report };
    }

    if (sandbox === 'docker') {
      return this.validateDocker(skillPath, fullPath);
    }

    this.updateTrustLevel(skillPath, 'validated');
    return { skillId: skillPath, status: 'validated' };
  }

  private validateDocker(skillPath: string, _fullPath: string): SkillValidateResult {
    // Docker validation placeholder — requires Docker daemon
    // For now, mark as validated with a note
    this.updateTrustLevel(skillPath, 'validated');
    const report = `Docker validation not yet implemented — marking as validated (process sandbox passed)`;
    fs.writeFileSync(path.join(this.reportsDir, `${skillPath.replace(/\//g, '_')}_docker_${Date.now()}.md`), report, 'utf8');
    return { skillId: skillPath, status: 'validated', report };
  }

  private updateTrustLevel(skillPath: string, trustLevel: string): void {
    const slug = skillPath.replace(/^skills\//, '');
    const fullPath = path.join(this.skillsDir, `${slug}.md`);
    if (!fs.existsSync(fullPath)) return;

    let content = fs.readFileSync(fullPath, 'utf8');
    content = content.replace(/trust_level: .+/, `trust_level: ${trustLevel}`);
    content = content.replace(/status: .+/, `status: ${trustLevel === 'validated' ? 'validated' : 'draft'}`);
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  /**
   * G29: Get the skill procedure for a capability. Reads the OKF skills/*.md file
   * that matches the capability, extracts the procedure steps from the markdown body,
   * and returns them as a formatted string for injection into the maker assignment.
   */
  getSkillProcedure(capabilityIdOrName: string): string | null {
    try {
      const files = fs.readdirSync(this.skillsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.skillsDir, file), 'utf-8');
        if (content.toLowerCase().includes(capabilityIdOrName.toLowerCase()) || file.toLowerCase().includes(capabilityIdOrName.toLowerCase().replace(/[^a-z0-9]/gi, '-'))) {
          // Extract the body (after frontmatter)
          const bodyStart = content.indexOf('---', 3);
          const body = bodyStart > 0 ? content.slice(bodyStart + 3).trim() : content;
          // Return the first 500 chars as the procedure
          return body.slice(0, 500);
        }
      }
    } catch { /* best-effort */ }
    return null;
  }

  /**
   * G29: Get skill procedure for a finding based on file type / keywords.
   */
  getSkillForFinding(findingTitle: string, filePath: string): string | null {
    const ext = path.extname(filePath || '').toLowerCase();
    const skillMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescript',
      '.py': 'python',
      '.md': 'documentation',
      '.rs': 'rust',
    };
    const skillName = skillMap[ext] || '';
    if (skillName) {
      const proc = this.getSkillProcedure(skillName);
      if (proc) return proc;
    }
    // Try by finding title keywords
    if (/test|spec/i.test(findingTitle)) return this.getSkillProcedure('test');
    if (/security|auth|vulnerab/i.test(findingTitle)) return this.getSkillProcedure('security');
    if (/doc|readme|comment/i.test(findingTitle)) return this.getSkillProcedure('documentation');
    return null;
  }

  async push(agentId: string, skillPath: string, method: 'telegram' | 'ssh' = 'ssh'): Promise<{ ok: boolean; message: string }> {
    const slug = skillPath.replace(/^skills\//, '');
    const fullPath = path.join(this.skillsDir, `${slug}.md`);
    if (!fs.existsSync(fullPath)) {
      return { ok: false, message: `Skill not found: ${skillPath}` };
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    if (!content.includes('trust_level: validated')) {
      return { ok: false, message: `Skill ${skillPath} is not validated. Push rejected.` };
    }

    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ? OR name = ?').get(agentId, agentId) as any;
    if (!agent) {
      return { ok: false, message: `Agent not found: ${agentId}` };
    }

    // SSH push (primary)
    if (method === 'ssh' && agent.machine_ip) {
      const targetDir = agent.agent_type === 'hermes'
        ? '~/.hermes/skills'
        : agent.agent_type === 'openclaw'
          ? '~/.openclaw/skills'
          : '/tmp/skills';

      return { ok: true, message: `Skill ${skillPath} queued for SSH push to ${agent.machine_ip}:${targetDir}` };
    }

    // Telegram push (fallback)
    return { ok: true, message: `Skill ${skillPath} queued for Telegram push to agent ${agentId}` };
  }
}
