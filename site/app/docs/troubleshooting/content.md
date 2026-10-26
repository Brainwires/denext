---
title: Troubleshooting
slug: troubleshooting
lead: Symptom → cause → fix for the errors people actually hit, each pointing at the page that owns the detail.
---

Each entry is one symptom: what you see, the one-line cause, the fix, and a link
to the page that owns the full explanation. Search this page for the error text.

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

**Cause.** Deno's minimum-dependency-age hold refuses a JSR version until it is
old enough (Deno 2.9 holds two days by default, although its error hint says 24
hours). A supply-chain delay, not an error: it is the window in which a
compromised release would be caught.

**Fix.** Run `denext upgrade`: it pins the newest `@denext/*` versions your rule
already lets in (moving a pin that is still held down to the previous release)
and prints when the newer one becomes eligible; run it again after that.
`denext create` and `denext migrate` pin that way from the start. See
[the toolchain's supply-chain hold](/docs/toolchain#supply-chain-hold) for how
the rule is read, and for adding `"jsr:@denext/*"` to
`minimumDependencyAge.exclude` if you publish denext yourself.

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

**Cause.** `build` and `dev` bundle client code with Deno's own `deno bundle` subcommand, which
needs Deno ≥ 2.9. Normally they run on [denext's Deno toolchain](/docs/toolchain) and this never
comes up; it does when the toolchain can't be had (offline on first use, `DENEXT_DENO=stock`, a
platform with no build) and the stock `deno` they fall back to is older or missing.

**Fix.** Fetch the toolchain once you are online, or point denext at a Deno 2.9+ binary.

```sh
denext toolchain install
denext toolchain status      # which Deno a command runs on, and why
# or
DENO_BIN=/path/to/deno denext task build
```

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

## `deno test` runs `_test.ts` files from `.deno/npm-compat`

**Cause.** From runtime 3.0.0-rc.5 the type check writes `.deno/npm-compat` into
the project root: an npm-shaped copy of the `@jsr/*` packages, their `_test.ts`
files included, which a `deno test` with default discovery then finds.

**Fix.** Add a top-level `exclude` to the project's `deno.json` (a workspace's
root and its members): `{ "exclude": [".deno/"] }`. A project `denext create`
scaffolds already has it. See
[Known limitations](/docs/limitations) (the runtime is to keep the copy out of
the project in a later release).

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
hostname (`denext dev --host 127.0.0.1`).

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

## DevTools shows hook kinds, not names ("names unavailable (hook metadata out of date)")

**Cause.** Hook names come from the source and are aligned, in order, with the hooks
the component actually ran (a hook in a branch or after an early return may or may
not have run). When no reading of the source fits the live hooks, the metadata is
stale — usually a module edited without a reload reaching the page — so the panel
shows kind labels (`useState`, `useEffect`) instead of guessing.

**Fix.** Reload the page. If it persists, a hook may be called in a way the source
pass can't see as conditional (from a nested helper function); move it to the top
of the component, which is also what the `denext/rules-of-hooks` lint rule asks for.

## An MCP DevTools tool says no page has posted a component tree

**Cause.** The tree comes from a page loaded in a browser. Each `denext_component_tree`,
`denext_why_render` or `denext_hook_state` call asks every page connected to the dev server's
reload stream for its tree and waits up to 3 s for it; none was open (or none answered: a
production build has no DevTools sink).

**Fix.** Open the app in a browser against `denext task dev`, then call the tool again.

## `denext: hydration mismatch — …`

**Cause.** A component's first client render produced different markup from the
server's (`expected <div>, but the server rendered text "…"`, or
`server text
"3:05 PM" became "15:05"`). denext keeps the client render and
warns in dev (in production it is silent unless the root has an
`onRecoverableError`). The usual sources, in order of frequency: `Date.now()` /
`new Date()` formatting, the user's locale or timezone, `Math.random()` or an
incrementing id, reading `window` / `localStorage` / `matchMedia` during render,
invalid HTML nesting the browser repaired (`<p>` inside `<p>`, `<div>` inside
`<table>`), and a browser extension that edited the DOM before hydration.

**Fix.** Make the first client render equal the server's, then adopt the browser
value afterwards:

- Read browser state in `useEffect`, or through a hook that already does it —
  `useLocalStorage`, `useSessionStorage`, `useMediaQuery`, `useWindowSize`,
  `useNetworkState` return the server value on the first render by design.
- Format dates on the server and pass the string as a prop, or format in an
  effect; use `useId()` for ids, never a counter or `Math.random()`.
