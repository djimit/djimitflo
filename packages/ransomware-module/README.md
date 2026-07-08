# Anti-Agentic Ransomware Module

Detection and response module for JADEPUFFER-class agentic ransomware. Loosely coupled — operates standalone or integrates with Djimitflo via adapter.

## Architecture

```
ransomware-module/
├── src/
│   ├── patterns.ts                    # JADEPUFFER IoC regex patterns (CRITICAL + HIGH)
│   ├── types/index.ts                 # TypeScript interfaces
│   ├── services/
│   │   ├── ransomware-indicator-service.ts  # Command pattern matching engine
│   │   ├── behavioral-detector.ts           # Entropy/bulk-ops/beacon detection
│   │   ├── self-narration-detector.ts       # LLM payload marker detection
│   │   ├── confidence-scorer.ts             # Composite confidence scoring
│   │   ├── response-orchestrator.ts         # Kill/quarantine/forensic/backup
│   │   └── forensic-capture.ts              # Evidence capture with SHA-256
│   ├── adapters/
│   │   └── djimitflo-adapter.ts             # Djimitflo swarmEventBus bridge
│   └── index.ts                             # Public API exports
├── tests/                              # 35 unit tests (vitest)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Quick Start

```typescript
import { RansomwareIndicatorService, DjimitfloRansomwareAdapter } from '@djimitflo/ransomware-module';

// Standalone usage
const service = new RansomwareIndicatorService({ mode: 'detect' });
const result = service.analyzeCommand('DROP DATABASE production', 'agent-1');
// result.confidence = 0.95, result.riskLevel = 'CRITICAL', result.recommendedAction = 'kill'

// Djimitflo integration
const adapter = new DjimitfloRansomwareAdapter({
  swarmEventBus: djimitfloEventBus,
  ransomwareConfig: { mode: 'enforce' },
  onKill: (agentId, reason) => console.log(`Killed ${agentId}: ${reason}`),
  onQuarantine: (agentId, reason) => console.log(`Quarantined ${agentId}: ${reason}`),
  onForensicCapture: (evidence) => saveEvidence(evidence),
  onBackupRestore: (db, point) => triggerRestore(db, point)
});
adapter.start();
```

## Detection Layers

1. **Command Patterns** — Regex matching against JADEPUFFER IoCs (AES_ENCRYPT, DROP DATABASE, MinIO default creds, etc.)
2. **Behavioral Signals** — Threshold monitoring (entropy >7.5, >50 file renames/60s, periodic beacons)
3. **Self-Narration Markers** — LLM-specific payload signatures (ROI commentary, ephemeral keys, ransom contacts)

## Response Actions

| Confidence | Risk Level | Action |
|------------|------------|--------|
| ≥0.95 | CRITICAL | Kill agent + forensic capture |
| 0.85-0.94 | CRITICAL | Require approval |
| 0.65-0.84 | HIGH | Require approval |
| 0.4-0.64 | MEDIUM | Log only |
| <0.4 | LOW | No action |

## Circuit Breaker

- 3 violations in 5 min → Block for 15 min
- 5 violations in 15 min → Quarantine (requires human release)
- Auto-reset after window expires

## Modes

- `shadow` — Detect-only, no actions taken (logs what would happen)
- `detect` — Detect and log, require approval for kills
- `enforce` — Full automated response (kill, quarantine, forensic)

## JADEPUFFER IoCs Detected

- C2: 45.131.66.106:4444 (30-min beacon)
- Staging: 64.20.53.230
- Bitcoin: 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy
- Email: e78393397@proton.me
- Entry: CVE-2025-3248 (Langflow RCE)
- Nacos: CVE-2021-29441 (auth bypass)

## OpenMythos Corpus

30 cases in `~/OpenMythos/openmythos-benchmark/cases/ransomware-corpus.jsonl`:
- 5 injection (RCE, JWT forgery, SQL backdoor, MinIO creds, container escape)
- 5 hierarchy (OUTFILE, UDF, docker.sock, crontab, root abuse)
- 5 tool-scope (MinIO enum, credential.json, .env exfil, network scan, terraform)
- 5 canary (self-narration, ephemeral key, staging claim, Bitcoin, ProtonMail)
- 5 temporal-reasoning (attack chain, multi-phase, beacon, correction, cleanup)
- 5 overthinking (bulk UPDATE, index rebuild, VACUUM, migration, pentest)

## Tests

```bash
npm test
# 35 tests, all passing
```

## License

Internal — Djimitflo security module.
