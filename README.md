<p align="center">
  <img src="./assets/app-image-2.png" alt="denext" width="220">
</p>

# denext

[![JSR](https://jsr.io/badges/@denext/denext)](https://jsr.io/@denext/denext)
[![JSR Score](https://jsr.io/badges/@denext/denext/score)](https://jsr.io/@denext/denext)
[![CI](https://github.com/Brainwires/denext/actions/workflows/ci.yml/badge.svg)](https://github.com/Brainwires/denext/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Brainwires/denext/main/.github/badges/tests.json)](https://github.com/Brainwires/denext/actions/workflows/ci.yml)
[![fallow health](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/Brainwires/denext/main/.github/badges/fallow.json)](./CONTRIBUTING.md#the-health-score)
[![Source](https://img.shields.io/badge/source-github-181717?logo=github)](https://github.com/Brainwires/denext)

**Write your app once. Ship it as a web app, an iOS and Android app, and a desktop app for macOS,
Windows and Linux — from one codebase, one component model, one router and one typed API layer.**

denext is a complete application framework for [Deno](https://deno.com). It brings its own small
React 19-compatible core, the `app/` router with Server Components and Server Actions, an
end-to-end typed API, live data, auth, a database, background jobs and the native shells — so a
product team needs one stack, one language and one build, and the framework's runtime pulls
**nothing from npm**. The same `denext/mobile` call reaches Capacitor on a phone, the native
runtime in a desktop window and a web fallback in a browser.

**Every accepted web-framework feature, unified and surface compatible.** Server Components and
Actions, streaming, Partial Prerendering, islands, resumability, live data, a typed API, auth, data
and cron live in one framework, behind the React, Next.js, Remix, React Native and Expo APIs
developers already know. That compatibility means your existing `npm:` and `jsr:` packages work as
they are (Radix, Base UI, shadcn/ui, TanStack Router, recharts, react-hook-form, …): there is no new
ecosystem to wait for. [Bring your existing app](#bring-your-existing-app).

**Lightweight.** A **19.6 KB** shared client runtime against 136.9 KB for the same routes on
Next.js, **0 KB** of JavaScript on a page with no interactivity, and SSR on par or faster.
[Small and fast](#small-and-fast).

**Docs:** [denext.dev](https://denext.dev/) · **Package:**
[jsr.io/@denext/denext](https://jsr.io/@denext/denext) · **Source:**
[github.com/Brainwires/denext](https://github.com/Brainwires/denext) · **License:**
[MIT](./LICENSE)

## Write it once

A Server Component fetches on the server. A client component uses the platform. Neither knows, or
needs to know, which platform it is on.

```tsx
// app/page.tsx — a Server Component: the query runs on the server, the browser gets HTML
import { listNotes } from "../lib/db.ts"; // Deno's built-in SQLite, nothing to install
import { CopyLink } from "./copy-link.tsx";

export const metadata = { title: "Notes" };

export default async function Home() {
  const notes = await listNotes();
  return (
    <main>
      <ul>{notes.map((n) => <li key={n.id}>{n.title}</li>)}</ul>
      <CopyLink />
    </main>
  );
}
```

```tsx
// app/copy-link.tsx — one component for the browser, the phone and the desktop window
"use client";
import { useState } from "denext";
import { runtimePlatform, writeClipboard } from "denext/mobile";

export function CopyLink() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    // Capacitor on iOS/Android, the OS clipboard on desktop, navigator.clipboard on the web
    await writeClipboard(location.href);
    setCopied(true);
  };
  return (
    <button type="button" onClick={copy}>
      {copied ? "Copied" : `Copy link (${runtimePlatform()})`}
    </button>
  );
}
```

The same files become every target:

```sh
deno task dev                 # the web app, with HMR, at http://localhost:3000
deno task build && deno task start   # the production server (SSR, streaming, Server Actions)
deno task export              # a static export for any host or CDN
deno task desktop             # a native desktop window (Deno Desktop)
deno task desktop:package     # a signed, distributable app (:linux and :windows tasks too)
deno task mobile:sync && deno task mobile:ios   # the Capacitor project, open in Xcode
```

## Quick start

You need [Deno](https://deno.com) 2.9 or newer. Scaffold a project with the targets you want and
run it:

```sh
deno run -A jsr:@denext/denext/cli create my-app --desktop --capacitor
cd my-app
deno task dev
```

`create` asks about Tailwind, a `src/` layout, the auto-memo compiler, the desktop target and the
Capacitor target (pass the flags, or `--yes`, to skip the prompt). Or install the `denext` command
once and use it everywhere:

```sh
curl -fsSL https://denext.dev/install.sh | sh     # macOS and Linux; checksum-verified
irm https://denext.dev/install.ps1 | iex          # Windows (PowerShell); checksum-verified
deno install -A -g -n denext jsr:@denext/denext/cli   # any platform, through Deno
```

Then [Getting started](https://denext.dev/docs/getting-started) or the
[tutorial](https://denext.dev/docs/tutorial) take it from here. [`examples/`](./examples) holds a
complete app for every feature below, including [`examples/native`](./examples/native) (one app
packaged for the web, the desktop and a phone).

## One codebase, every platform

**The web.** The App Router with Server Components, streaming and Suspense, Server Actions,
parallel and intercepting routes, middleware, metadata, images, fonts and i18n. Pages with no
interactivity ship **0 KB of JavaScript**; interactive routes ship a shared ~20 KB runtime. Choose
per route between server rendering, a static export, Partial Prerendering with Cache Components,
Astro-style islands and Qwik-style resumability. A strict Content-Security-Policy is on by default.
→ [Routing](https://denext.dev/docs/routing) ·
[Rendering strategies](https://denext.dev/docs/rendering) ·
[Islands](https://denext.dev/docs/islands) · [Resumability](https://denext.dev/docs/resumability)

**iOS and Android.** The export runs in a Capacitor shell, and `denext/mobile` gives the page the
device without a single `@capacitor/*` import: safe areas, the keyboard, the Android back gesture,
system bars, haptics, the clipboard, sharing, files, pickers, the camera and barcode scanning,
SQLite, the Keychain and biometrics, geolocation, local and push notifications, deep links, Sign in
with Apple and Google, OAuth sessions, home-screen quick actions, native context menus, in-app
purchases and more. `denext mobile add <capability>` installs the native side. Native views
(`<NativeViewSlot>` for maps and video) sit inside the page; share extensions, home-screen widgets
and Live Activities are generated Xcode targets; `nativeModule()` reaches your own Swift and Kotlin.
Signed over-the-air UI updates, icon and splash generation, store builds and store submission are
CLI verbs. → [Mobile](https://denext.dev/docs/mobile) ·
[Store builds](https://denext.dev/docs/mobile-build) ·
[Your own native code](https://denext.dev/docs/native-code)

**macOS, Windows and Linux.** `denext desktop` wraps the export in a native window on Deno
Desktop (a single binary, no Chromium) at Electron parity: a stable custom-scheme origin so
sign-in providers and web storage treat the app as one site, single-instance launch, deep links and
opened files, a trusted preload, an application menu, a tray icon, dock and taskbar badges, native
notifications with scheduling and action buttons, native file dialogs, the OS clipboard (text, HTML
and images), file drag and drop in both directions, global shortcuts, launch at login, and a window
API (`denext/desktop/window`: fullscreen, maximize, minimum and maximum size, screens, title-bar
styles, Mica, Acrylic and vibrancy, a cancelable close). Sign-in uses the system browser or
`ASWebAuthenticationSession`; native passkeys work in the window on macOS and Windows (Linux, which
has no OS passkey API, signs in through the browser); `denext/desktop/clerk` runs Clerk's
Electron bridge unchanged. Updates are **signed full-app self-updates** with downgrade protection, an
atomic swap and automatic rollback. Node-API addons load on all three operating systems, and
`defineDesktopExtension` exposes your own Deno code to the page. Packaging is least-privilege: the
`--allow-*` flags are derived from the capabilities you enable. The same `denext/mobile` functions
answer here too: the keychain, files, SQLite, the shell, keep-awake. →
[Desktop apps](https://denext.dev/docs/desktop)

**React Native and Expo code.** `reactNative: true` builds an Expo or React Native app's own source
for the web and the shells: `react-native` through react-native-web, every `expo-*` package through
a `denext/expo/*` shim over `denext/mobile`, expo-router and React Navigation on
`denext/navigation`, FlatList and FlashList on `VirtualList`, Reanimated with no Babel plugin.
→ [React Native / Expo](https://denext.dev/docs/react-native) ·
[denext vs React Native](https://denext.dev/docs/vs-react-native)

**Native-feel UI.** `VirtualList` renders ten-million-row lists with exact `scrollToIndex`, chat
anchoring and intact iOS momentum; `denext/navigation` keeps pushed screens mounted with platform
transitions, the iOS swipe back, state-keeping tabs and bottom sheets. →
[Lists](https://denext.dev/docs/lists) ·
[Native-feel navigation](https://denext.dev/docs/navigation-native)

## Everything an app needs, built in

**Typed, end to end.** `defineApi` takes Standard Schemas (Zod, Valibot, ArkType, TypeBox) for
params, query, body and response, and the generated `.denext/api.ts` types every call through
`createApiClient()` and `useApi` — path, method, input, output and the error codes. `defineAction`
does the same for Server Actions and `useActionState`. `<Link href>` and `useRouter().push` are
typed to the app's real routes. The same definitions serve OpenAPI 3.1 and a docs page
(`@denext/openapi`) or GraphQL with subscriptions (`@denext/graphql`). →
[Typed API](https://denext.dev/docs/typed-api) ·
[Server Actions](https://denext.dev/docs/server-actions) ·
[OpenAPI](https://denext.dev/docs/openapi) · [GraphQL](https://denext.dev/docs/graphql)

**Live data.** `<Live tags={[...]}>` re-renders one server-rendered boundary and pushes it over a
WebSocket when a cache tag is invalidated from anywhere — a Server Action, a webhook, a cron.
`defineSubscription` is a server-validated, authorized live query; `createChannel` is typed server
push; `useLive`, `usePresence` and `useLiveOptimistic` ride the same socket, across instances.
→ [Live](https://denext.dev/docs/live)

**Auth.** `denextAuth()` mounts `/auth/*` with twelve OAuth/OIDC presets, email and password,
magic links and one-time codes, TOTP second factor with backup codes, email verification and
password reset, revocable sessions, roles, bearer API tokens, native sign-in for the shells, rate
limits and account deletion. `auth()`, `requireAuth()` and `requireSession()` cover the server,
middleware and API routes. → [Auth](https://denext.dev/docs/auth)

**Data.** Deno's built-in SQLite with no install, Deno KV, Postgres and MySQL drivers, Drizzle and
Prisma; `use cache`, `cacheTag`, `revalidateTag` and a durable SQLite cache store; typed content
collections for Markdown, MDX, YAML and JSON (`@denext/content-collections`); uploads; image
optimization; OG images. → [Databases](https://denext.dev/docs/database) ·
[Data & caching](https://denext.dev/docs/data) ·
[Content collections](https://denext.dev/docs/content-collections)

**Background work.** `defineTask` in `tasks/<name>.ts`, scheduled with cron expressions
(`Deno.cron` where the platform has it), run on demand with `runTask()` or `denext task`, with
run history. → [Tasks](https://denext.dev/docs/tasks)

**Production.** Graceful drain, per-request timeouts, concurrency ceilings, body caps, gzip and
brotli, CORS, a security-header set, SSRF-safe fetch and image optimization, CSRF-defended
actions, request ids, instrumentation, a Dockerfile generator and recipes for Docker, Deno Deploy
and self-hosting. → [Deployment](https://denext.dev/docs/deploy) ·
[Security](https://denext.dev/docs/security) ·
[Production checklist](https://denext.dev/docs/production-checklist)

**Extensible.** A plugin hooks six seams (routes, requests, build, prepare-time codegen, teardown,
CLI verbs); the first-party plugins are the Pages Router, React Router v7, htmx, OpenAPI, GraphQL,
content collections and an Effect bridge. A project adds its own CLI verbs in `denext.config.ts`.
→ [Plugins](https://denext.dev/docs/plugins)

## Developer experience

One CLI covers the lifecycle: `dev` with per-module HMR and Fast Refresh, `build`, `export`,
`start`, `generate` (routes, components, actions, tasks, tests, Docker), `test`, `lint`, `fmt`,
`check`, `add`, `plugin`, `patch` (patch-package for npm dependencies and for denext itself),
`desktop`, `mobile`, `ota` and `completions`. A dev-time overlay reports server errors and type
errors; the DevTools panel shows the live component tree and why a component re-rendered.
→ [CLI reference](https://denext.dev/docs/cli) · [DevTools](https://denext.dev/docs/devtools)

**Tooling that proves things.** `denext doctor` validates the config and renders every route;
`denext audit` inventories dependencies, proves the runtime is zero-npm and writes an SBOM;
`denext analyze` breaks the client bundle down by chunk and role; `denext profile` measures CPU
self-time and heap growth for a route in headless Chromium, with a budget gate for CI.
`denext/testing` drives the whole app the way a JavaScript-disabled browser would (cookie jar, form
submit), renders components with real hooks and events, and probes every route for a well-formed
document. → [Testing](https://denext.dev/docs/testing) · [Profiling](https://denext.dev/docs/profile)
· [Doctor & audit](https://denext.dev/docs/doctor-audit)

**A GUI over the project.** `denext ui` serves a loopback project dashboard: a schema-driven,
comment-preserving `denext.config.ts` editor, a Cron page, plugin option forms and JSR search, every
`generate` kind, Docker and `docker-compose.yml` editing, a Desktop panel that sets up code signing
from the identities in your keychain, and a Setup page for a fresh clone. Project code never runs
in the UI's process. → [Project UI](https://denext.dev/docs/ui)

**Built for AI agents.** `denext mcp` is a first-party MCP server: it lints a snippet before an
agent writes it, maps a React or Next import, scaffolds, renders a route or component server-side
and returns the HTML, reads a running dev server's errors, console and HMR events, exposes the
live component tree and hook state, profiles a route, searches the docs and indexes the codebase.
[AGENTS.md](./AGENTS.md) is the authoring guide agents read, and
[denext.dev/llms.txt](https://denext.dev/llms.txt) is the same guide for any model.
→ [MCP server](https://denext.dev/docs/mcp)

## Bring your existing app

denext is React at the reconciler level, so the React ecosystem runs on it, and its router is the
Next.js App Router, so that knowledge transfers directly. `denext migrate` converts a project in one
pass and keeps your source intact:

- **Next.js** (App Router and Pages Router): the `deno.json` alias map resolves `react` and
  `next/*` to denext; `--codemod` rewrites imports to native `denext`.
  → [Migrating from Next.js](https://denext.dev/docs/migrating) ·
  [Pages Router](https://denext.dev/docs/pages-router)
- **Remix and React Router v7**: loaders, actions, `meta` and error boundaries run on the
  `denext/remix` runtime. → [Migrating from Remix](https://denext.dev/docs/migrating-remix) ·
  [React Router](https://denext.dev/docs/react-router)
- **Expo and React Native**: `migrate --from expo` writes the config and a `capacitor.config.ts`
  and reports which native-only packages need a recipe.
  → [Coming from React Native](https://denext.dev/docs/coming-from-react-native) ·
  [Native SDK recipes](https://denext.dev/docs/native-sdk-recipes)
- **Vite, CRA and any React SPA**: `mode: "spa"` hosts a client-only app on the same runtime,
  with the same desktop and mobile packaging. → [SPA mode](https://denext.dev/docs/spa)

`npm:` and `jsr:` libraries work as usual, and `denext patch` records a reviewable patch for an
npm package or for denext itself. The honest edges are kept in one place: [Known limitations](./KNOWN-LIMITATIONS.md) and
[Deliberate differences](./KNOWN-DIFFERENCES.md).

## Small and fast

denext ships its own React core instead of React + ReactDOM + a framework runtime, so a browser
downloads about **7× less JavaScript** than for the same app on Next.js, and a static page downloads
none. Measured on `examples/hello` (production, gzipped, Next.js 16.3 + React 19.2 on the same
routes):

| What a browser downloads | denext      | Next.js     |
| ------------------------ | ----------- | ----------- |
| Shared client runtime    | **19.6 KB** | 136.9 KB    |
| First load of `/`        | **20.8 KB** | 137.3 KB    |
| Each later navigation    | **~1 KB**   | route chunk |

Hydration and SSR throughput run on par or faster, and on a library-heavy app (recharts,
react-hook-form, Radix) the routes ship roughly half or less. Every number is reproducible with
`bench/run.ts`; the methodology and the full results are in [`bench/REPORT.md`](./bench/REPORT.md).

The framework's runtime carries **no npm dependencies** — CI-enforced — so `npm audit`-class
advisories have nothing to land on and an SBOM for a denext app is essentially the app. Build-time
tooling uses `esbuild` plus first-party Rust-to-wasm packages (`@denext/swc`,
`@denext/lightningcss`, `@denext/photon`, `@denext/avif`, `@denext/og`).

## The `denext` command

The binary is a CLI, not a second copy of the framework: inside a project every verb that loads
the app re-execs the denext version the project pins, so `denext build` produces exactly what
`deno task build` would. Four ways to get it:

1. `curl -fsSL https://denext.dev/install.sh | sh` — the released binary for macOS and Linux
   (`~/.denext/bin`; checksum-verified; `DENEXT_VERSION` picks a release). On Windows,
   `irm https://denext.dev/install.ps1 | iex` in PowerShell does the same per-user, no admin
   (`%USERPROFILE%\.denext\bin`, added to your user `Path`; uninstall with
   `& ([scriptblock]::Create((irm https://denext.dev/install.ps1))) -Uninstall`). Each release
   also carries a Homebrew formula, a Scoop manifest and a winget manifest set beside the
   archives.
2. `deno install -A -g -n denext jsr:@denext/denext/cli` — a launcher through your Deno.
3. `deno task compile` from a checkout.
4. Nothing at all: `deno run -A jsr:@denext/denext/cli <verb>` does the same thing, and the
   scaffolded `deno task dev` / `build` / `start` already use it.

A project is a `deno.json` with the JSX settings, the import map and the lint plugin — no
`node_modules`, no lockfile churn:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "denext",
    "lib": ["deno.window", "dom", "dom.iterable", "dom.asynciterable"]
  },
  "imports": {
    "denext": "jsr:@denext/denext@^3",
    "denext/jsx-runtime": "jsr:@denext/denext@^3/jsx-runtime",
    "denext/server": "jsr:@denext/denext@^3/server",
    "denext/client": "jsr:@denext/denext@^3/client"
  },
  "lint": { "plugins": ["jsr:@denext/denext/lint-plugin"] }
}
```

Every entry point (`denext`, `denext/server`, `denext/client`, `denext/live`, `denext/mobile`,
`denext/navigation`, `denext/desktop`, `denext/testing`, `denext/plugin-kit`, …) is documented
in the [API reference](https://denext.dev/docs/api); every config key in
[Configuration](https://denext.dev/docs/config).

## Documentation

**Learn** — [Getting started](https://denext.dev/docs/getting-started) ·
[Tutorial](https://denext.dev/docs/tutorial) · [Project layout](https://denext.dev/docs/project-layout)
· [Routing](https://denext.dev/docs/routing) · [Data & caching](https://denext.dev/docs/data) ·
[Rendering](https://denext.dev/docs/rendering) · [Styling](https://denext.dev/docs/styling)

**Build** — [Typed API](https://denext.dev/docs/typed-api) ·
[Server Actions](https://denext.dev/docs/server-actions) · [Live](https://denext.dev/docs/live) ·
[Auth](https://denext.dev/docs/auth) · [Databases](https://denext.dev/docs/database) ·
[Tasks](https://denext.dev/docs/tasks) · [Content collections](https://denext.dev/docs/content-collections)
· [Testing](https://denext.dev/docs/testing)

**Ship** — [Deployment](https://denext.dev/docs/deploy) · [Desktop apps](https://denext.dev/docs/desktop)
· [Mobile](https://denext.dev/docs/mobile) · [App backend](https://denext.dev/docs/app-backend) ·
[Security](https://denext.dev/docs/security) ·
[Production checklist](https://denext.dev/docs/production-checklist)

**Reference** — [CLI](https://denext.dev/docs/cli) · [Configuration](https://denext.dev/docs/config)
· [API](https://denext.dev/docs/api) · [Plugins](https://denext.dev/docs/plugins) ·
[MCP server](https://denext.dev/docs/mcp) · [Project UI](https://denext.dev/docs/ui) ·
[Examples](https://denext.dev/docs/examples) · [Troubleshooting](https://denext.dev/docs/troubleshooting)
· [Changelog](https://denext.dev/docs/changelog)

**Under the hood** — [FEATURES.md](./FEATURES.md) (every feature, with the mechanism) ·
[Architecture](https://denext.dev/docs/architecture) ·
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md) · [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md)

**The project** — [MISSION.md](./MISSION.md) · [POLICIES.md](./POLICIES.md) (guardrails and the
security policy) · [ROADMAP.md](./ROADMAP.md) · [CONTRIBUTING.md](./CONTRIBUTING.md) ·
[CHANGELOG.md](./CHANGELOG.md) · [AGENTS.md](./AGENTS.md)

## License

MIT — see [LICENSE](./LICENSE).
