# denext — Mission

> **Write it once, ship it everywhere: one complete, lightweight framework for every platform,
> every accepted web-framework feature and the packages you already use.**

denext is a complete software development framework for [Deno](https://deno.com). Its job is to
let one team build one app, in one language, from one codebase, and ship it to every platform
people use, without assembling a stack from parts or waiting for an ecosystem to grow around it.
Four pillars, in order:

1. **Write it once, ship it everywhere.** One codebase, one component model, one router and one
   typed API layer become a web app (server-rendered with streaming, a static export, or a
   client-only SPA), an iOS and Android app (a Capacitor shell driven by `denext/mobile`) and a
   desktop app for macOS, Windows and Linux (Deno Desktop at Electron parity: menus, tray,
   notifications, dialogs, deep links, single-instance, signed full-app self-updates and
   least-privilege packaging). The same `denext/mobile` call reaches Capacitor on a phone, the
   native runtime in a desktop window and a web fallback in a browser, so a component does not
   need to know where it runs. One CLI takes the app from `create` to a signed store build or a
   signed, distributable desktop app.

2. **Every accepted web-framework feature, in one unified framework.** The features a product
   otherwise assembles from several frameworks and libraries are built in and designed together:
   the App Router with Server Components, Server Actions and streaming Suspense; every rendering
   strategy (SSR, static export, Partial Prerendering with Cache Components, Astro-style islands,
   Qwik-style resumability); Live Server Components and typed server push; an end-to-end typed API
   that also serves OpenAPI and GraphQL; first-party auth; Deno's built-in SQLite, KV, Postgres,
   Drizzle and Prisma; `use cache`; cron tasks; typed content collections; a plugin seam for the
   rest. They sit behind the conventions developers already know, and they are **secure by
   default**: a strict hash-based CSP, CSRF-defended Server Actions, signed `httpOnly` cookies,
   SSRF-safe fetch and image optimization, and Deno's permission sandbox around the runtime.
   [FEATURES.md](./FEATURES.md) lists every one, with the mechanism.

3. **Surface compatible, so the existing ecosystem works.** denext reproduces the React, Next.js,
   Remix / React Router, React Native and Expo _surfaces_, so existing `npm:` and `jsr:` packages
   and component libraries run as they are: Radix, Base UI, shadcn/ui, TanStack Router, recharts,
   react-hook-form, lucide, next-intl and the rest. Real codebases prove it: the shadcn/ui site,
   the Next.js App Router playground and the Epic Stack (the last two re-migrated nightly in CI),
   and T3 Code's web and desktop app. `denext migrate` brings an existing app across in one pass
   with its source intact. **No new ecosystem has to be built for denext to succeed**; the one
   developers already have is the ecosystem. Compatibility is honest: we never claim 100% parity,
   and the gaps are listed in [KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) and
   [KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md).

4. **Lightweight.** denext brings its own small React 19-compatible core instead of React +
   ReactDOM + a framework runtime. On `examples/hello` the shared client runtime is **19.6 KB**
   gzipped against 136.9 KB for the same routes on Next.js 16.3 + React 19.2 (about 7× less); a
   page with no interactivity ships **0 KB** of JavaScript; a library-heavy app ships 1.8–4.9×
   less; SSR throughput and time to interactive are on par or faster
   ([bench/REPORT.md](./bench/REPORT.md)). The framework's runtime carries **no npm
   dependencies**, CI-enforced, so what ships is auditable end to end. First-party Rust→WASM
   (`@denext/swc`, `@denext/lightningcss`, `@denext/photon`, `@denext/avif`, `@denext/og`) is
   on-brand, not an exception: JSR packages built from source we own and audit. Zero-npm is about
   the **runtime**; the build-time toolchain still uses `esbuild` and a few opt-in npm tools.

---

Lead with the first pillar: one app, every platform. The second makes it complete, the third makes
it adoptable today, and the fourth keeps it small and fast while doing all of it.

**See also:**
[FEATURES.md](./FEATURES.md) — what's shipped ·
[ROADMAP.md](./ROADMAP.md) — what remains ·
[Architecture](https://denext.dev/docs/architecture) — the deliberate under-the-surface choices ·
[KNOWN-LIMITATIONS.md](./KNOWN-LIMITATIONS.md) — the honest surface gaps ·
[KNOWN-DIFFERENCES.md](./KNOWN-DIFFERENCES.md) — deliberate behavioral differences ·
[POLICIES.md](./POLICIES.md) — the standing engineering guardrails and the security policy
(how to report a vulnerability).
