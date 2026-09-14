---
title: Upgrading
slug: upgrading
lead: The breaking changes and renamed config keys per denext version, as a checklist — what to change when you bump, each linked to its changelog entry.
---

This page is a **checklist view** of the changelog: only the breaking changes,
the renamed or removed config keys, the removed exports, and the default flips
that need you to do something. Features, fixes and everything else live in the
[changelog](/docs/changelog), which stays the source of truth — every item below
links back to the release that introduced it.

## Before every upgrade

- **Read the changelog section for the version you are bumping to** — this page
  lists only what needs action; the [changelog](/docs/changelog) has the rest.
- **Bump the version, then run `deno task check`** (fmt, lint, tests — type
  errors surface through `deno test`). A renamed export or a changed type shows
  up here first.
- **Run `denext doctor`.** It checks the Deno floor, the config shape (unknown
  and graduated keys warn with a did-you-mean) and renders every route, so a
  boundary or metadata change that broke a page fails loudly.
- **A migrated app: re-run `denext migrate` only if the section below says a
  generated file changed shape.** Migrate writes config by default and is
  non-destructive to your source; see [Migrating from Next.js](/docs/migrating).

## Upgrading to 2.5

2.5 is in release candidates; this section covers rc.1 and rc.2.

- **A help flag before the verb prints help instead of running the verb.**
  `denext --help build` used to run a build; it now prints `build`'s help. A
  script that relied on it runs `denext build`. An unknown flag before the verb
  is now an error instead of being silently ignored. ([2.5.0-rc.2](/docs/changelog))
- **`AuthProvider` has a third member, `EmailProvider` (`type: "email"`).** An
  exhaustive `switch` over `provider.type` needs an `"email"` case.
  `credentials()`'s `authorize` became optional and the internal
  `issueAuthSession` gained a trailing options argument — both source-compatible,
  nothing to change. ([2.5.0-rc.2](/docs/changelog))
- **The config schema no longer emits `x-denext.widget: "map"`.** Only a tool
  reading `denext.config.schema.json` is affected: detect a map from its
  `additionalProperties`. ([2.5.0-rc.2](/docs/changelog))
