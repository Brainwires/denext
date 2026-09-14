---
title: Doctor, audit & info
slug: doctor-audit
lead: denext doctor renders every route and checks the project; denext audit inventories dependencies and proves the zero-npm runtime with a CycloneDX SBOM; denext info and analyze round out the health toolbox.
---

## `denext doctor`

`denext doctor` runs a series of checks — Deno version, app directory, config
load (a malformed `denext.config.ts` is a failed check, not a crash) and
in-process **route conformance** — exiting non-zero when a critical one fails.
Conformance renders **every route** on the real SSR path, expanding dynamic
routes through `generateStaticParams`, and asserts a well-formed document:
`<!DOCTYPE>`, one `<html>`/`<head>`/`<body>`, a non-empty `<title>`, no server
crash. Each route is classified **static** (0 KB JS) or **interactive**.
`--report` prints a markdown health report — the checks, every route's
conformance result, and the last build's client bundle by chunk and role, read
from `.denext/client` without building; `--json` emits the same data
structurally. `probe` is kept as an alias. The probe is also a library, for a CI
gate of your own:

```ts
import { formatReport, probeApp } from "denext/testing";
const report = await probeApp("./"); // renders every route, asserts valid HTML docs
if (!report.ok) throw new Error(formatReport(report)); // or run `denext doctor`
```

It renders the **JavaScript-disabled** surface, so a pass also proves
progressive enhancement is intact — see [Testing](/docs/testing).

## What doctor cannot see

> [!WARNING]
> **`denext doctor` / `probeApp` see a crash only as the framework's bare 500.**
> The "no-crash-marker" check matches the 500 fallback body (`Internal Server
> Error` and nothing else) and raw stack frames. A server error that a segment
> `error.tsx` caught and rendered at status 200 — the redacted message inside the
> boundary's own markup — is a rendered page to the probe. Assert on such routes
> yourself (a `contains` on the expected content).

More of these in [Known limitations](/docs/limitations).

## `denext audit`

`denext audit` turns the zero-npm runtime guarantee into evidence. It prints a
dependency inventory grouped by registry, a proof that the app's own runtime
source imports no npm package (offenders are listed when it doesn't hold), a note
about npm entries in the import map that only the build uses, and a suggested
baseline permission set to start from.

| Flag       | Effect                                                  |
| ---------- | ------------------------------------------------------- |
| `--sbom`   | Emit a CycloneDX SBOM (JSON) instead of the report      |
| `--strict` | Exit non-zero if runtime source imports npm — a CI gate |
| `--json`   | Same output as `--sbom`                                 |

## `denext info`

`denext info` prints environment and project facts — no checks, no rendering: the
denext version, the Deno and V8 versions, the platform (`os/arch`), the project
directory, the resolved config file path (or `— (using defaults)`), the mode
(`app-router` or `spa`), and the resolved app directory. With `--json` the same
facts come back as an object — the quickest thing to paste into a bug report.

## `denext analyze`

`denext analyze` builds and then breaks the client bundle down by chunk, with
`--md` for a markdown report (per-module on the esbuild path) to pipe into CI.
`doctor --report` shows the last build's chunks without building; `analyze`
builds fresh and goes deeper. See [Bundling](/docs/bundling), which owns it.

## Agents

The MCP server exposes the same check as the `denext_doctor` tool (pass
`report: true` for the full markdown health report), so an agent can diagnose a
project without a shell — see [MCP](/docs/mcp).
