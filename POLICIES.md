# denext — Policies (standing)

> The rules that do not change from cycle to cycle. [ROADMAP.md](./ROADMAP.md) lists only
> work still to do; [MISSION.md](./MISSION.md) says why denext exists. This file holds
> what sits between them: the engineering guardrails every change is measured against,
> and the project's security policy. [SECURITY.md](./SECURITY.md) points here so GitHub's
> Security tab keeps working.

## Engineering guardrails

- **Zero-npm runtime is sacred.** Never reintroduce an npm dependency into a shipped
  bundle (CI-enforced by the `no-npm-compat-guard` test). Build-time-only WASM/JSR tools
  are fine. OpenAPI/GraphQL libraries are **opt-in server-side** deps resolved through
  the merged-config re-exec (`src/build/module-config.ts`), the ORM-support precedent;
  prefer JSR / zero-dep options where they exist (`@denext/openapi` is zero-dep;
  `@denext/graphql` is a declared npm bridge like `@denext/effect`). What "zero-npm"
  does and does not mean is spelled out under pillar 1 of [MISSION.md](./MISSION.md).
- **Compatibility is pursued to the limit and never overstated.** The React/Next
  _surface_ is reproduced as completely as we can — that is what makes trying denext
  free — but the public claim is never "100% parity": every gap is listed in
  [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) and every deliberate divergence in
  [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md), and compat is the on-ramp, not the
  headline (pillar 5 of [MISSION.md](./MISSION.md)). Likewise the typed API surface is
  not marketed as "NestJS on Deno".
- **No decorator-metadata transpile stage.** A proposal for `experimentalDecorators` /
  `emitDecoratorMetadata` must clear a much higher bar than "it's how Nest does it."
- **Out of scope: React Native / native rendering.** Capacitor/WebView stays the mobile
  story; a true RN target is a separate future frontier.

## Security policy

denext's second mission pillar is _secure by default_ — a strict hash-based CSP, an
SSRF-safe image optimizer, same-origin CSRF-defended Server Actions, signed `httpOnly`
cookies, and a least-privilege Deno sandbox ([MISSION.md](./MISSION.md),
[the CVE-defense guide](https://denext.dev/docs/security)). If you find a way through any of that,
we want to hear about it privately first.

### Supported versions

| Version                       | Supported                              |
| ----------------------------- | -------------------------------------- |
| 2.x (`@denext/denext@^2`)     | ✅ security fixes land in the next 2.x |
| 1.x                           | ❌ upgrade to 2.x                      |
| `@denext/*` workspace plugins | ✅ latest minor of each package        |

### Reporting a vulnerability

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

### Scope

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

### Hardening references

The classes of Next.js framework CVEs denext closes by construction — and how — are
documented in [the CVE-defense guide](https://denext.dev/docs/security); the parity test
that pins them is `tests/nextjs-cve-parity.test.ts`.
