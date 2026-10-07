---
title: Fixed in denext
slug: fixed
lead: Problems people hit on Next.js, React, Vite and React Native stacks that denext handles, each backed by a named test.
generated: from catalog/fixed-in-denext.json by deno task docs:fixed (edit the catalog, not this file)
---

denext lets you write an app once and ship it to the web, iOS, Android and the desktop. Its API
is surface compatible with React and the Next.js App Router, so existing packages keep working,
and it stays lightweight: its own small React core and no runtime npm dependencies. This page
lists problems teams run into on those stacks and what denext does about each one.

Every entry names the test in the denext repository that proves it; a CI check fails when one
of those tests disappears or is renamed, so the claims can't go stale silently. Each entry is
labelled:

| Kind       | Meaning                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| fix        | denext does not have the problem.                                                             |
| difference | denext behaves differently on purpose; read the entry before relying on it.                   |
| trade-off  | denext accepts the code instead of failing, at a cost the entry names.                        |
| capability | Something the other stack needs a separate service, plugin or package for, built into denext. |

For security advisories the fix for an existing app is to upgrade it; those entries say so
first. Search this page for the error text you are seeing.

## Try it on your project

`denext migrate --check` reports what `denext migrate` would change in your project, what will
not migrate and why, and an overall verdict. It writes nothing: it needs read access to the
project, run access to evaluate a `next.config.*` (in a subprocess that can only read the
project) and network access to jsr.io, to fetch denext itself:

```sh
deno run --allow-read --allow-env --allow-run --allow-net=jsr.io jsr:@denext/denext/cli migrate --check
```

Add `--json` for a machine-readable report. See
[Migrating from Next.js](/docs/migrating) for the migration itself.

## Index

