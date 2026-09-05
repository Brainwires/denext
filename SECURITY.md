# Security policy

denext's second mission pillar is _secure by default_ — a strict hash-based CSP, an
SSRF-safe image optimizer, same-origin CSRF-defended Server Actions, signed `httpOnly`
cookies, and a least-privilege Deno sandbox ([MISSION.md](./MISSION.md),
[CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md)). If you find a way through any of that,
we want to hear about it privately first.

## Supported versions

| Version                       | Supported                              |
| ----------------------------- | -------------------------------------- |
| 2.x (`@denext/denext@^2`)     | ✅ security fixes land in the next 2.x |
| 1.x                           | ❌ upgrade to 2.x                      |
| `@denext/*` workspace plugins | ✅ latest minor of each package        |

## Reporting a vulnerability

- **Preferred:** open a private report via GitHub Security Advisories on this repository
  (**Security → Report a vulnerability**). Only maintainers can read it.
- Do **not** open a public issue, discussion, or pull request for a suspected vulnerability.
- Include: the affected entry point (`denext/server`, `denext/next/*`, a plugin…), a
  minimal reproduction (a route/middleware/config snippet and the request that triggers
  it), the impact you observed, and the denext + Deno versions.

You will get an acknowledgement within **3 business days** and a triage decision within
**7**. We aim to ship a fix and publish an advisory within **90 days** of the report;
for actively exploited issues we move faster and will coordinate the disclosure date
with you. Credit is given in the advisory and the CHANGELOG unless you ask otherwise.

## Scope

**In scope** — anything in this repository that ships to an app:

- the framework runtime and request pipeline (`src/server/**`, `src/runtime/**`,
  `src/client/**`), including auth/session, Server Actions, middleware, the cache, Live,
  the image optimizer, and static/metadata file serving;
- the build/CLI when its output is what a production server runs (`denext build`,
  `denext start`, `denext export`, the scaffold and `denext migrate` output);
- the dev server **only** for issues reachable from a foreign origin or another local
  user (the dev server is loopback-only by design — see the "Security posture" section of
  [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md));
- the first-party `@denext/*` packages in `packages/`.

**Out of scope**: vulnerabilities in a user's own application code or third-party
`npm:`/`jsr:` dependencies an app adds; findings that require a compromised host or a
developer running untrusted code; issues already listed as accepted trade-offs in
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md); reports from automated scanners with no
reproduction.

## Hardening references

The classes of Next.js framework CVEs denext closes by construction — and how — are
documented in [CVE-DEFENSE-GUIDE.md](./CVE-DEFENSE-GUIDE.md); the parity test that pins
them is `tests/nextjs-cve-parity.test.ts`.
