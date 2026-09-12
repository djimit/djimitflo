# G259 server regression

Fresh full server regression after the swarm mission-control permission repair:

- 322 test files passed, 2 skipped
- 2,515 tests passed, 20 skipped, 0 failed
- focused role-permission regression: 1 file passed, 6 tests passed

The first parallel baseline had one transient loop-service auth response-shape failure; the isolated retry passed 25/25 and the subsequent complete server run passed without failure. The intermittent is retained in `verification-summary.json`.
