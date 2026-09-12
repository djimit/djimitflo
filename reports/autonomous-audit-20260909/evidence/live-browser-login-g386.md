# G386 live browser login proof

Playwright opened `https://djimitflo.agentical.nl/` and followed the redirect to `/login`. The rendered page exposed Djimitflo/Agent Control Plane, Email, Password and Sign in controls. A synthetic `audit@example.invalid` login produced `POST /api/auth/login → 401 Unauthorized`; the page remained on `/login` and the browser reported zero console errors. Screenshot: `.playwright-cli/page-2026-09-11T20-02-43-196Z.png`.

No production credentials were used; authenticated dashboard routes remain unverified.
