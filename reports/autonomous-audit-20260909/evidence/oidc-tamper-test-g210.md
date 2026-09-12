# G210 OIDC tamper-test hardening

The OIDC signature regression previously changed the first signature character to `A`, which was a no-op when the generated signature already began with `A`. The test now always replaces the final signature character with a different base64url character. The isolated OIDC suite passes 4/4 and the full server suite passes 2489/20.

This repairs verification determinism; production OIDC provider behavior remains outside the local fixture scope.
