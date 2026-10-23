---
title: Environment variables
slug: environment
lead: Where a variable comes from (the shell, then four .env tiers by mode), which ones the browser may see (NEXT_PUBLIC_ / DENEXT_PUBLIC_ through publicEnv()), how to validate the required ones at boot, and the DENEXT_* variables the framework itself reads.
---

Server code reads the environment the Deno way — `Deno.env.get("DATABASE_URL")`.
denext adds three things around that: it loads `.env` files into `Deno.env`
before your code runs, it embeds an allow-listed **public** subset in the page
for the browser, and it reads a handful of `DENEXT_*` variables of its own.
There is no build-time inlining of arbitrary variables and no `process.env` on
the native path.

## The `.env` tiers

Every CLI verb that loads your app (`dev`, `build`, `export`, `start`, `job`,
`doctor`, `analyze`, `profile`, `desktop`) reads these files from the project
directory, in this order, later files overriding earlier ones:

| Tier | File                | Loaded when                                       |
| ---- | ------------------- | ------------------------------------------------- |
| 1    | `.env`              | always                                            |
| 2    | `.env.<mode>`       | always (`.env.development`, `.env.production`, …) |
| 3    | `.env.local`        | every mode **except `test`**                      |
| 4    | `.env.<mode>.local` | always (`.env.production.local`, …)               |

