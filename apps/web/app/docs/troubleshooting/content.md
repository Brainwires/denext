---
title: Troubleshooting
slug: troubleshooting
lead: Symptom → cause → fix for the errors people actually hit, each pointing at the page that owns the detail.
---

Each entry is one symptom: what you see, the one-line cause, the fix, and a link
to the page that owns the full explanation. Search this page for the error text.

## "No matching export" for `unstable_navigation` / `unstable_prefetch`

**Cause.** Next 16.4 canary's navigation-stage APIs (`unstable_navigation` /
`unstable_prefetch` from `next/cache`, the "prefetch stage" experiment) are not
provided, so a compat build of an app importing them fails to link.

**Fix.** Pin the app before the commit that adopted those APIs, or stop
importing them. There is no shim — the upstream surface is still a canary
experiment.

See [Known limitations](/docs/limitations) for the full list of upstream-named unstable and
unprovided APIs.

## `denext migrate` fails resolving the CLI's own build dependencies

**Cause.** The project already has `node_modules` installed, so Deno runs in
manual-`node_modules` mode and cannot resolve the migrate CLI's own build
dependencies.

**Fix.** Run migrate with node-modules resolution turned off for the CLI
process. Your app's `node_modules` is untouched — the compat layer still loads
your npm React libraries from it.

```sh
deno run --node-modules-dir=none -A jsr:@denext/denext/cli migrate
```

See [Migrating from Next.js](/docs/migrating) § 3.

## Yarn Plug'n'Play install fails to resolve

**Cause.** denext resolves an app's dependencies from a real `node_modules`
directory; Yarn PnP's virtual filesystem is unsupported.

**Fix.** Switch the linker and reinstall.

```yaml
# .yarnrc.yml
nodeLinker: node-modules
```

See [Migrating from Remix](/docs/migrating-remix) § 1.

## A freshly published `@denext/*` version is refused ("minimum dependency age")

**Cause.** Deno's minimum-dependency-age policy refuses a JSR version for
roughly its first 24 hours. A supply-chain delay, not an error.

**Fix.** Pass the flag on `deno run`, or set the env var so the `deno bundle`
child a `denext build` spawns inherits it too.

```sh
deno run --min-dep-age=0 -A jsr:@denext/denext/cli build
DENEXT_MIN_DEP_AGE=0 deno task build
```

See [Contributing](/docs/contributing) → release gotchas.

## Stale `css-shims` entries left in your app's `deno.json`

**Cause.** A compat build injects `file:///…/x.css` →
`.denext/css-shims/css_0.js` import-map entries transiently and restores the
committed file when the build child exits. A build killed mid-crawl (`SIGKILL`)
skips that restore.

**Fix.** Since 2.4.2 the next `denext build` / `denext dev` restores from the
leftover backup automatically. On an older version, delete the injected
`file:///…` entries from `deno.json` by hand.

See the [changelog](/docs/changelog) entry for 2.4.2.

## "denext needs Deno 2.9+" / `deno bundle` not found

**Cause.** `build` and `dev` bundle client code by shelling out to Deno's own
`deno bundle` subcommand, which needs Deno ≥ 2.9; the binary on `PATH` is older
or missing.

**Fix.** Upgrade Deno, or point denext at a 2.9+ binary.

```sh
deno upgrade
# or
DENO_BIN=/path/to/deno deno task build
```

