# Skill lifecycle and transfer assessment

Metadata/hashes were read without executing skills or exporting instruction bodies. Canonical repo `/Users/dlandman/agent-skills`, clean SHA39a3c44e23f8c0d4b84a0a7597595206b764c26c, contains163SKILL.md packages. Existing strict validator completed0 errors,123 pass/40 warnings, lifecycle audit163/163 and162existing manifests. Warnings include absent license/long instruction bodies. Structural validation cannot establish task benefit, script safety or runtime adoption. [Validation log](canonical-skill-validation.txt), [collector](inspect-skill-files.py), [analysis](offline-analysis.json).

| Location / bounded roots | Installations / unique normalized bodies | Duplicate body instances / same-name different canonical body |
|---|---|---|
| Macmini Hermes |133/133 |0/8 |
| Eve-V Hermes |151/150 |1/22 |
| Workstation Hermes default/profile + OpenClaw roots |347/204 |143/20 |

No runtime package matched the canonical **name and normalized body** in this snapshot. Most runtime names are outside this canonical set (125/129/327 respectively). This is a provenance/crosswalk finding, not proof of failed deployment: packages may have independent upstreams, intentional platform adaptations and local roots. Duplicate bodies can be justified profile isolation. Comparison excludes script/manifest contents and full dependency graphs; do not delete or sync anything based on these hashes. Collector followed symlinks with cycle guard, excluded .git/node_modules/venv/cache, capped at10,000dirs per root; no root hit cap. Missing name/version is unknown, not inferred from parent directory.

## Existing lifecycle mechanisms

1. Acquisition: SkillService can request DeerFlow research and source-bound draft creation; it is not invoked in this audit. Outbound policy/readiness may block it.
2. Validation: SkillLoaderService checks frontmatter/admission/manifest/workflow hashes and security constraints. A lighter SkillService frontmatter validation must not be presented as Docker execution verification; sandbox explicitly unavailable.
3. Registration/activation: configuredSkillsDir and allowlist unset; agent_skills0. Shared enable/disable/reload routes503 honestly indicate unavailable activation. Remote native skills remain a separate execution mechanism.
4. Execution/attribution: task skill metadata guarded, skill outcomes exist, but no admitted DjimitFlo package currently demonstrates that path. Governance evaluator can consume instructions in its own evaluation path; do not conflate this with production task injection.
5. Evaluation:1394skill_outcomes include production336, fleet139, gym893, merge26. All lack skill_version.275havecontenthash across production/gym; fleet none. Success labels have distinct authorities. SkillEvolutionGym averaging caller-provided metric numbers lacks common-unit meaning; its dormant state is not evidence of production quality assessment.
6. Improvement/composition:106distilled candidate cards (84skill/22anti-pattern) are record-only, never injected to preserve existing frozen context. SkillEvolutionEngine explicitly dormant because numeric trait mutation is not executable genotype. That restraint is correct.
7. Retirement:477 deprecated capability records and canonical manifest lifecycle metadata exist, but neither is a complete execution-backed package retirement report.

High-value change: identify the exact installed/admitted package and scripts/manifest hash on actual native invocation, reuse skill_outcomes/task/agent links with explicit evidence authority, and compare stable tasks across existing adapters. Version identity, task and evaluator must precede any “best skill” selector or autonomous transfer. Add an installed-versus-used view to existing Knowledge/Agents, not another lifecycle service.

Candidate overlap can first be reviewed within same runtime/name/owner and exact body+script hashes; assess invocation frequency before pruning. Semantic overlap/transferability require task-level tests; this audit did not read all instruction bodies or execute every package. No skill promotion, retirement, deletion or distribution was performed.