| Problem                                                                                                                                                         | Stack                                         | Kind       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------- |
| [One codebase for web, iOS, Android and desktop](#one-codebase-for-web-ios-android-and-desktop)                                                                 | Next.js / Vite + React Native + Electron      | capability |
| [A Vite React SPA as a desktop app, without Electron](#a-vite-react-spa-as-a-desktop-app-without-electron)                                                      | Vite + React                                  | capability |
| [Desktop apps without full system privileges](#desktop-apps-without-full-system-privileges)                                                                     | Electron                                      | capability |
| [iOS momentum scrolling stops when a virtual list corrects its scroll position](#ios-momentum-scrolling-stops-when-a-virtual-list-corrects-its-scroll-position) | React virtual lists on iOS WebKit             | fix        |
| [Middleware bypass through x-middleware-subrequest (CVE-2025-29927)](#middleware-bypass-through-x-middleware-subrequest-cve-2025-29927)                         | Next.js (self-hosted, middleware)             | fix        |
| [Cache poisoning of rendered pages (CVE-2024-46982, CVE-2025-49826)](#cache-poisoning-of-rendered-pages-cve-2024-46982-cve-2025-49826)                          | Next.js                                       | fix        |
| [Image optimizer abuse (CVE-2024-47831, CVE-2025-55173, CVE-2025-57752)](#image-optimizer-abuse-cve-2024-47831-cve-2025-55173-cve-2025-57752)                   | Next.js image optimization                    | fix        |
| [Server Components payload deserialization (CVE-2025-55182, CVE-2025-55184)](#server-components-payload-deserialization-cve-2025-55182-cve-2025-55184)          | React Server Components in Next.js App Router | fix        |
| [Server-only code bundled for the browser](#server-only-code-bundled-for-the-browser)                                                                           | Next.js App Router                            | fix        |
| [Event handlers passed from a Server Component](#event-handlers-passed-from-a-server-component)                                                                 | Next.js App Router                            | difference |
| [A page that uses hooks without "use client"](#a-page-that-uses-hooks-without-use-client)                                                                       | Next.js App Router                            | trade-off  |
| [A strict Content Security Policy without nonces or dynamic rendering](#a-strict-content-security-policy-without-nonces-or-dynamic-rendering)                   | Next.js App Router                            | difference |
| ["process is not defined" in the browser](#process-is-not-defined-in-the-browser)                                                                               | React apps bundling npm libraries             | fix        |
| ["Invalid hook call" from two copies of React](#invalid-hook-call-from-two-copies-of-react)                                                                     | React apps with linked or nested dependencies | fix        |
| [Child components re-render when their props did not change](#child-components-re-render-when-their-props-did-not-change)                                       | React                                         | difference |
| [Error boundaries do not catch errors thrown in event handlers](#error-boundaries-do-not-catch-errors-thrown-in-event-handlers)                                 | React                                         | difference |
| [Icon and utility barrels pulling whole libraries into the bundle](#icon-and-utility-barrels-pulling-whole-libraries-into-the-bundle)                           | React apps on Vite or other bundlers          | capability |
| [End-to-end typed API calls without tRPC](#end-to-end-typed-api-calls-without-trpc)                                                                             | Next.js route handlers                        | capability |
| [Live updates and subscriptions without a separate WebSocket server](#live-updates-and-subscriptions-without-a-separate-websocket-server)                       | Next.js route handlers on serverless hosts    | capability |
| [Scheduled jobs without a platform cron service](#scheduled-jobs-without-a-platform-cron-service)                                                               | Next.js                                       | capability |
| [A self-hosted data cache that survives restarts](#a-self-hosted-data-cache-that-survives-restarts)                                                             | Next.js self-hosted                           | difference |
| [Rate limits bypassed with a forged X-Forwarded-For](#rate-limits-bypassed-with-a-forged-x-forwarded-for)                                                       | any server reading x-forwarded-for            | capability |
| [Inverted FlatList on the web scrolls the wrong way](#inverted-flatlist-on-the-web-scrolls-the-wrong-way)                                                       | react-native-web FlatList                     | fix        |
| [Reanimated on the web without the Babel plugin](#reanimated-on-the-web-without-the-babel-plugin)                                                               | react-native-reanimated on the web            | fix        |
| [Over-the-air UI updates without a hosted update service](#over-the-air-ui-updates-without-a-hosted-update-service)                                             | Expo / React Native apps                      | capability |
| [Will my existing app run?](#will-my-existing-app-run)                                                                                                          | Next.js App Router, Remix                     | capability |
| [Pages Router apps](#pages-router-apps)                                                                                                                         | Next.js Pages Router                          | capability |
| [next.config wrappers and MDX plugins carried over](#nextconfig-wrappers-and-mdx-plugins-carried-over)                                                          | Next.js with @next/mdx or config plugins      | capability |
| [tsconfig path aliases (@/*) in monorepos](#tsconfig-path-aliases--in-monorepos)                                                                                | TypeScript apps                               | capability |
| [React Compiler memoization kept when moving a Vite app](#react-compiler-memoization-kept-when-moving-a-vite-app)                                               | Vite + React with babel-plugin-react-compiler | capability |

## Write once, ship everywhere

### One codebase for web, iOS, Android and desktop

**Stack:** Next.js / Vite + React Native + Electron (any) · **Kind:** capability

**The problem.** Shipping the same React app to the web, the app stores and the desktop usually means separate projects (a web framework, a React Native app, an Electron app) with code shared through packages.

**Why it happens.** Each target has its own toolchain and module resolution, so per-platform code ends up in per-platform projects.

**What denext does.** One denext app builds for every target. A module can have per-platform variants (`button.ios.tsx`, `button.web.tsx`, `button.desktop.tsx`) and the build for each target picks its variant; a module with no file for the target fails the build and names the variants it found.

**Evidence.**

- [`tests/platform-extensions-export.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/platform-extensions-export.test.ts): "staticExport: a module with no file for the target fails naming its variants"
- [`tests/platform-extensions-export.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/platform-extensions-export.test.ts): "denext build + start: the web target's `.web` variant reaches the bundle and the render"

More: [/docs/platform-files](/docs/platform-files).

### A Vite React SPA as a desktop app, without Electron

**Stack:** Vite + React (any) · **Kind:** capability

**The problem.** Turning an existing Vite React app into a desktop app usually means adding Electron or Tauri and a second build.

**Why it happens.** A browser SPA has no native window or packaging of its own.

**What denext does.** `denext migrate --desktop` keeps the app's source, writes a denext config in SPA mode and a `desktop.ts` entry, and the app runs in a native window through Deno Desktop. An optional backend is reached through a same-origin proxy.

**Evidence.**

- [`tests/migrate-spa.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migrate-spa.test.ts): "migrate SPA (pnpm + --desktop): config, aliases, env union, tailwind, parsed proxy"

More: [/docs/desktop](/docs/desktop).

### Desktop apps without full system privileges

**Stack:** Electron (any) · **Kind:** capability

**The problem.** An Electron app's main process runs with full Node.js privileges, so every dependency it loads can read and write anywhere the user can.

**Why it happens.** Node.js has no permission model on by default, and the Electron main process is a Node.js process.

**What denext does.** A packaged denext desktop app runs under Deno's permission model. The packaging scripts derive the `--allow-*` flags from the capabilities the app declares (`desktop.capabilities`) instead of granting everything; with no capabilities the app gets loopback network, read and env only.

**Evidence.**

- [`tests/desktop-capabilities.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/desktop-capabilities.test.ts): "desktopBuildFlags: no capabilities → only the loopback + read + env baseline (never -A)"
- [`tests/desktop-capabilities.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/desktop-capabilities.test.ts): "desktopBuildFlags: the full capability set on Windows, least-privilege"

More: [/docs/desktop](/docs/desktop).

### iOS momentum scrolling stops when a virtual list corrects its scroll position

**Stack:** React virtual lists on iOS WebKit (iOS Safari / WKWebView) · **Kind:** fix

**The problem.** In iOS Safari and WKWebView, a fling on a virtualized list stops dead or jumps when the list adjusts `scrollTop` while the momentum scroll is still running (for example after measuring rows).

**Why it happens.** WebKit on iOS cancels the native momentum animation when script writes the scroll position during it.

**What denext does.** denext defers scroll writes made during a touch or momentum phase: the content is shifted visually and the accumulated correction is applied in one step when the scroll ends. It is installed automatically for iOS WebKit visitors (`momentumSafeScroll: false` opts out).

**Evidence.**

- [`tests/mobile-momentum-scroll.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/mobile-momentum-scroll.test.ts): "momentum scroll: during momentum a scrollTop assignment is deferred"
- [`tests/mobile-momentum-scroll.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/mobile-momentum-scroll.test.ts): "momentum scroll: corrections accumulate, and read-then-correct converges"

More: [/docs/lists](/docs/lists).

## Security advisories

### Middleware bypass through x-middleware-subrequest (CVE-2025-29927)

**Stack:** Next.js (self-hosted, middleware) (11.1.4 to 15.2.2) · **Kind:** fix

**Upgrade first.** Upgrade Next.js to 15.2.3, 14.2.25, 13.5.9 or 12.3.5 (or later). That is the fix for a Next.js app; denext's behaviour is listed for teams evaluating it, not as a substitute for the upgrade.

**The problem.** A request carrying the `x-middleware-subrequest` header skips Next.js middleware, including auth checks done there.

```text
CVE-2025-29927
x-middleware-subrequest
```

**Why it happens.** Next.js used an internal header to stop middleware recursion and trusted it on incoming requests.

**What denext does.** denext's middleware runner has no request header that skips it; the test sends the attack header and the middleware still runs. Internal `x-middleware-*` markers are also never copied onto a response.

**Evidence.**

- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "CVE-2025-29927: x-middleware-subrequest cannot bypass auth middleware"
- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "internal-header: x-middleware-* markers never leak onto a response (CVE-2026-44572)"

More: [/docs/security](/docs/security).

### Cache poisoning of rendered pages (CVE-2024-46982, CVE-2025-49826)

**Stack:** Next.js (see each advisory) · **Kind:** fix

**Upgrade first.** Upgrade Next.js to the patched release named in each advisory (GitHub Security Advisories for vercel/next.js). denext's behaviour is listed for teams evaluating it, not as a substitute for the upgrade.

**The problem.** A crafted request could make Next.js cache the wrong response for a page: a data response stored as the HTML page, or a non-200 response cached for a route.

```text
CVE-2024-46982
CVE-2025-49826
```

**Why it happens.** Variants of one route shared a cache entry, and some error responses were cacheable.

**What denext does.** denext keys the soft-navigation data variant separately from the HTML document and never stores a non-200 render in the page cache.

**Evidence.**

- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "CVE-2024-46982/32421: soft-nav data variant cannot poison the HTML cache"
- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "CVE-2025-49826: a non-200 (notFound) render is never cached"

More: [/docs/security](/docs/security).

### Image optimizer abuse (CVE-2024-47831, CVE-2025-55173, CVE-2025-57752)

**Stack:** Next.js image optimization (see each advisory) · **Kind:** fix

**Upgrade first.** Upgrade Next.js to the patched release named in each advisory (GitHub Security Advisories for vercel/next.js). denext's behaviour is listed for teams evaluating it, not as a substitute for the upgrade.

**The problem.** The image optimization endpoint could be pushed into denial of service, made to serve an attacker-controlled download, or forward user credentials to the image's origin.

```text
CVE-2024-47831
CVE-2025-55173
CVE-2025-57752
```

**Why it happens.** The optimizer accepted unbounded variants, passed through upstream response headers, and reused request credentials for the upstream fetch.

**What denext does.** denext's image endpoint bounds the width and quality to an allowlist, rejects decompression bombs, never emits `Content-Disposition` or HTML, never serves `image/svg+xml`, and forwards no user credentials upstream.

**Evidence.**

- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "CVE-2024-47831/44577: the image endpoint bounds width + rejects a bomb"
- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "CVE-2025-55173: image endpoint never emits an attacker download (no Content-Disposition, no html)"
- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "CVE-2025-57752: the image optimizer forwards no user credentials upstream"

More: [/docs/security](/docs/security).

### Server Components payload deserialization (CVE-2025-55182, CVE-2025-55184)

**Stack:** React Server Components in Next.js App Router (see each advisory) · **Kind:** fix

**Upgrade first.** Upgrade React and Next.js to the patched releases named in the advisories. denext's behaviour is listed for teams evaluating it, not as a substitute for the upgrade.

**The problem.** A crafted request to a Server Function endpoint could run code on the server or hang it while the React Server Components payload was decoded.

```text
CVE-2025-55182
CVE-2025-66478
CVE-2025-55184
CVE-2025-67779
```

**Why it happens.** The payload decoder reconstructed server references and nested structures from client input.

**What denext does.** denext decodes a Server Action body with plain `JSON.parse`: a payload shaped like a server reference stays inert data, deep nesting is bounded, `__proto__` keys do not pollute prototypes, and an oversized body is refused before the handler runs.

**Evidence.**

- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "RSC-RCE: a payload shaped like a server reference is decoded as inert data, never invoked"
- [`tests/nextjs-cve-parity.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/nextjs-cve-parity.test.ts): "RSC-DoS: a deeply nested payload is bounded (JSON.parse throws, caught) — no hang"

More: [/docs/security](/docs/security).

## Next.js App Router

### Server-only code bundled for the browser

**Stack:** Next.js App Router (13.4 and later) · **Kind:** fix

**The problem.** A client bundle pulls in a module that uses `fs`, a database driver or secrets. The build fails with an unhelpful resolution error, or worse, the code ships.

```text
Module not found: Can't resolve 'fs'
```

**Why it happens.** Anything a client component imports, directly or through a shared helper, goes into the client bundle; nothing flags server-only modules unless they import the `server-only` package.

**What denext does.** The build fails with `denext: server-only code would ship to the browser`, naming the module, why it is server-only (a `node:` import, the `Deno` global) and the route that shipped it, and suggests the fix. No marker import is needed.

**Evidence.**

- [`tests/server-only-leak.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/server-only-leak.test.ts): "build fails when a hydrating route's tree would ship node:sqlite + Deno.env to the browser"
- [`tests/next-compat.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/next-compat.test.ts): "checkEnvPoison: server-only in a client bundle is a build error"

More: [/docs/client-components](/docs/client-components).

### Event handlers passed from a Server Component

**Stack:** Next.js App Router (13.4 and later) · **Kind:** difference

**The problem.** Passing `onClick` or another function from a Server Component to a Client Component fails at render time.

```text
Event handlers cannot be passed to Client Component props.
```

**Why it happens.** Props crossing the server/client boundary are serialized, and a function cannot be serialized unless it is a Server Action.

**What denext does.** denext drops the function prop and prints one development warning per component and prop that names both fixes (make it a Server Action, or move the handler into a `"use client"` component). The `denext/no-handlers-in-async` lint rule reports it before the code runs. The handler still does not run, so treat the warning as an error.

**Evidence.**

- [`tests/flight-integration.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/flight-integration.test.ts): "a function prop from a Server Component to a client component warns once in dev"
- [`tests/lint-plugin.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/lint-plugin.test.ts): "flags an inline arrow / function handler in an async component"

More: [/docs/client-components](/docs/client-components).

### A page that uses hooks without "use client"

**Stack:** Next.js App Router (13.4 and later) · **Kind:** trade-off

**The problem.** A page or layout that calls `useState` or another hook fails because it is a Server Component by default.

```text
You're importing a component that needs useState
It only works in a Client Component but none of its parents are marked with "use client"
```

**Why it happens.** Server Components cannot hold state or effects, and a module is a Server Component unless it or an importer says `"use client"`.

**What denext does.** denext hydrates the route instead of failing: the page renders on the server and becomes interactive in the browser. The cost is a larger client bundle for that route, and the build still fails if the route reaches a server-only module. Keeping hooks in a `"use client"` file remains the better shape.

**Evidence.**

- [`tests/hydration.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/hydration.test.ts): "interactive: hooks, event handlers, and dynamic() each force hydration"

More: [/docs/client-components](/docs/client-components).

### A strict Content Security Policy without nonces or dynamic rendering

**Stack:** Next.js App Router (13.4 and later) · **Kind:** difference

**The problem.** Adding a strict CSP to a Next.js app means generating a nonce in middleware, which makes every page dynamically rendered.

**Why it happens.** A nonce must be unique per response, so pages that carry one cannot be statically generated or cached.

**What denext does.** Every denext page response carries a strict CSP by default. It is hash-based (the framework's own inline code is hashed), so static, cached, streamed and partially prerendered pages keep it. Routes opt external hosts in per directive, or opt out.

**Evidence.**

- [`tests/csp-integration.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/csp-integration.test.ts): "a page response carries a strict default CSP"
- [`tests/csp-integration.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/csp-integration.test.ts): "a cache hit reuses the stored CSP"
- [`tests/csp.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/csp.test.ts): "computeStreamingCsp: script-src carries the swap runtime hash"

More: [/docs/security](/docs/security).

## React

### "process is not defined" in the browser

**Stack:** React apps bundling npm libraries (any) · **Kind:** fix

**The problem.** An npm library or app module reads `process.env` in code that runs in the browser and throws on load.

```text
ReferenceError: process is not defined
```

**Why it happens.** `process` is a Node.js global; browsers do not have it, and not every bundler injects it.

**What denext does.** denext's client bundles get a small injected `process` shim, so `process.env` reads resolve (to the public env values) instead of throwing.

**Evidence.**

- [`tests/next-compat.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/next-compat.test.ts): "browserProcessShimPath: an injected process shim serves env reads in a browser bundle"

More: [/docs/npm-react-libraries](/docs/npm-react-libraries).

### "Invalid hook call" from two copies of React

**Stack:** React apps with linked or nested dependencies (any) · **Kind:** fix

**The problem.** Hooks throw because a library resolved its own copy of React, so the app has two.

```text
Invalid hook call. Hooks can only be called inside of the body of a function component.
```

**Why it happens.** A package manager installs a second `react` (a linked package, a mismatched peer range), and each copy keeps its own hook state.

**What denext does.** denext maps every React-family specifier (`react`, `react-dom`, `react/jsx-runtime`, …) to its single runtime for the whole module graph, npm libraries included, so there is only one copy.

**Evidence.**

- [`tests/react-specifiers.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/react-specifiers.test.ts): "next-compat REACT_ALIASES covers exactly the full react-family set"
- [`tests/next-compat.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/next-compat.test.ts): "resolveReactFamilyFile: mapped specifiers resolve directly"

More: [/docs/npm-react-libraries](/docs/npm-react-libraries).

### Child components re-render when their props did not change

**Stack:** React (any) · **Kind:** difference

**The problem.** A parent update re-renders every child, so apps wrap components in `memo` or adopt the React Compiler to avoid wasted renders.

**Why it happens.** React re-renders a component's subtree on every update unless a component is memoized.

**What denext does.** denext skips re-rendering a function component whose props are shallow-equal to the last render; context changes still reach consumers. This differs from React, where only `memo` components bail out: code that relied on a child re-rendering with unchanged props should read state or context instead. denext's compiler adds React-Compiler-style memoization without Babel.

**Evidence.**

- [`tests/memo.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/memo.test.ts): "auto-bailout: a component with stable props is not re-rendered on a parent update"
- [`tests/compiler.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/compiler.test.ts): "a compiled parent skips re-rendering a child with stable deps"

More: [/docs/differences](/docs/differences).

### Error boundaries do not catch errors thrown in event handlers

**Stack:** React (any) · **Kind:** difference

**The problem.** An exception in an `onClick` handler is not caught by the surrounding error boundary, so the UI keeps going in a broken state.

**Why it happens.** React's error boundaries only catch errors thrown while rendering and in lifecycle methods.

**What denext does.** denext routes an error thrown in an event handler to the nearest error boundary, which shows its fallback, as it does for render errors. This differs from React; code that catches its own handler errors is unaffected.

**Evidence.**

- [`tests/fiber-effect-errors.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/fiber-effect-errors.test.ts): "an event-handler error still reaches the boundary after an ancestor re-rendered"

More: [/docs/error-handling](/docs/error-handling).

### Icon and utility barrels pulling whole libraries into the bundle

**Stack:** React apps on Vite or other bundlers (any) · **Kind:** capability

**The problem.** Importing one icon from `lucide-react` (or a function from `date-fns`, `lodash-es`) loads the package's whole barrel file in development and can bloat the bundle.

**Why it happens.** A barrel module re-exports every member, and the bundler has to load it to find the one you used.

**What denext does.** Named imports from listed packages are rewritten to the modules that define them, so the barrel is never loaded. A built-in list (lucide-react, date-fns, lodash-es and others) is on by default, in SPA mode too. Next.js offers the same option as `optimizePackageImports`; denext uses the same key.

**Evidence.**

- [`tests/optimize-package-imports.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/optimize-package-imports.test.ts): "rewrite: named imports go to their defining modules, aliases kept"

More: [/docs/bundling](/docs/bundling).

## Backend features

### End-to-end typed API calls without tRPC

**Stack:** Next.js route handlers (any) · **Kind:** capability

**The problem.** Route handlers take and return untyped JSON, so clients either duplicate the types or add tRPC or a code generator.

**Why it happens.** A `route.ts` handler is a plain `Request` → `Response` function with no schema the client can see.

**What denext does.** `defineApi` validates params, query and body with any Standard Schema library (Zod, Valibot, ArkType, …), strips undeclared response keys, and the dev server generates a typed client from the route modules, so `createApiClient()` and `useApi` check every call. GET calls in the same tick share one batched request.

**Evidence.**

- [`tests/define-api.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/define-api.test.ts): "defineApi: parsed params/query/body reach the handler; the return value is JSON"
- [`tests/define-api.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/define-api.test.ts): "defineApi: the response schema always runs and strips undeclared keys (data-leak guard)"
- [`tests/api-batch.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/api-batch.test.ts): "api batch: runs GET/HEAD items through the pipeline and returns each result"

More: [/docs/typed-api](/docs/typed-api).

### Live updates and subscriptions without a separate WebSocket server

**Stack:** Next.js route handlers on serverless hosts (any) · **Kind:** capability

**The problem.** Pushing live data to the browser from a Next.js app needs a separate WebSocket server or a hosted realtime service.

**Why it happens.** Route handlers answer one request with one response; serverless functions do not keep connections open.

**What denext does.** denext's server holds the socket: `defineSubscription` validates input, authorizes each subscriber and pushes a new value when a tag is revalidated, and `createChannel` publishes events to authorized subscribers.

**Evidence.**

- [`tests/live-data.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/live-data.test.ts): "defineSubscription hub: validated input, server-derived tags, recompute on invalidation"
- [`tests/live-data.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/live-data.test.ts): "channel hub: an authorized subscriber receives publishes (codec-encoded), fanned out to every connection"

More: [/docs/live](/docs/live).

### Scheduled jobs without a platform cron service

**Stack:** Next.js (any) · **Kind:** capability

**The problem.** Running a nightly cleanup or digest from a Next.js app needs the host's cron feature, an external scheduler or a queue.

**Why it happens.** Next.js has no scheduler of its own.

**What denext does.** A task in `tasks/<name>.ts` with `defineTask` runs on a cron schedule (`Deno.cron` where available, else a built-in scheduler that never overlaps a running instance), on demand with `runTask()` or `denext task <name>`, with optional run history.

**Evidence.**

- [`tests/tasks.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/tasks.test.ts): "scheduleTasks uses Deno.cron when available and hands it the schedule"
- [`tests/tasks.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/tasks.test.ts): "userland scheduler: never on registration, once per matching minute, never overlapping, aborted on dispose"
- [`tests/cli-task-history.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/cli-task-history.test.ts): "a manual CLI run is recorded, exactly like a scheduled one"

More: [/docs/tasks](/docs/tasks).

### A self-hosted data cache that survives restarts

**Stack:** Next.js self-hosted (13.4 and later) · **Kind:** difference

**The problem.** A self-hosted Next.js app keeps its data and page cache in memory and on the local filesystem; sharing it across instances needs a custom `cacheHandler`.

**Why it happens.** The default cache handler is local to the process and its disk.

**What denext does.** denext's default cache store is a durable `node:sqlite` file (no extra service), and the `CacheStore` interface is pluggable for a shared backend. An unwritable path falls back to memory with one log line, and the health endpoint reports which store is active.

**Evidence.**

- [`tests/cache-default-store.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/cache-default-store.test.ts): "chooseCacheStore: a durable-store path resolves to a functional node:sqlite store"
- [`tests/cache-default-store.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/cache-default-store.test.ts): "/_denext/health reports the store kind, so a silent fallback to memory is visible from the probe"

More: [/docs/multi-instance](/docs/multi-instance).

### Rate limits bypassed with a forged X-Forwarded-For

**Stack:** any server reading x-forwarded-for (any) · **Kind:** capability

**The problem.** A rate limiter keyed on the `x-forwarded-for` header is bypassed by a client that sends a new value with each request.

**Why it happens.** Any client can set the header; it is only meaningful when a proxy you control overwrites it.

**What denext does.** denext's `clientIp()` and its rate limiters use the socket peer address unless you declare a trusted proxy (`trustForwardedHeaders`), and then only the proxy's last hop. The sign-in limiter is on by default.

**Evidence.**

- [`tests/auth-rate-limit.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/auth-rate-limit.test.ts): "credentials: a forged x-forwarded-for cannot dodge the limiter (untrusted by default)"
- [`tests/define-api.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/define-api.test.ts): "rateLimit: the (max+1)th request in a window is a 429 with retry-after; forged XFF is ignored"

More: [/docs/auth](/docs/auth).

## React Native and Expo

### Inverted FlatList on the web scrolls the wrong way

**Stack:** react-native-web FlatList (any) · **Kind:** fix

**The problem.** With react-native-web, an `inverted` FlatList (the usual chat layout) scrolls in the opposite direction to the mouse wheel and reverses text selection.

**Why it happens.** react-native-web implements `inverted` with a `scaleY(-1)` transform, which flips the scroll and selection direction along with the layout.

**What denext does.** In React Native mode, FlatList runs on denext's VirtualList and `inverted` is a logical reversal: item 0 is at the bottom without a transform, `onEndReached` fires at the visual top, and `scrollToIndex` / `scrollToOffset` are mirrored.

**Evidence.**

- [`tests/react-native-lists.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/react-native-lists.test.ts): "FlatList inverted: a logical reversal — item 0 at the bottom, no scaleY, header at the bottom"
- [`tests/react-native-lists.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/react-native-lists.test.ts): "FlatList inverted: chat semantics — onEndReached is the visual top; scrollToIndex / scrollToOffset mirror"

More: [/docs/react-native](/docs/react-native).

### Reanimated on the web without the Babel plugin

**Stack:** react-native-reanimated on the web (3.x, 4.x) · **Kind:** fix

**The problem.** Reanimated worklets fail on the web when the Babel plugin is missing from the web build, and the plugin ties the build to Babel.

```text
Failed to create a worklet
```

**Why it happens.** Reanimated relies on a Babel plugin to capture each worklet's closure at build time.

**What denext does.** denext's React Native mode captures worklet closures with its own transform during the build, so Reanimated runs on the web with no Babel plugin, and reports the call it cannot derive a closure for by file and line.

**Evidence.**

- [`tests/reanimated-worklets.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/reanimated-worklets.test.ts): "worklets: hook callbacks capture what the Babel plugin captures"
- [`tests/reanimated-worklets.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/reanimated-worklets.test.ts): "reanimatedWorkletsPlugin: stamps gated modules, app and node_modules; warns at file:line"

More: [/docs/react-native](/docs/react-native).

### Over-the-air UI updates without a hosted update service

**Stack:** Expo / React Native apps (any) · **Kind:** capability

**The problem.** Shipping a UI fix to a mobile app without a store review usually depends on a hosted update service.

**Why it happens.** The app binary bundles its UI, so a change needs a new binary unless something downloads and activates a new bundle.

**What denext does.** A denext app in the Capacitor shell checks a manifest you host (`denext ota manifest`, optionally signed), downloads the changed files and applies them on the next start. A binary whose native layer does not match the manifest refuses the update.

**Evidence.**

- [`tests/mobile-ota.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/mobile-ota.test.ts): "checkForUiUpdate: a different version → apply with baseUrl, headers, manifest"
- [`tests/ota-manifest.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/ota-manifest.test.ts): "ota manifest: any changed file changes the version"
- [`tests/ota-channels.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/ota-channels.test.ts): "onNativeUpdateRequired: fired for native_too_old / native_mismatch only; a throw is swallowed"

More: [/docs/mobile](/docs/mobile).

## Migrating an existing app

### Will my existing app run?

**Stack:** Next.js App Router, Remix (current) · **Kind:** capability

**The problem.** Before trying a new framework, teams want to know whether their existing app runs without a rewrite.

**Why it happens.** Framework migrations usually start with rewriting imports, config and routes.

**What denext does.** `denext migrate` writes config only (a `deno.json` alias map and a `denext.config.ts`), so the app's own source is unchanged for Next.js. Two public apps are migrated, built and rendered by a nightly test: Vercel's App Router playground and the Epic Stack (Remix). `denext migrate --check` reports what would change for your app first.

**Evidence.**

- [`tests/migration-bed/next-app-router-playground.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migration-bed/next-app-router-playground.test.ts): "migration bed: vercel/next-app-router-playground migrates, builds, and renders"
- [`tests/migration-bed/epic-stack.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migration-bed/epic-stack.test.ts): "migration bed: epicweb-dev/epic-stack (Remix) migrates, builds, and renders"

More: [/docs/migrating](/docs/migrating).

### Pages Router apps

**Stack:** Next.js Pages Router (12 and later) · **Kind:** capability

**The problem.** A `pages/` app uses `getServerSideProps`, `next/router` and `next/head`, which the App Router does not have.

**Why it happens.** The Pages Router is a separate routing and data model.

**What denext does.** `denext migrate` detects `pages/` and wires the `@denext/pages-router` plugin, which runs `getServerSideProps`, `getStaticProps`, `_app`, `_document` and API routes, and points `next/router`, `next/link` and `next/head` at it.

**Evidence.**

- [`tests/pages-router.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/pages-router.test.ts): "handler runs getServerSideProps and passes props to the page"
- [`tests/migrate-universal.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migrate-universal.test.ts): "Pages Router: maps next/router|link|head to the pages-router plugin + pins ^0.8.0"

More: [/docs/pages-router](/docs/pages-router).

### next.config wrappers and MDX plugins carried over

**Stack:** Next.js with @next/mdx or config plugins (any) · **Kind:** capability

**The problem.** A `next.config` wrapped by `createMDX` or a docs framework's plugin hides its options (remark and rehype plugins) inside a webpack loader, so they are lost when moving to another build.

**Why it happens.** The wrapper stores the plugin functions in a closure that only its webpack loader reads.

**What denext does.** `denext migrate` evaluates the config in a sandboxed subprocess (read access to the project only), keeps the honored keys even when a wrapper crashes after returning the config, and the generated config recovers the MDX plugins at build time.

**Evidence.**

- [`tests/migrate-universal.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migrate-universal.test.ts): "next.config is honored even when a plugin wrapper crashes AFTER exporting it"
- [`tests/migrate-universal.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migrate-universal.test.ts): "App Router with MDX plugins: config recovers them at build time (no hand-edit)"
- [`tests/next-mdx-recover.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/next-mdx-recover.test.ts): "resolveNextMdx recovers live remark plugins + providerImportSource from next.config"

More: [/docs/migrating](/docs/migrating).

### tsconfig path aliases (@/*) in monorepos

**Stack:** TypeScript apps (any) · **Kind:** capability

**The problem.** `@/*` and other `paths` aliases stop resolving when the build tool does not read the tsconfig, especially when the aliases live in a monorepo-root tsconfig or the file has comments.

**Why it happens.** `paths` is TypeScript configuration; each bundler reads it differently, and tsconfig files are JSONC.

**What denext does.** `denext migrate` reads the tsconfig with a JSONC parser, follows `extends` and a monorepo-root tsconfig, and writes the aliases into the `deno.json` import map relative to the app.

**Evidence.**

- [`tests/migrate-universal.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migrate-universal.test.ts): "workspace app: monorepo-root tsconfig paths become deno.json aliases (relative to app)"
- [`tests/migrate-universal.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migrate-universal.test.ts): "App Router: `@/*` alias survives a tsconfig carrying a `$schema` URL (JSONC parse)"

More: [/docs/migrating](/docs/migrating).

### React Compiler memoization kept when moving a Vite app

**Stack:** Vite + React with babel-plugin-react-compiler (any) · **Kind:** capability

**The problem.** A Vite app that relies on the React Compiler re-renders far more after moving to a build that does not run the Babel plugin.

**Why it happens.** The compiler's memoization is a build step; without it every component re-renders with its parent.

**What denext does.** `denext migrate` detects the React Compiler in the Vite config and turns on denext's own auto-memo compiler (`reactCompiler: true`), which needs no Babel.

**Evidence.**

- [`tests/migrate-spa.test.ts`](https://github.com/Brainwires/denext/blob/main/tests/migrate-spa.test.ts): "migrate SPA: React Compiler in the Vite config enables denext's auto-memo compiler"

More: [/docs/spa](/docs/spa).