A binary built with [`denext build --compile`](/docs/deployment-targets#a-single-binary-with-denext-build---compile)
loads the same tiers (production unless `DENEXT_ENV` / `NODE_ENV` says otherwise) from its
**working directory**; no `.env` file is ever embedded in it.

A missing file is skipped. The format is the usual dotenv one: `KEY=value`,
`export KEY=value`, `#` comments, single or double quotes (double quotes
interpret `\n`, `\r`, `\t`, `\"`, `\\`), and an inline `# comment` after an
unquoted value. There is **no variable expansion** — `URL=$HOST/api` stays
literal.

```sh
# .env — committed defaults
DB_PATH=app.db
DENEXT_PUBLIC_APP_NAME="My app"

# .env.local — git-ignored, your machine's secrets
SESSION_SECRET=eb1c…
```

`denext create` writes `.env*.local` and `*.local` into `.gitignore`; the
generated `.dockerignore` excludes `.env` and `.env.*` but keeps `.env.example`.

### The mode

The mode names tier 2 and 4. It is `DENEXT_ENV` if set, else `NODE_ENV`, else
the verb's own tier: **`build`, `export` and `start` are production verbs** and
load `.env.production` + `.env.production.local`; every other verb (`dev`
included) loads the `development` tier. A `DENEXT_ENV` / `NODE_ENV` you export
in the shell always wins over the verb's default, so
`DENEXT_ENV=staging denext start` reads `.env.staging`. `denext start` also
_marks_ the process as production (`DENEXT_ENV=production`, and
`NODE_ENV=production` for npm code) when neither variable was set, which is what
every "refuse in production" guard keys on.

The `test` mode skips `.env.local` (as Next does), so a machine-local override
can never leak into a test run. Note that neither `denext test` (a pass-through
to `deno test -A`) nor the test helpers (`createTestApp`) load `.env` files at
all: put test configuration in the environment of the test command, or call
`loadEnv({ mode: "test" })` from a test setup module.

### The shell always wins

A variable that is already set in the process environment is **never overwritten
by a file**. That is what lets a deploy inject `DATABASE_URL` while the repo
ships a committed `.env` with a local default. The one exception is
`loadEnv({ override:
true })`, which you would only call yourself from a script.

```ts
import { loadEnv } from "denext/server";

// A script outside the CLI (a seed, a migration) loads the same tiers by hand:
const fromFiles = await loadEnv({ dir: "./", mode: "development" });
```

`loadEnv` returns what the files declared (before the existing-environment
precedence is applied), so a script can see what was read.

## Public variables: the browser side

Only variables whose name starts with **`NEXT_PUBLIC_`** or **`DENEXT_PUBLIC_`**
can reach the browser; everything else stays server-only, whatever it contains.
They are read with `publicEnv()`, which works on both sides:

```tsx
"use client";
import { publicEnv } from "denext";

export function Footer() {
  const { DENEXT_PUBLIC_APP_NAME } = publicEnv();
  return <footer>{DENEXT_PUBLIC_APP_NAME}</footer>;
}
```

- **On the server** `publicEnv()` filters the live process environment down to
  the prefixed keys.
- **In the browser** it reads a JSON island the page embeds
  (`#__denext_public_env`) — its only source, so an unprefixed variable cannot
  reach the client through this channel. The island's values are read **at
  request time**, not at build: change `DENEXT_PUBLIC_APP_NAME` and restart, no
  rebuild needed.
- **Which keys ship**: in production, only the public keys the client bundle
  references _literally_ (`publicEnv().NEXT_PUBLIC_X`,
  `publicEnv()["NEXT_PUBLIC_X"]` or the bare name) plus the `publicEnv` list in
  `denext.config.ts`. A computed key (`publicEnv()["NEXT_PUBLIC_" + name]`) is
  invisible to that scan — list it in the config. In `denext dev` every prefixed
  variable ships. `isPublicEnvKey(name)` and `PUBLIC_ENV_PREFIXES` (both
  exported from `denext`) let you apply the same rule yourself.

```ts
// denext.config.ts
export default {
  publicEnv: ["NEXT_PUBLIC_FEATURE_A"], // always embed, even if never referenced literally
};
```

In a compat (npm-React) build a library's `process.env.NEXT_PUBLIC_X` and
`process.env.NODE_ENV` read the same island through a `process` shim, so a
migrated app keeps working; a native app should use `publicEnv()`.

> [!WARNING]
> **A secret never goes in a `NEXT_PUBLIC_` / `DENEXT_PUBLIC_` variable.** The
> prefix is a promise to ship it to every visitor. The reverse is also true:
> passing `Deno.env.get("STRIPE_SECRET")` as a prop to a `"use client"`
> component serialises it into the page. The prefix rule guards the env channel
> only.

### `--allow-env` under partial permissions

The scaffolded `start` task grants `--allow-env` in full. A narrowed grant
(`--allow-env=PORT,DATABASE_URL`) keeps the server up — every framework read is
wrapped so an unlisted key reads as unset instead of throwing — but two things
change: a `.env` key the process was not granted is skipped at load, and the
public-env island is **empty**, because listing the environment
(`Deno.env.toObject()`) is not permitted under a partial grant. If you use
`NEXT_PUBLIC_*` at all, grant `--allow-env` without a list.

## Validating required variables at boot

denext ships **no env validator** — there is nothing like Next's `@t3-oss/env`
in the framework. The recipe is a server-only module that parses a hand-picked
object with any Standard Schema (Zod, Valibot, ArkType) and throws on the first
import, so a missing secret fails the boot rather than the first request:

```ts
// lib/env.ts
import "denext/server-only"; // the build fails if this module ever reaches the browser
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  SMTP_HOST: z.string().default("localhost"),
});

// Pick the keys by name (never `Deno.env.toObject()`: it throws under a partial --allow-env).
export const env = schema.parse({
  DATABASE_URL: Deno.env.get("DATABASE_URL"),
  SESSION_SECRET: Deno.env.get("SESSION_SECRET"),
  SMTP_HOST: Deno.env.get("SMTP_HOST"),
});
```

```ts
// instrumentation.ts — `register()` runs once at server boot, before the first request
export async function register() {
  await import("./lib/env.ts");
}
```

Import `env` from server code (`lib/db.ts`, route handlers, actions) instead of
reading `Deno.env` in each place. The `denext/server-only` marker (or
`serverOnly()` from `denext`) is what makes the boundary check name this file if
a route ever bundles it for the browser — see
[Troubleshooting](/docs/troubleshooting).

Commit a **`.env.example`** listing every key the schema requires, with empty or
placeholder values; it is the one `.env` file the generated `.dockerignore`
keeps.

## Deno Deploy and other platforms

Deno Deploy has no `.env` file on disk: set variables in the project's
environment settings panel, and they arrive as real environment variables —
which, as above, win over anything committed. The same holds for Docker
(`env_file:` in the generated `docker-compose.yml` is the place to load a file; the
[self-hosted stack](/docs/deploy#self-hosted-stack-postgres-storage-migrations) reads `.env` and
lists every variable it needs in `.env.example`),
Fly, Railway, Cloud Run and systemd (`EnvironmentFile=`). `PORT` is honoured
everywhere: `denext start` listens on `--port`, else `$PORT`, else the default.

## Variables denext reads

The framework's own knobs. The first seven are fallbacks for the matching
`denext.config.ts` keys — **config > env > default** — and a malformed value is
ignored with one warning at boot rather than failing it (see
[Configuration](/docs/config#production-server)).

| Variable                            | Read by                        | Meaning                                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DENEXT_CANONICAL_ORIGIN`           | `start`, `dev`                 | The public origin (`https://example.com`, no path) when `canonicalOrigin` is unset. Pins absolute URLs, the Server Action origin check and HSTS.                                                                                                            |
| `DENEXT_TRUST_PROXY`                | `start`, `dev`                 | `1`/`true`/`yes`/`on` trusts `X-Forwarded-Proto` / `X-Forwarded-Host` (`trustForwardedHeaders`), and `X-Forwarded-For` for `clientIp()`, `requestId()` and the rate limiter. Only when clients cannot reach denext directly.                                |
| `DENEXT_RATE_LIMIT_HEADER`          | `start`, `dev`                 | The header naming the client address for per-address limits (`rateLimitHeader`, e.g. `cf-connecting-ip`). A value that is not a header name is ignored with a warning.                                                                                      |
| `DENEXT_RATE_LIMIT_TRUSTED_PROXIES` | `start`, `dev`                 | Comma-separated CIDRs of the proxies whose `DENEXT_RATE_LIMIT_HEADER` is believed (`rateLimitTrustedProxies`). See [Deployment](/docs/deploy#per-address-limits-behind-a-proxy).                                                                            |
| `DENEXT_RATE_LIMIT_LOCAL_ADDRESSES` | `start`, `dev`                 | `1`/`true`/`yes`/`on` applies per-address limits to loopback/private socket peers too (`rateLimitLocalAddresses`).                                                                                                                                          |
| `DENEXT_REQUEST_TIMEOUT_MS`         | `start`, `dev`                 | Per-request deadline in ms (`requestTimeout`; default 30 000, `0` disables). Past it the request is aborted with a `503`. Under `dev`, the dev server's own build work does not count.                                                                      |
| `DENEXT_MAX_CONCURRENCY`            | `start`, `dev`                 | In-process concurrency ceiling (`maxConcurrency`, integer ≥ 1). At capacity a request is shed with `503` + `Retry-After`.                                                                                                                                   |
| `DENEXT_ENV`                        | every verb                     | The mode: names the `.env.<mode>` tiers and, as `production`, arms the production-only guards. Wins over `NODE_ENV`.                                                                                                                                        |
| `NODE_ENV`                          | every verb                     | Read when `DENEXT_ENV` is unset (the mode) and set for npm code by `start` (`production`) and `dev` (`development`).                                                                                                                                        |
| `PORT`                              | `start`, `dev`, `desktop`      | The listen port when `--port` is not given — what Heroku, Cloud Run, Fly and Railway inject.                                                                                                                                                                |
| `DENEXT_LOG`                        | `start`, `dev`                 | Enables the default request log: `json` for one JSON object per request, any other value for a compact line. Unset: no request log.                                                                                                                         |
| `DENEXT_SHUTDOWN_DRAIN_MS`          | `start`                        | How long a shutdown waits for in-flight requests before exiting, and the latest it exits after them when an open handle (a database pool) remains (default 10 000; `0` waits indefinitely).                                                                 |
| `DENEXT_BOOT_DDL`                   | `start`, `dev`, `job`          | `off` (or `0`, `false`, `no`) stops denext's Postgres features creating their own tables at boot or first use; `dev` / `start` then check those migrations are applied. See [Databases](/docs/database#schema-at-startup).                                  |
| `DENEXT_STATE_DIR`                  | a compiled app                 | Where a [`build --compile`](/docs/deployment-targets#a-single-binary-with-denext-build---compile) binary writes its cache, job history and storage metadata (default `./.denext`).                                                                          |
| `DENEXT_DENO`                       | every verb that runs Deno      | `stock` runs stock Deno instead of [denext's toolchain](/docs/toolchain); a path uses that binary, unverified; unset or `pinned` is the default. One pair of surrounding quotes is stripped (Windows `set X="…"`).                                          |
| `DENEXT_NATIVE_CHECK`               | every verb that type-checks    | `0` / `false` / `off` type-checks with the toolchain's in-process TypeScript 6.0.3 instead of [the native TypeScript 7 compiler](/docs/toolchain#native-typescript-7-type-checking). A `DENO_CHECK_ENGINE` you set yourself always wins.                    |
| `DENEXT_TSGO_LSP`                   | `create`, `migrate`, `upgrade` | `0` / `false` / `off` / `no`: write no `"deno.unstable": ["tsgo-lsp"]` into `.vscode/settings.json`, so the editor's `deno lsp` keeps its TypeScript 6 service instead of [the TypeScript 7 language server](/docs/toolchain#typescript-7-language-server). |
| `DENEXT_PLATFORM`                   | `export`                       | The [platform-file](/docs/platform-files) target to export for when `--platform` is not given.                                                                                                                                                              |
| `DENEXT_DESKTOP_RUNTIME`            | `desktop`                      | `stock` builds and runs a desktop app on the stock Deno Desktop runtime instead of [denext's pinned one](/docs/desktop-runtime).                                                                                                                            |
| `DENEXT_MIN_DEP_AGE`                | `build`, `dev`                 | Forwards Deno's minimum-dependency-age override to the `deno bundle` child (`0` to accept a version published minutes ago).                                                                                                                                 |
| `DENEXT_BUILD_ID`                   | `build`                        | The build id that keys cached pages (random per build when unset). Pin it (the commit sha) when separately built replicas share one cache store. See [Multi-instance](/docs/multi-instance#page-keys-and-builds).                                           |
| `DENO_BIN`, `TAILWIND_BIN`          | `build`, `dev`                 | Path to the Deno binary the CLI's child processes run (it wins over the toolchain), and to a local Tailwind standalone binary.                                                                                                                              |
| `DENEXT_TAILWIND_VERSION`           | `build`, `dev`                 | The Tailwind standalone release to download when no binary is given. The default release is verified against built-in SHA-256s; another one needs `DENEXT_TAILWIND_SHA256` (its asset's hash) or it is refused.                                             |
| `DENEXT_OTA_SIGNING_KEY`            | `export`, `ota manifest`       | The PEM contents of the OTA signing key (a CI secret): `ota manifest` without `--sign`, and `export` with `spa.ota`, sign with it and stamp a `sequence`. See [Over-the-air UI updates](/docs/mobile#over-the-air-ui-updates).                              |
| `DENEXT_LOCK_TIMEOUT`               | every locking verb             | Seconds to wait for a [build lock](/docs/cli#build-locks) another denext process holds before failing (unset: wait until it is free).                                                                                                                       |

Development and diagnostics — all opt-in, none read in production paths:

| Variable                         | Meaning                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `DENEXT_DEV_UNBUNDLED=0`         | Force the bundled whole-route refresh instead of the default per-module HMR loop.                                       |
| `DENEXT_DEV_TYPECHECK=0`         | Turn off the dev server's background type-check (and its overlay).                                                      |
| `DENEXT_RAW_DIAGNOSTICS=1`       | Print diagnostics as Deno reports them, unexplained (= `--raw`; [details](/docs/error-handling#explained-type-errors)). |
| `DENEXT_DEV_CAPTURE_CONSOLE=0`   | Stop the dev server buffering the server console for `denext_dev_logs`.                                                 |
| `DENEXT_DEV_INSPECT=1`           | Arm the live component-tree inspector from the first render (the MCP DevTools tools).                                   |
| `DENEXT_DEV_META=0`              | Kill switch for the DevTools metadata the dev build emits.                                                              |
| `DENEXT_NO_MINIFY=1`             | Emit readable, unminified production bundles (`denext profile` sets it for you).                                        |
| `DENEXT_ANALYZE=1`               | Capture per-module sizes for `denext analyze --md` (set by the verb).                                                   |
| `DENEXT_TIMING=1`                | Print wall-time instrumentation for a slow build or render.                                                             |
| `DENEXT_DEBUG_CACHE=1`           | Log every `"use cache"` hit and miss to stderr.                                                                         |
| `DENEXT_DEBUG_SUSPENSE=1`        | Record where each `use()` suspension started, for a Suspense boundary that never settles.                               |
| `DENEXT_PROXY_DEBUG=1`           | Log the SPA dev proxy's decisions.                                                                                      |
| `DENEXT_NEXT_EVAL_TIMEOUT_MS`    | Deadline for evaluating a migrated app's `next.config.*` in a child process.                                            |
| `DENEXT_EDITOR`                  | The command the dev overlay's open-in-editor link runs (else `VISUAL`, `EDITOR`, then `code`).                          |
| `DENEXT_UI_DISCOVERY_TIMEOUT_MS` | Deadline for `denext ui`'s project-verb discovery child (default 8 000).                                                |

The desktop packaging verbs read their signing inputs from `DENEXT_APP_NAME`,
`DENEXT_CODESIGN_IDENTITY`, `DENEXT_ENTITLEMENTS`, `DENEXT_PROVISIONING_PROFILE`,
`DENEXT_INSTALLER_IDENTITY` (the "Developer ID Installer" identity that signs a `.pkg`), the notary
credentials — `DENEXT_NOTARY_PROFILE` (a keychain profile), or an App Store Connect API key as
`DENEXT_NOTARY_KEY` + `DENEXT_NOTARY_KEY_ID` (+ `DENEXT_NOTARY_ISSUER`) — `DENEXT_SIGN_TIMESTAMP_URL`,
and on Windows `DENEXT_WINDOWS_CERT` + `DENEXT_WINDOWS_CERT_PASSWORD` (a `.pfx`) or
`DENEXT_WINDOWS_CERT_THUMBPRINT` (a certificate in the Windows store) — see
[Desktop apps](/docs/desktop). `denext build --compile --sign` (and a configured `compile.sign`)
reads the same variables, all but `DENEXT_APP_NAME`, `DENEXT_PROVISIONING_PROFILE` and
`DENEXT_INSTALLER_IDENTITY`, to sign and notarize the
[compiled binary](/docs/deployment-targets#a-single-binary-with-denext-build---compile). They come
from the environment only and are never printed.

The toolchain's Node.js-compatibility switches — `DENO_NO_SLOPPY_IMPORTS=1`,
`DENO_NO_TSCONFIG_PATHS=1`, `DENO_NO_DETECT_CJS=1` and `DENO_NO_BETTER_SQLITE3_COMPAT=1` — are
described under [npm packages as on Node.js](/docs/toolchain#npm-packages-as-on-nodejs).
