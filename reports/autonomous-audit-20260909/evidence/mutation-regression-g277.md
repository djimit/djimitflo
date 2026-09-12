# G277 mutation regression

`npm run test:mutation --silent` instruments the configured three source regions (81 mutants). Initial dry run: 67 tests. Final score: 100%; 71 killed, 0 survived, 0 uncovered and 0 errors. Scope is configured mutation targets only; the swarm-intel/decomposer changes are covered by focused and full regression tests, not by this mutation configuration.
