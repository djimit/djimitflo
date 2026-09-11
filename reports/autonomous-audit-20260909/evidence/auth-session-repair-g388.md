# G388 anonymous auth-session repair

Root cause: `restoreSession()` attempted the cookie refresh path for an anonymous browser and surfaced the expected 401 `Invalid or expired browser session` as a login-page error. The shared auth boundary now leaves an absent access-token session unmarked on 401/403, and `restoreSession()` suppresses only that exact anonymous-session message; existing-token failures remain visible.

Proof: `packages/dashboard/src/lib/auth-session.test.ts` passes 20/20, including the new anonymous-login regression. A rebuilt dashboard rendered a clean `/login` form with no session error text. The complete workspace regression then passed 2,864 tests with 20 skipped and 0 failed.