- Fix the nesting the message names.
- A component that cannot render on the server:
  `dynamic(() => import(…), { ssr: false })`.

- A value that legitimately differs (a clock): `<time suppressHydrationWarning>` silences
  the warning for that element's own text, as in React — one level, never its descendants —
  and the client value still wins. The marker never reaches the DOM.

## `denext: error <code> in <Component>` in production

**Cause.** A production client bundle carries only the code of the reconciler's own errors,
not their full text (a dev build, `denext dev`, and `denext/testing` throw the full message):

| Code | Full message                                                                       |
| ---- | ---------------------------------------------------------------------------------- |
| 1    | Rendered more hooks than during the previous render (a conditional hook)           |
| 2    | Maximum update depth exceeded: the component schedules an update on every render   |
| 3    | An async component rendered on the client (async components are server-only)       |
| 4    | Retired: `memo()` of a class component now renders, as in React                    |
| 5    | A class component with the class runtime off, or after it failed to load           |
| 6    | A function `action` / `formAction` in a build whose scan saw none (names the prop) |
| 7    | Preact's `useErrorBoundary` in a build whose scan saw none                         |

**Fix.** Reproduce it under `denext dev` for the full message, the component stack and the
dev warnings; the component the production error names is where to start. Codes 6 and 7 come
only from a production build: `denext build` leaves the form-action runtime and the
hook-boundary support out of an app whose own sources never name `action` / `formAction` or
`useErrorBoundary` (a library's code is not scanned), so `denext dev` does not reproduce them.
Name the prop or the hook once in the app's own code, for example where the library's component
is used, and rebuild.

## `ReferenceError: window is not defined` (or `document`, `localStorage`)

**Cause.** The code ran on the server — Deno has no `window` at all — either at
module top level (`const w = window.innerWidth` next to the imports) or during a
render, which happens on the server for every component, `"use client"` ones
included.

**Fix.** Move the access into `useEffect` (or an event handler), guard it
(`typeof document !== "undefined"`), or load the component only on the client
with `dynamic(…, { ssr: false })` / the `client:only` island directive. Note
that `"use client"` is not "client only": denext server-renders client
components for the initial HTML, so `import "denext/client-only"` is inert at
runtime (it is a build-time marker on the compat path). A module-scoped browser
global is a bug in the library, not in denext — wrap the import in
`dynamic(…, { ssr: false })`. See [Client Components](/docs/client-components)
and [Islands & hydration](/docs/islands).

## `redirect()` (or `notFound()`) inside `try/catch` does nothing

**Cause.** `redirect()`, `permanentRedirect()`, `notFound()`, `forbidden()` and
`unauthorized()` work by **throwing** a control-flow signal. A `catch` around
them swallows it, so the redirect never happens (a common shape:
`try { await db.save(); redirect("/done"); } catch { return { error } }`).

**Fix.** Move the call after the `try`, or re-throw the signal from the `catch`:

```ts
import { isRedirect, redirect, unstable_rethrow } from "denext";

try {
  await db.save(data);
  redirect("/done");
} catch (err) {
  unstable_rethrow(err); // re-throws any denext control signal (also one wrapped in `cause`)
  return { error: "save failed" };
}
// or: if (isRedirect(err) || isNotFound(err)) throw err;
```

`isRedirect`, `isNotFound`, `isForbidden` and `isUnauthorized` are exported from
`denext` and `denext/server`; `unstable_rethrow` from `denext`. See
[Error handling](/docs/error-handling).

## A button or handler in a Server Component does nothing

**Cause.** An `onClick={() => …}` (any plain function) on an element inside an
`async` Server Component, or passed as a prop to a `"use client"` component,
cannot cross to the browser: functions do not serialise, so the prop is dropped
and the button renders with no handler. In dev the renderer now warns once per
component and prop —
`denext: <Component> received a function as its "onClick" prop from a Server Component. Functions cannot cross to the client, so the prop was dropped…`
— and the lint rule `denext/no-handlers-in-async` flags a JSX `on*` attribute
given an inline or module-local function inside an `async` component before you
run anything.

**Fix.** Either make it a Server Action (`"use server"` — the function crosses
as a reference and runs on the server), or move the element and its handler into
a `"use client"` component and render that from the Server Component. A Server
Action, a qrl and a channel are the only function-shaped props that cross. See
[Server Actions](/docs/server-actions) and [Islands & hydration](/docs/islands).

## `denext: server-only code would ship to the browser` / `shipped by the route of app/….tsx`

**Cause.** A route that hydrates as a whole — it has a hook or an event handler
and no `"use client"` boundary — bundles its page, its layouts and everything
they import for the browser, and a `"use client"` island ships with its imports
too. One of those modules is server-only: it imports a `node:` built-in
(`node:sqlite`), carries the `server-only` marker or `serverOnly()`, or reads
`Deno.…` unguarded. The message names the module, why it is server-only, and the
entry that pulled it in (the route of `app/page.tsx`, or the `"use client"`
islands bundle). `denext build` / `export` exit non-zero; `denext dev` shows it
in the overlay and console, and the unbundled dev loop refuses to serve the
route's entry with the same message.

**Fix.** Two, and usually both:

1. Move the interactive part into a `"use client"` component so the route stays
   a Server Component — its imports then never leave the server (`lib/db.ts` is
   fine to import from `app/page.tsx` once the page has no hooks of its own).
2. Keep the module marked — `import "denext/server-only"` at its top, or a
   `serverOnly()` call — so a future leak fails here too rather than in the
   browser.

Only what the bundle actually emitted counts (a helper the route never used is
tree-shaken and not a leak), and a `typeof Deno` guard marks a module isomorphic
by intent. See [Islands & hydration](/docs/islands) and the boundary section of
[Known limitations](/docs/limitations).

## An error prints as an explanation, not Deno's own output

**Cause.** `denext check`, `lint`, `build` and `dev` explain type, lint and build
diagnostics: a one-line problem, a codeframe, why it happens and a fix, with
Deno's original text kept underneath (collapsed in the dev overlay).

**Fix.** For Deno's output exactly as it prints it — a script that parses it, or
a bug report — pass `--raw` or set `DENEXT_RAW_DIAGNOSTICS=1`. An agent can ask
the `denext_explain_error` MCP tool for the same explanation. See
[Explained type errors](/docs/error-handling#explained-type-errors).

## `503 Service Unavailable (request timeout)`

**Cause.** The request was still running at `requestTimeout` (30 s by default),
so denext aborted its signal and answered `503`. Only the app's own time counts:
in `denext dev` the time the dev server spends compiling or bundling on the
request's behalf (a first visit, a target's first build) is held off the
deadline, so a slow first compile no longer times out. The handler, render or
upstream `fetch` it awaits is what took too long.

**Fix.** Find the slow await (the request log's `durationMs`, `denext_dev_logs`),
or give a legitimately slow route more time with `setRequestTimeout(ms)` from
`denext/server` inside it, or the app's `requestTimeout` (`0` turns it off).
See [`requestTimeout` bounds awaiting](/docs/deploy#2-requesttimeout-bounds-awaiting-not-cpu).

## `BootSchemaError` / `boot_schema_missing`: the server refuses to start

**Cause.** `DENEXT_BOOT_DDL=off` is set (`0`, `false` and `no` count too), so
no denext feature creates its Postgres schema at boot, and at least one
migration a store or `@denext/backend` needs is not recorded in its tracking
table. The message names each missing one (`<tracking table>:<name>`).

**Fix.** Apply them out of band before starting: `denext db push` (or
`denext migration up`) applies `@denext/backend`'s migrations, every Postgres
store the config builds, the app's own and realtime's triggers. Or run once with
`DENEXT_BOOT_DDL` unset as a role that may create them. See
[Schema at startup](/docs/database#schema-at-startup).

## Realtime or webhooks hear nothing behind PgBouncer

**Cause.** A transaction-mode pooler (PgBouncer, Supavisor) hands the server
connection a `LISTEN` ran on to the next transaction, so a `NOTIFY` never
arrives, and there is no error. Reserved connections and session-level locks are
unsound there too.

**Fix.** Give denext a direct connection: `DATABASE_DIRECT_URL` (or
`backend({ postgres: { directUrl } })`, `directUrl` on any store). Queries keep
using the pooler; `LISTEN`, reserved connections and migrations use the direct
one. See [Pool sizing, timeouts and PgBouncer](/docs/database#pool-sizing-timeouts-and-pgbouncer).

## `denext: shut down and drained, but an open handle … still holds the process`

**Cause.** After `SIGTERM` the drain finished, but something the app opened and
never closed (a database pool, a timer, a socket) kept the event loop alive, so
denext exited at the drain deadline (`DENEXT_SHUTDOWN_DRAIN_MS`, 10 s by default)
rather than wait for the orchestrator's `SIGKILL`.

**Fix.** Close app-owned resources in `instrumentation.ts`'s `onShutdown()`; the
process then exits as soon as they are closed. See
[Graceful shutdown](/docs/deploy#10-graceful-shutdown).

## `denext desktop run` on Windows: "the desktop window could not start … (0xC0000135)"

**Cause.** The window built by `desktop run` / `desktop dev` loads the VC++
2015-2022 runtime (`vcruntime140.dll`, `msvcp140.dll`, and on x64
`vcruntime140_1.dll`) from System32, and this machine has no redistributable for
its architecture, so Windows refused to start it. A fresh Windows on Arm machine
is the usual case. A packaged bundle is not affected when it was packaged on a
machine that has the runtime: it carries the DLLs next to its `.exe`.

**Fix.** Install the redistributable the message names
(`https://aka.ms/vs/17/release/vc_redist.arm64.exe` on Windows on Arm,
`vc_redist.x64.exe` on x64), then run the verb again.

## Mobile (Capacitor)

The entries below are for an app in a Capacitor shell. The full guide is
[Mobile (Capacitor)](/docs/mobile).

### The app stays on its splash screen under `denext mobile dev`

**Cause.** On iOS 14 and later, a WebView reaches a server on the local network only when the
app's `Info.plist` has an `NSLocalNetworkUsageDescription` (and `NSAppTransportSecurity` →
`NSAllowsLocalNetworking` for plain `http`); without them iOS denies the requests silently, and
the page never loads far enough to hide the splash.

**Fix.** `denext mobile dev` adds both `Info.plist` keys for the session, but a changed
`Info.plist` is a native change: rebuild and run the app from Xcode after the first session.
Allow the app when iOS asks for local network access (or turn it on under Settings → Privacy &
Security → Local Network).

See [Live reload on a device](/docs/mobile#live-reload-on-a-device).

### A LAN server answers "The Internet connection appears to be offline" on an iPhone

**Cause.** iOS 14 and later fail every request to a host on the local network (an RFC 1918 or
link-local address, a `.local` name) with `NSURLErrorNotConnectedToInternet` (-1009) until the
user answers the app's Local Network prompt, and show the prompt only when `Info.plist` declares
`NSLocalNetworkUsageDescription`. An OTA check against `ota:serve` on your machine, a
`downloadToFile` / `uploadFile` to a LAN host and the `mobile dev --lan` page all fail this way.
denext adds a hint to the OTA `reason` and the transfer error's message when it sees it.

**Fix.** Allow the app under Settings → Privacy & Security → Local Network, then retry.
`denext mobile dev` and `denext mobile add-ota --ota-origin <LAN origin>` add the
`Info.plist` key; for a server URL the app picks at run time, add it yourself.

### A release build still loads the dev server

**Cause.** A `denext mobile dev` session that was killed outright (`SIGKILL`, a
crash, power loss) never restored `capacitor.config.*`, so the dev URL is still
in the native config copies (`ios/App/App/capacitor.config.json`,
`android/app/src/main/assets/capacitor.config.json`).

**Fix.** Put everything back, then rebuild the web assets and copy them in:

```sh
denext mobile dev --restore   # capacitor.config, Info.plist, the dev URL in the native copies
denext task export
npx cap copy
```

The next `denext mobile dev` restores the backup first as well. See
[Known limitations](/docs/limitations) (Mobile).

### Sign-in fails with `origin_invalid` (or another origin error) inside the app

**Cause.** The shell serves the app from its own origin, `capacitor://localhost`
on iOS and `https://localhost` on Android. An auth provider that checks the
request origin against an allow list (Clerk answers `origin_invalid`) refuses
it.

**Fix.** Add the app origins to the allowed origins in the provider's settings,
when it lets you. If it only accepts origins it can verify, serve the iOS shell
from a scheme and host of your own in `capacitor.config.ts`:

```ts
server: { iosScheme: "myapp", hostname: "app" }, // the iOS origin becomes myapp://app
```

The tradeoff: web storage (`localStorage`, IndexedDB, cookies) belongs to the
origin, so an installed app that moves to the new origin starts with empty
storage, and its users sign in again. Other origin allow lists need the new
origin too, such as the CORS origins of your API and of `createOtaHandler`,
whose `cors: true` covers only the default origins. For OAuth providers,
[`openAuthSession`](/docs/mobile#auth-sessions) runs the sign-in on the
provider's own page instead of in the WebView.

### APNs answers `DeviceTokenNotForTopic` for a Live Activity push-to-start

**Cause.** The push went to the app's regular push token (from
`registerForPush`), or with the app's bundle id as the topic. Starting a Live
Activity remotely takes the app's push-to-start token and the Live Activity
topic.

**Fix.** Send the token from `liveActivityPushToStartToken()` (iOS 17.2 and
later; `null` below it) to your server, and push to it with the topic
`<bundle id>.push-type.liveactivity`, the header `apns-push-type: liveactivity`,
and a payload with `"event": "start"`,
`"attributes-type": "DenextActivityAttributes"`, `"attributes"` and a
`content-state`. The app needs the push entitlement
(`denext mobile add push`). See [App extensions](/docs/mobile#app-extensions).

### Push works on iOS, but Android never registers

**Cause.** `@capacitor/push-notifications` registers with FCM through Firebase,
which needs your Firebase project's `android/app/google-services.json`.
`denext mobile add push` only warns when it is missing, and registration then
fails at runtime.

**Fix.** Download `google-services.json` for the app's package name from the
Firebase console, put it in `android/app/`, and rebuild. See
[Push notifications](/docs/mobile#push-notifications).

### An over-the-air update is refused with `native_mismatch`

**Cause.** The manifest's `nativeFingerprint` differs from the one the app
binary embeds: the UI was built for another native layer (a plugin, a native
file, a Capacitor version or `capacitor.config` changed), so the installed
binary cannot run it.

**Fix.** Ship a new binary: run `denext mobile fingerprint --write`, build and
release the app, and stamp later UI releases with
`denext ota manifest --native-fingerprint auto`.
`denext mobile fingerprint --diff <old.json>` names the inputs that changed; a
version or build number committed to the native sources counts, so set those on
the build command line. See [Native fingerprint](/docs/mobile#native-fingerprint).

### An over-the-air update is refused with `platform_mismatch`

**Cause.** The manifest names another target than the app's (`"platform": "android"` served to
the iOS app): the server offers one platform's export to every shell, and an app with
platform-specific files builds each platform its own.

**Fix.** Serve each shell its own export: `denext export --platform ios` (then
`denext ota manifest out`) per platform, and `createOtaHandler({ platforms: { ios, android } })`,
which picks the export by the `x-denext-ota-platform` header the app sends. See
[Over-the-air updates](/docs/platform-files#over-the-air-updates).

### An over-the-air update is refused with `expired`

**Cause.** The manifest's signed `expiresAt` has passed (`denext ota manifest --sign` stamps 30
days by default), so the feed is serving a release nobody re-signed; or the manifest carries no
expiry at all (signed by older tooling) while the app's bundled UI was built with one.
`checkForUiUpdate` and the desktop updater report it even when the release is the UI already
running.

**Fix.** Re-sign the release the feed serves before it expires: `denext ota manifest out --sign
ota.key` (add `--expires-in <days>` for another lifetime; the version stays, the sequence grows),
and re-sign on a schedule in CI. See [Over-the-air UI updates](/docs/mobile#over-the-air-ui-updates).

## React Native mode

The entries below are for an app built with `reactNative: true`. The full guide is
[React Native / Expo apps](/docs/react-native).

### The build fails on a package's Flow source, or the page is blank with `Cannot find native module`

**Cause.** The package has no web build and no denext replacement. A package whose `main` is
Flow source fails before any of its code is used (a parse error at build time). A module that
asks for a native module no plugin provides loads, and throws
`Cannot find native module '…'` when one of that module's functions is called (the app's own
code, or a library at startup, then stops the page).

**Fix.** Check the [Expo APIs](/docs/react-native#expo-apis) and
[Community packages](/docs/react-native#community-packages) tables first: a listed package
resolves to a denext implementation unless `reactNative.expoShims` or
`reactNative.aliases` turned it off. Otherwise give it a web replacement of your own: a
`.web.ts` beside the module that imports it, or a `deno.json` `imports` entry that maps the
package to a shim. `denext migrate --from expo` names the native-only packages it finds. See
[Other native-only packages](/docs/react-native#other-native-only-packages).

### The build warns that a Reanimated hook's worklet is not a function it can see

**Cause.** The build stamps Reanimated's worklets with the closure its web runtime re-runs them
on, and it could not find the function a hook reads: the argument is the result of another
call, such as `useAnimatedStyle(useCallback(…))`. Without the closure, `useAnimatedStyle`
throws in dev and the hook never re-runs when a captured value changes.

**Fix.** Pass the function inline, give it a `'worklet'` directive, or add an explicit
dependency array: `useAnimatedStyle(fn, [dep1, dep2])`. See
[Reanimated and worklets](/docs/react-native#reanimated-and-worklets).

### Safe-area insets are 0 in the iOS shell

**Cause.** The page does not cover the screen: a viewport meta of your own in `spa.head`
without `viewport-fit=cover` replaces React Native mode's default, and
`reactNative: { rootStyle: false }` drops that default too.

**Fix.** Keep `viewport-fit=cover` in your viewport meta
(`width=device-width, initial-scale=1, viewport-fit=cover`). `SafeAreaView` and
react-native-safe-area-context then read the real insets. See
[Safe areas](/docs/react-native#safe-areas).

### A library takes its web path inside the iOS or Android shell

**Cause.** `Platform.OS` is `"web"` in the shells, on purpose: react-native-web and libraries
choose their DOM code paths by it, and the native modules the `"ios"` / `"android"` paths call
do not exist in a WebView. Code that branches on `Platform.OS` for behaviour takes the web
branch.

**Fix.** Branch on `Platform.constants.denextShell` (`"ios"`, `"android"`, `"desktop"` or
`"web"`) or `runtimePlatform()` from `denext/mobile`, or use `Platform.select`, which picks the
shell's `ios` / `android` key when the spec has no `web` key. See
[Platform.OS in the shell](/docs/react-native#platformos-in-the-shell).

## `deno info (pid …) was still running after 120 s and was killed` during a build

**Cause.** `denext build` runs its module-graph crawl (`deno info`, 120 s) and its client bundle
(`deno bundle`, 300 s) one at a time, each with a deadline after which it is killed and started
once more; a second overrun fails the build with `ChildStallError`. A first build with a cold
cache on a slow link (a Docker `RUN denext task build` that downloads every npm package) can
take longer than that without being stuck.

**Fix.** Set `DENEXT_CHILD_DEADLINE_MS` for that build: a number of milliseconds replaces both
deadlines (`DENEXT_CHILD_DEADLINE_MS=900000` for 15 minutes), and `0` removes them. Warm the
cache in an earlier layer (`RUN denext install`) so later builds don't pay for it.

## Docker: `required variable … is missing a value: set it in .env`

**Cause.** The self-hosted compose file from `denext generate docker` reads every secret as
`${NAME:?…}`, and `.env` doesn't set this one (or there is no `.env` yet). `.env.example` leaves
the required secrets empty on purpose.

**Fix.** `cp .env.example .env`, then fill in each empty value with the command its comment names
(`openssl rand -base64 32`, …). Compose reads `.env` from the directory you run it in.

See [Deployment › Self-hosted stack](/docs/deploy#self-hosted-stack-postgres-storage-migrations).

## Docker: `dependency failed to start: container …-db-1 is unhealthy`

**Cause.** Postgres never passed `pg_isready`. Usually the `db-data` volume was initialised
earlier with another `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` (Postgres only reads
them on the first start), or the volume holds a different major version's data.

**Fix.** `docker compose logs db` says which. For a throwaway database, `docker compose down -v`
deletes the volume so the next `up` initialises it with `.env`'s values; for real data, set
`.env` back to the credentials the volume was created with.

## Docker: `service "migrate" didn't complete successfully: exit 1`

**Cause.** The one-shot migrations service (`denext migration up` with `@denext/backend`, else
`denext job migrate`) failed, so the app is never
started. A migration's SQL failed (it ran in a transaction and was rolled back), or the database
lacks an extension it uses — `create extension vector` needs the pgvector image.

**Fix.** `docker compose logs migrate` shows the failing file and the database's error. Fix the
SQL (or regenerate with `--pgvector`) and run `docker compose up -d` again; applied migrations
are recorded, so only the pending ones run.

## Docker: the app answers `PostgresUnsupportedError` / "this Deno has no built-in Postgres client"

**Cause.** `backend({ postgres })` uses `Deno.SQL`, which only denext's Deno toolchain has, and
the image's `deno task start` ran on the stock `denoland/deno` runtime — a Dockerfile written
before the stack generator, or one generated without Postgres or `@denext/backend`.

**Fix.** Regenerate the Dockerfile with `denext generate docker --postgres --force` (it adds the
layer that puts the toolchain first on `PATH`), or pass a client: `sql: fromPostgresJs(postgres(url))`.

## Still stuck?

Run [`denext doctor`](/docs/doctor-audit) first — it checks your Deno version,
your config and every route — then open an issue at
[github.com/Brainwires/denext/issues](https://github.com/Brainwires/denext/issues).
