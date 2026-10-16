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
crash, no error an `error.tsx` boundary caught (the `no-caught-error` check), and no streamed
Suspense hole left on its fallback (`no-stuck-hole`). Each route
is classified **static** (0 KB JS) or **interactive**.

The other checks run only where they apply: the denext Deno toolchain, css-shim import
entries a killed build left in `deno.json`, platform-specific files, the iOS privacy manifest
(with an `ios/` folder), the files derived from `desktop.app.origin` (when it is set), the
pinned Deno Desktop runtime (with a `desktop.ts` entry), and, for an app on
`@denext/backend`, its keys, database, migrations and storage driver. An SPA-mode app skips
the app directory and route conformance.
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

## Errors an `error.tsx` caught

A server error that a segment `error.tsx` caught renders the boundary's fallback at status
200, a well-formed page. The probe still fails the route: it hands the app its own
`onRequestError` hook and records every render error by the path that raised it, so the
`no-caught-error` check names the error's message and the digest the server logged it under
(`an error boundary rendered a caught error: "db down" [digest 66355f2c903f1967]`). A catch
in a Suspense hole that streams after the shell counts too. Nothing about the error is added
to the response: the probe reads it in process, so production responses are unchanged.

A streamed Suspense hole whose render threw with **nothing inside it to catch** the error
streams no content, so its fallback stays in a 200 page. The `no-stuck-hole` check fails a
streamed document with a placeholder that no content filled and names the hole and the error
the server reported to `onRequestError` (`streamed Suspense hole dnx0 kept the fallback: "upstream
exploded" [digest …]`). A hole cut off by the request deadline fails it too, with no error.

## What doctor cannot see

> [!WARNING]
> **A streamed Suspense hole whose error no boundary inside it catches** keeps showing its
> fallback in the HTML (the server logs `streamed Suspense boundary failed to resolve`); the
> probe sees a rendered page. Put an `error.tsx` (or an error boundary) inside the hole, or
> assert on the route's content yourself.

More of these in [Known limitations](/docs/limitations).

## `denext audit`

`denext audit` turns the zero-npm runtime guarantee into evidence. It prints a
dependency inventory grouped by registry, a proof that the app's own runtime
source imports no npm package (offenders are listed when it doesn't hold), a note
about npm entries in the import map that only the build uses, and a suggested
baseline permission set to start from. It then runs Deno's `deno audit` for known
vulnerabilities in the lockfile's packages, and exits non-zero when either part fails.

| Flag                | Effect                                                  |
| ------------------- | ------------------------------------------------------- |
| `--sbom`            | Emit a CycloneDX SBOM (JSON) instead of the report      |
| `--strict`          | Exit non-zero if runtime source imports npm — a CI gate |
| `--json`            | Same output as `--sbom`                                 |
| `--skip-deno-audit` | Run denext's checks only                                |

`deno audit`'s own flags are forwarded to it: `--level <severity>`, `--ignore-unfixable`,
`--ignore-registry-errors`, `--socket`, `--fix`, `--ignore <cve,…>`, `--lock <file>`,
`--no-lock` and `--frozen-lockfile`, plus anything after `--`. `denext deno audit` runs
Deno's audit alone.

## `denext info`

`denext info` prints environment and project facts — no checks, no rendering: the
denext version, the Deno and V8 versions, the platform (`os/arch`), the project
directory, the resolved config file path (or `— (using defaults)`), the mode
(`app-router` or `spa`), and the resolved app directory. With `--json` the same
facts come back as an object — the quickest thing to paste into a bug report. Given a
module, file or URL instead of a directory, `denext info <module>` is Deno's `deno info`
for it (its flags pass through); Deno's cache locations are `denext deno info`.

## `denext analyze`

`denext analyze` builds and then breaks the client bundle down by chunk, with
`--md` for a markdown report (per-module on the esbuild path) to pipe into CI.
`doctor --report` shows the last build's chunks without building; `analyze`
builds fresh and goes deeper. See [Bundling](/docs/bundling), which owns it.

## Agents

The MCP server exposes the same check as the `denext_doctor` tool (pass
`report: true` for the full markdown health report), so an agent can diagnose a
project without a shell — see [MCP](/docs/mcp).
