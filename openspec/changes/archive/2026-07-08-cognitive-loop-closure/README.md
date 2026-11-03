# Cognitive Loop Closure

DjimFlo orchestrates loops but does not learn from them. This change adds an episodic memory and strategy layer that records loop outcomes, mines successful patterns, and applies proven strategies to future loops of the same goal type.

Validation:

```bash
openspec validate cognitive-loop-closure --strict
npm run lint
npm run type-check
npm run test
npm run build
```
