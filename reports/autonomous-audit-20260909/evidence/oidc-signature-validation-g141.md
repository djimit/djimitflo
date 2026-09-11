# G141 OIDC ID-token signature validation

`OIDCAbstraction.validateIdToken` now verifies JWT signatures against the provider JWKS `kid`, restricts signing algorithms, and enforces issuer/audience/expiry through `jsonwebtoken`; malformed, tampered, wrong-issuer and unknown-key tokens fail closed. Focused security coverage passes **4/4**. Full server verification passes **2459/20 skipped** (309 files, 2 skipped), full workspace **2748/20 skipped** (dashboard 151/151), `/loops` **12/12**, build/type-check/lint and mutation **71/71 killed** remain green.

No external identity provider, deployment, merge or production mutation was performed.
