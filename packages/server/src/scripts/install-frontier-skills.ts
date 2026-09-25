/** Install the §34 frontier analysis skills into the OKF skills dir: `npx tsx src/scripts/install-frontier-skills.ts [--force]`. */
import path from 'path';
import { KnowledgeRuntimeService } from '../services/knowledge-runtime-service';
import { installFrontierSkills } from '../services/frontier-expert-skills';

const skillsDir = path.join(KnowledgeRuntimeService.resolveCanonicalOkfBase({ allowMissing: false }), 'skills');
for (const item of installFrontierSkills(skillsDir, { force: process.argv.includes('--force') })) console.log(`${item.action}\t${item.path}`);
