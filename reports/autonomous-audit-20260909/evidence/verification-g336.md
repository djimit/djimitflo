# Verification checkpoint G336

After the knowledge-events route proof:

- `npm run build` exited 0;
- `npm run type-check` exited 0;
- `npm run lint` exited 0;
- server regression: 2,563 passed, 20 skipped, 0 failed;
- workspace regression: 2,854 passed, 20 skipped, 0 failed;
- governed loop recheck: 23 files, 296 passed, 1 skipped, 0 failed;
- contract inventory: 585 routes, 551 direct references, 0 critical unclassified, MCP 56/56.

`assurance:truth` and `assurance:live` remain fail-closed on external identity
and certification prerequisites.
