# Security Policy

## Security Features

DjimFlo is built security-first:

- **RSI Safety Guard** — Bounded mutation budget (5/day), immutable audit log, kill switch
- **Capability Freeze** — Security/audit code cannot be modified by self-improvement
- **Epistemic Gates** — Source quality, logical consistency, perspective coverage, falsifiability
- **Dual-Approve** — Two reviewers required for structural changes
- **Audit Trail** — Every action logged with actor attribution
- **Secret Scanning** — Automated via GitHub Actions

## Reporting a Vulnerability

**DO NOT** open a public issue for security vulnerabilities.

Email: dlandman@djimit.nl

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if any)

We follow coordinated disclosure. You will receive a response within 48 hours.

## Scope

In scope:
- Server backend (`packages/server/`)
- Dashboard frontend (`packages/dashboard/`)
- Dependencies with known CVEs
- Self-modification capabilities (RSI Engine)

Out of scope:
- Third-party AI model providers
- User-managed infrastructure

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.6.x   | Yes       |
| < 0.6   | No        |