See [Requirements](https://github.com/Brainwires/denext#requirements) in the
README.

## "no dispatcher installed" / hooks throwing inside an npm React library

**Cause.** Two Reacts. The library's own `import "react"` is not being routed
through the compat build, so it calls hooks on a second React instead of
denext's.

**Fix.** Make sure compatibility mode is on so the whole module graph —
your code and every npm library — is aliased onto denext's single React. The
default is `"auto"`, which enables it when `node_modules/react` exists; set it
explicitly if your layout hides that.

```ts
// denext.config.ts
export default { compatibilityMode: true };
```

See [Migrating from Next.js](/docs/migrating) § 3 and § 5, or [SPA mode](/docs/spa) for a client-only app.

## `deno check` reports `@types/react` conflicts on a migrated app

**Cause.** npm libraries ship their own React type definitions, which conflict
across packages. This is a type-checking artifact only — runtime rendering is
unaffected.

**Fix.** Nothing to do: `denext migrate` already sets `skipLibCheck`. Leave it
on for a compat app.

See [Migrating from Next.js](/docs/migrating) § 8.

## `WorkspaceDiscoverError(ConfigNotWorkspaceMember)` when building

**Cause.** The app's directory sits inside another Deno workspace without being
a member of it, and the esbuild deno-loader refuses a nested non-member config.
It can also surface as `Cannot read properties of undefined (reading
'loadEsm')`.

**Fix.** Make the app its own workspace root.

```json
{
  "workspace": []
}
```

An app in its own repository never needs this. See
[`examples/tanstack-router/deno.json`](https://github.com/Brainwires/denext/blob/main/examples/tanstack-router/deno.json)
for a worked example, and [SPA mode](/docs/spa).

## In `denext dev` a page renders but nothing is interactive

**Cause.** A module in the client graph 404'd, so the whole graph failed to load
and the page stayed server HTML. A failed module fetch is not a console error,
which is why there is nothing in the console.

**Fix.** Open the network tab and look for a failed `/_denext/@dep/*` or
`/_denext/@fs/*` request. The specifier it names is the missing module — report
it as a bug.

See the [changelog](/docs/changelog) for 2.4.2, which fixed two of these.

## Prisma: "driverAdapters preview not enabled" / a native engine binary is requested

**Cause.** The schema is using the legacy `prisma-client-js` generator, which
expects a native engine binary and rejects `{ adapter }` under Deno.

**Fix.** Use the Rust-free query compiler with driver adapters.

```prisma
generator client {
  provider        = "prisma-client"
  previewFeatures = ["queryCompiler", "driverAdapters"]
}
```

`denext migrate` writes this generator block for you; run `deno task
prisma:setup` once afterwards. See [Database](/docs/database) → Prisma.

## `denext dev` answers on `localhost`, not `127.0.0.1`

**Cause.** The dev server binds the hostname `localhost` by default, which may
resolve to `::1` rather than `127.0.0.1` on your machine.

**Fix.** Use the host printed in the startup banner, or pass an explicit
hostname.

See [SPA mode](/docs/spa).

## A strict-CSP violation blocks an external script, stylesheet or image

**Cause.** denext ships a hash-based strict Content-Security-Policy on every
HTML page response by default, so a third-party host you added after migrating
is not allowlisted.

**Fix.** Opt the host in per route, or turn CSP off for that route and set the
policy at your edge.

```ts
export const csp = { scriptSrc: ["https://plausible.io"] };
// export const csp = "off";
```

See [Configuration](/docs/config) → Security for the app-wide `csp` setting and
[Deploying](/docs/deploy) § 5 for what CSP does and does not cover.

## `403 { "error": "reauth_required" }` from `/auth/mfa/enroll` or `/auth/tokens`

**Cause.** Setting up a second factor and minting an API token both need a recent
sign-in: the session's `authTime` within `mfa.freshness` (five minutes at least).
A long-lived session, or one issued before 2.5.0-rc.3 (which has no `authTime`),
doesn't qualify, so a stolen cookie can't enroll a factor or mint a credential of
its own. `enrollTotp()` answers `{ ok: false, error: "reauth_required" }` for the
same reason.

**Fix.** Send the user through sign-in again, then retry.

See [Authentication](/docs/auth).

## `?error=account_not_linked` after an OAuth sign-in

**Cause.** The provider's email matches an existing account, and one side of that
match (the account's stored address, or the address the provider asserts) isn't
verified. denext won't attach a provider to an account it can't prove belongs to
the same person.

**Fix.** Have the user sign in the way they registered and verify the address,
then sign in with the provider. `allowDangerousEmailAccountLinking` on the
provider skips the check; set it only for a provider that verifies every address
itself.

## `?error=oauth_failed` or `?error=config` on the sign-in page

**Cause.** `oauth_failed`: the token exchange or profile fetch failed, or the
provider answered with an error denext doesn't recognise. `config`: the provider
is misconfigured. A provider's own protocol code (`access_denied`,
`login_required`) passes through as is.

**Fix.** Read the `denextAuth` line in the `logger` output, or subscribe to
`events.signInFailed`, which carries the same reason.

## `denext ui`: a page answers `401` in another browser or after a restart

**Cause.** `denext ui` signs a browser in with the one-time token in the URL it
prints; the cookie that token sets belongs to that browser and that launch. A
bookmark, or a second browser, has no cookie.

**Fix.** Open the full URL `denext ui` printed (with `?t=…`), or start it with
`--token <t>` to reuse a token of your choice.

## `denext ui`: `409` "changed on disk"

**Cause.** A file the panel was about to write changed after the panel read it —
your editor, another tab, a `git checkout`. The UI refuses rather than overwrite
that edit.

**Fix.** Reload the panel, review the current file, and apply the change again.

## `denext ui`: `503` under `--offline`

**Cause.** The operation needs the network (`deno task`, starting `denext dev`,
`plugin add` / `remove`), and `--offline` keeps the UI and everything it starts
off it.

**Fix.** Restart `denext ui` without `--offline` for that step.

## DevTools shows hook kinds, not names ("names unavailable (conditional hooks?)")

**Cause.** Hook names come from the source and are matched, in order, to the hooks
the component actually ran. A hook called conditionally or after an early return
breaks that match, so the panel shows kind labels (`useState`, `useEffect`)
instead of guessing.

**Fix.** Move the hook above the condition, which is also what the
`denext/rules-of-hooks` lint rule asks for.

## An MCP DevTools tool says the page "posted nothing yet"

**Cause.** An open page starts pushing its component tree to the dev server only
after the first `denext_component_tree`, `denext_why_render` or
`denext_hook_state` call.

**Fix.** Call the tool again after the page's next render, or start
`deno task dev` with `DENEXT_DEV_INSPECT=1` so pages push from the start.

## Still stuck?

Run [`denext doctor`](/docs/doctor-audit) first — it checks your Deno version,
your config and every route — then open an issue at
[github.com/Brainwires/denext/issues](https://github.com/Brainwires/denext/issues).
