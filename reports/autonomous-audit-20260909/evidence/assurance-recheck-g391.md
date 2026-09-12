# G391 assurance recheck

`npm run assurance:truth` ran against the current post-auth-repair dirty state while an isolated server was available on `127.0.0.1:3001`.

Pass: supported Node, dependency audit, contract inventory (585/585 routes; 56/56 MCP), Paperclip health, Codex/OpenCode binary checks and diff check. Blocked: OpenMythos certification; required DjimFlo/event-bus/UAMS/Ollama/Qdrant probes timed out; live identity health/version were 200 but authenticated provenance was 401. Optional Context7 returned 405 and LiteLLM was unavailable. No external service was mutated and no promotion/deployment was claimed.