- **The `linkAccount` event carries identity only** — provider, provider-side id,
  type and owner. A handler that read provider tokens off it reads the stored
  account back through the adapter.
  ([2.5.0-rc.1](/docs/changelog#250-rc1---2026-09-14))
- **`Await<T>` is renamed `MaybePromise<T>`** (`denext/server`). Rename the
  import. ([2.5.0-rc.1](/docs/changelog#250-rc1---2026-09-14))
- **`InspectNode.source` (`denext/devtools`) is a `SourceLocation` object.** The
  old string stays as `sourceId` for one minor.
  ([2.5.0-rc.1](/docs/changelog#250-rc1---2026-09-14))
- **Raised the scrypt `cost`? Pass the same options to `verifyPassword`**, or an
  unknown account rejects measurably faster than a known one.
  ([2.5.0-rc.1](/docs/changelog#250-rc1---2026-09-14))
- **A custom `SessionStore` needs `update` for sliding expiry.** Without it a
  session is never slid forward, and the store warns once.
  ([2.5.0-rc.1](/docs/changelog#250-rc1---2026-09-14))
- **`denext --help` no longer lists a project's own verbs** — `denext commands`
  does, and shell completions still include them.
  ([2.5.0-rc.1](/docs/changelog#250-rc1---2026-09-14))

## Upgrading to 2.4

- **`denext deploy` was removed.** Deploy with `deployctl` (Deno Deploy), your
  host's own CLI, or the Docker/systemd recipes in the
  [deployment guide](/docs/deploy) — `denext generate docker` still scaffolds a
  Dockerfile. ([2.4.0](/docs/changelog#240---2026-09-11))
- **`useId()` emits a new, CSS-selector-safe id format** (`_d0-2-1_0_`, was
  `:d0.2.1_0:`). Nothing to change unless you pinned the literal old format —
  update those snapshots. ([2.4.0](/docs/changelog#240---2026-09-11))

## Upgrading to 2.3

No breaking changes.

## Upgrading to 2.2

No breaking changes.

## Upgrading to 2.1

No breaking changes.

## Upgrading to 2.0

The 2.0 cycle aligned denext's App Router with Next.js 15's shapes. Most items
below are a break only if your code depended on the old, non-Next shape.

### Config keys

- **`nextCompat` → `compatibilityMode`.** Rename the key (the value is
  unchanged: `boolean | "auto"`); the old key is no longer accepted. The scaffold
  flag `--next-compat` is now `--compatibility`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`experimental.streaming` → `streaming` and `experimental.live` → `live`.**
  The legacy keys are no longer read — move the value up. An app that set
  `experimental.streaming: false` (a CSS-in-JS app, say) now streams until you
  set top-level `streaming: false`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`experimental.nodeResolve` → `nodeResolve` and `experimental.compiler` →
  `experimental.reactCompiler`.** Both old keys still work as deprecated aliases
  (removed in 3.0) and dev-warn — move them when convenient. Likewise
  `experimental.cacheComponents` → top-level `cacheComponents`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`trailingSlash` defaults to Next's behavior.** An unset `trailingSlash` now
  redirects `/about/` → `/about` (308); set `trailingSlash: true` to keep the
  slashes. ([2.0.0](/docs/changelog#200---2026-09-05))
- **Deno KV cache backend (`denoKvCacheStore`) was removed.** Use the default
  SQLite cache store (Deno KV is still fine as an app database).
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **The Deno floor is `≥ 2.9`.** Upgrade Deno before you upgrade denext.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`@denext/htmx` `≥ 2.0.11` and `@denext/pages-router` `≥ 0.9.1` are
  required.** Older releases import barrel exports 2.0 removed — bump them in
  the same commit. ([2.0.0](/docs/changelog#200---2026-09-05))

### Routing and request handling

- **Catch-all params are `string[]`.** `app/docs/[...path]` yields
  `params.path = ["a", "b", "c"]`, not `"a/b/c"` — add `.join("/")` where you
  need the path form. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`searchParams` is a record, not a `URLSearchParams`.** `?a=1&a=2&b=x` is
  `{ a: ["1", "2"], b: "x" }`; the `URLSearchParams` is `searchParams.raw`.
  Both `params` and `searchParams` are now also awaitable, so Next 15 code ports
  unchanged. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`_folder` directories are private.** A folder starting with `_` is never
  routable — if you relied on a `/_components` route, rename the folder.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Route ordering is position-aware.** Specificity is compared segment by
  segment from the left, so `/a/[b]` now wins `/a/b` over `/[a]/b`. Check any
  route pair you disambiguated by relying on the old positional sum.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Per-segment `error.tsx` / `loading.tsx` boundaries.** A throw in a nested
  `layout.tsx` is caught by the nearest ancestor segment's `error.tsx` instead
  of escaping to the 500 page — re-check where your boundaries sit.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Middleware runs BEFORE config `rewrites`, and matchers see the
  locale-stripped path.** An `/admin/:path*` matcher now fires even when a
  rewrite maps `/admin/x` elsewhere, and `/dashboard/:path*` fires for
  `/fr/dashboard` under `i18n` — re-read your matchers.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Parentheses in a middleware matcher are regex groups.** Escape `\(` for a
  literal parenthesis. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`global-error.tsx` owns the document.** It replaces the root layout and must
  render its own `<html>` and `<body>` — denext no longer wraps it.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Segment config inherits what a child does not set.** A layout's
  `dynamic = "force-static"` now reaches a page that exports no `dynamic` —
  export the field explicitly where you want the child to win.
  ([2.0.0](/docs/changelog#200---2026-09-05))

### Server APIs

- **`redirect` on `denext/server` is renamed `redirectResponse`.** Use
  `redirectResponse()` in `middleware.ts`; `redirect` stays as a deprecated
  alias (removed in 3.0) and now means the throwing `redirect()` everywhere
  else. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`cookies().get(name)` returns `{ name, value } | undefined`.** Read
  `.value`; `getAll()` returns an array.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`headers()` is read-only.** `set` / `append` / `delete` throw a `TypeError`
  — build a new `Headers` instead.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`unstable_noStore()` actually opts out of the page cache.** A `revalidate`
  route that calls it is rendered per request — audit where you called it as a
  no-op. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`defineAction` redacts handler errors in production.** A non-validation
  throw yields `{ ok: false, error: "Internal Server Error", digest }`; if your
  UI showed `state.error` to users, surface the `digest` instead.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`Metadata` is Next.js-shaped.** `openGraph.image` / `twitter.image` are now
  `images` (the singular key emitted no `og:image` at all) — rename them.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **Session tokens are domain-separated.** Sessions issued by a 2.0.0 release
  candidate are invalidated once; users sign in again. Nothing to change.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **A short auth secret throws at boot in production**, and the credentials rate
  limiter ignores `x-forwarded-for` unless `trustForwardedHeaders: true` — set a
  long `AUTH_SECRET`, and opt in if you sit behind a trusted proxy.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`NextRequest.ip` no longer trusts the first `x-forwarded-for` hop.** It
  prefers the socket peer, then the LAST hop, then `x-real-ip`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`userAgent().device.type` is `undefined` for a desktop** (was `"desktop"`),
  matching ua-parser-js. ([2.0.0](/docs/changelog#200---2026-09-05))

### Client APIs

- **`useSearchParams()` returns `ReadonlyURLSearchParams`.** `append` / `delete`
  / `set` / `sort` throw; it is memoized per query string, so
  `useEffect(…, [searchParams])` stops re-running every render.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`useRouter()` is Next's `AppRouterInstance`** (`push`, `replace`,
  `prefetch`, `back`, `forward`, `refresh`) and is one stable object.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`Link` composes your props instead of overwriting them**, leaves
  `target="_blank"` / `download` / `rel="external"` to the browser, and
  `prefetch` is `boolean | null` (`null` = in-viewport only).
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`dynamic()`'s `loading` component receives Next's props**
  (`{ error, isLoading, pastDelay, timedOut, retry }`), not the wrapped
  component's props. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`composeRefs()` returns a cleanup** and honors a callback ref's returned
  cleanup (React 19) instead of calling every ref again with `null`.
  ([2.0.0](/docs/changelog#200---2026-09-05))
- **`Children.count` / `Children.forEach` include holes and `Children.only`
  throws for anything but one element** (React's semantics).
  ([2.0.0](/docs/changelog#200---2026-09-05))

### Removed exports

- **89 internal symbols left the public barrels** (`denext`, `denext/server`,
  `denext/client`, `denext/testing`) — framework plumbing an application never
  calls. `Dispatcher` is gone from `denext`; `denext/build/next-compat` and
  `denext/remix` are curated barrels without their test seams; the Google-font
  build helpers left `denext/next/font/google`. Import from the source module if
  you genuinely need one. ([2.0.0](/docs/changelog#200---2026-09-05))
- **`denext migrate --drop-in` was removed**, and source rewriting is now opt-in
  via `--codemod` (it used to be implied). Pass `--codemod` to get the old
  default. ([2.0.0](/docs/changelog#200---2026-09-05))

> Deprecated, not yet removed: `images.domains` (→ `images.remotePatterns`),
> `useFormState` (→ `useActionState`), `unstable_noStore` (→ `connection()`) and
> `io()` all still work through 2.x and are removed in 3.0. Each carries an
> `@deprecated` tag, so your editor strikes it through.
