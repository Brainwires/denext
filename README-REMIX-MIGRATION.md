<p align="center">
  <img src="./assets/app-image.png" alt="denext" width="180">
</p>

# Migrating a Remix app to denext

This guide covers moving an existing **Remix (v2, or React Router v7 framework
mode)** application to [denext](./README.md), a from-scratch Next.js-style
framework for Deno with zero runtime npm dependencies. It reflects what
`denext migrate --from remix` actually does today, including its honest limits.

The short version: **your data model stays as it is.** Loaders and actions keep
running on the server, `useLoaderData`, `<Form>`, `useFetcher`, sessions, and
`defer` keep working, because denext ships a first-party `denext/remix` runtime
that implements Remix's surface on denext primitives. What moves is the
**route tree**: `app/routes/*` is relocated to denext's folder-per-segment
conventions and each route module is split into a server half and a client
half. That transform is automated and reported, so the work is in reviewing
the report and validating the edges.

The condensed version of this guide is the docs page at
[denext.dev/docs/migrating-remix](https://denext.dev/docs/migrating-remix).

---

## 1. Before you start: is your app a good fit?

`denext migrate` recognizes a Remix app from any of these signals, in order:

- a `@remix-run/*` dependency in `package.json`;
- a `remix.config.js` / `.mjs` / `.ts`;
- a React Router v7 framework install (`react-router` or `@react-router/*` plus a
  `react-router.config.ts` / `.js`);
- the structural signature `app/root.tsx` + `app/routes/`.

Remix is checked **before** the Vite-SPA detector, because a Remix-Vite app also
carries a `vite.config`, which would otherwise be taken for a client-only SPA.
Pass `--from remix` when you want to force the path regardless.

Two install-shape requirements apply to every migrate path, not only Remix:

- **Apps with an installed `node_modules`** (most real apps) need
  `--node-modules-dir=none` on the `deno run` that launches the CLI, so Deno
  does not enter manual-`node_modules` mode and lose the CLI's own build
  dependencies. Your app's `node_modules` is untouched either way.
- **Yarn Plug'n'Play is unsupported.** denext resolves the app's dependencies
  from `node_modules` on disk, and PnP does not create one. Migrate aborts with
  a message naming the fix: add `nodeLinker: node-modules` to `.yarnrc.yml` and
  reinstall.

Anything in your app that is not Remix-specific (npm React UI libraries, server
SDKs, databases) follows the same rules as a Next.js migration. Read
[README-NEXT-MIGRATION.md](./README-NEXT-MIGRATION.md) §1 (the dependency
probes), §5 (real npm React libraries through the compat build), and §6
(server-side dependencies on Deno) for that side; this guide does not repeat
them.

---

## 2. Compatibility at a glance

| Remix surface                                                                                  | Status                                                |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Flat routes, dot-nested routes, v2 folder routes (`route.tsx`)                                 | ✅ relocated to `app/**/page.tsx` + `layout.tsx`      |
| `$param`, `$` splat, `_index`, pathless `_layout`, `[.]` escapes                               | ✅                                                    |
| Trailing-`_` layout break-out (`dashboard_.settings`)                                          | ⚠️ flattened and flagged for review                   |
| `loader` / `action` (server-side, `json`, `redirect`, `data`, thrown `Response`)               | ✅ run on the server, unchanged                       |
| `useLoaderData`, `useActionData`, `useRouteLoaderData`, `useMatches`                           | ✅ (Remix-canonical route ids preserved)              |
| `<Form>`, `useSubmit`, `useNavigation`, `useFetcher` / `useFetchers`, `useRevalidator`         | ✅ backed by denext Server Actions                    |
| `<Link>`, `<NavLink>`, `useNavigate`, `useLocation`, `useParams`, `useSearchParams`, `useHref` | ✅                                                    |
| `<Outlet>`, `useOutletContext`, nested layouts                                                 | ✅                                                    |
| `ErrorBoundary`, `useRouteError`, `isRouteErrorResponse`                                       | ✅ mapped to `error.tsx`                              |
| v1 `CatchBoundary` / `useCatch`                                                                | ✅ renders, flagged: fold into `ErrorBoundary`        |
| `defer` + `<Await>`, `useAsyncValue`, `useAsyncError`                                          | ✅ streams; payload finalizes whole (see §8)          |
| `shouldRevalidate`                                                                             | ✅ honored; always-revalidate is the default          |
| `useBlocker`                                                                                   | ✅ in-app navigation + back/forward; not hard unload  |
| `meta` / `links` / `headers` / `handle`                                                        | ✅ `meta` bridged to `generateMetadata`; root flagged |
| Cookies and sessions (`createCookie`, `createCookieSessionStorage`, memory/custom storage)     | ✅ from `denext/remix/server`                         |
| `unstable_parseMultipartFormData` + memory upload handler                                      | ✅                                                    |
| Resource routes (loader/action, no component)                                                  | ✅ become an API `route.ts`                           |
| `<Meta>`, `<Links>`, `<Scripts>`, `<ScrollRestoration>`, `<LiveReload>`                        | ✅ stripped; denext owns the document                 |
| `@remix-run/css-bundle` (`cssBundleHref`)                                                      | ✅ resolves to `undefined`; denext handles CSS        |
| `entry.server.*` / `entry.client.*`                                                            | deleted; denext supplies both entries                 |
| Prisma                                                                                         | ✅ auto-rewired to the Deno client (see §8)           |

---

## 3. The command, and what it writes

```sh
# in the Remix project root
deno run --node-modules-dir=none -A jsr:@denext/denext@^2/cli migrate --from remix
deno task dev
```

Commit before you run it. The Remix path rewrites `app/` in place, and a clean
working tree makes the transform a single reviewable diff.

Config, written the same way as the Next path:

- **`deno.json`**, unless a hand-authored one already exists (a previously
  migrate-generated one is overwritten, so re-running is idempotent). It
  carries `dev` / `build` / `export` / `start` tasks, `nodeModulesDir: "auto"`,
  `react-jsx` compiler options with `skipLibCheck`, and the import map: the
  `denext` / `denext/server` / `denext/client` entries, **`denext/remix` and
  `denext/remix/server`** (the runtime the generated files import), the
  `react` / `react-dom` / `next/*` family aliases, your `tsconfig` path
  aliases, and a pinned `npm:name@version` passthrough for the app's own
  dependencies. `@remix-run/*` and `@react-router/*` are **dropped** from those
  pins: their route and data model is ported, not run.
- **`denext.config.ts`** with `compatibilityMode: true` (never clobbering an
  existing one).
- **`.gitignore`** entries for `.denext/` and `out/`, and a `.vscode` Deno LSP
  setting, appended only when missing.

Then the part that is unique to Remix: the route-tree transform (§4). When it
finishes, the CLI prints a report:

```
▸ Remix detected — route tree transformed to run on the denext/remix runtime.
  routes converted: 9 · app/root.tsx → app/layout.tsx · loaders: 3, actions: 1 (preserved & wired)
  each route → a server wrapper + a client component + a server data module (loader/action run on denext).
  removed: app/entry.server.tsx, app/entry.client.tsx
  ⚠️  review notes (2):
    · (auth)/login: pathless "_auth" → route group "(auth)"
    · dashboard/settings: layout break-out "dashboard_" (trailing _) flattened to "dashboard" — review nesting
```

Read the review notes before starting the app; §7 explains each kind.

---

## 4. How the route tree is transformed

### 4.1 Naming conventions

Every module under `app/routes/` is a route: flat files (`about.tsx`,
`concerts.$city.tsx`), and the v2 folder form (`concerts.$city/route.tsx`, with
the folder's other files left as co-located modules). Files ending in `.css`,
`.server.*`, or `.client.*` are skipped as non-routes. Each route stem is parsed
into denext folder segments:

| Remix stem            | denext folder             | Note                                              |
| --------------------- | ------------------------- | ------------------------------------------------- |
| `_index`              | `app/page.tsx`            | index of its parent segment                       |
| `about`               | `app/about/page.tsx`      |                                                   |
| `concerts.$city`      | `app/concerts/[city]/`    | dot nesting becomes folders; `$param` → `[param]` |
| `concerts._index`     | `app/concerts/page.tsx`   |                                                   |
| `concerts`            | `app/concerts/layout.tsx` | a route others nest under becomes the layout      |
| `files.$`             | `app/files/[...splat]/`   | a bare `$` is the catch-all                       |
| `_auth.login`         | `app/(auth)/login/`       | pathless layout → route group (no URL segment)    |
| `dashboard_.settings` | `app/dashboard/settings/` | trailing `_` break-out flattened and **flagged**  |
| `sitemap[.]xml`       | `app/sitemap.xml/`        | `[.]` escapes are unescaped                       |

A non-index route becomes a **layout** exactly when another route's path starts
with its own; otherwise it is a page. The layout keeps its `<Outlet />`, which
the runtime maps to the nested subtree.

### 4.2 The three-file split

A Remix route module holds a server `loader` and a client component in one
file. In denext a `"use client"` module cannot also run server code, so each
component route becomes three files in its destination folder:

1. **`page.client.tsx`** (or `layout.client.tsx`) is a `"use client"` module
   holding your default component, your `ErrorBoundary`, and any other named
   exports, plus the top-level helpers they reference. The default component is
   turned into a local declaration, and a generated default export wraps it in
   `RemixRouteProvider` (and `OutletProvider` for a layout) so that
   `useLoaderData`, matches, params, and the action are all resolved inside one
   client unit, on SSR and on hydrate. A `typeof loader` type reference gets an
   erased `import type` from the data module.
2. **`page.data.ts`** holds the server exports: `loader`, `action`, `meta`,
   `links`, `headers`, `handle`, and `shouldRevalidate`, with the helpers
   _they_ reference. A helper used by both halves is copied into both; one used
   by neither is dropped. This file is omitted when the route has no server
   exports.
3. **`page.tsx`** is the generated denext server wrapper. It imports the other
   two and calls `RemixRoute` (or `RemixLayout`), which runs the loader on the
   server, binds the action as a Server Action, records the match for
   `useMatches`, and renders the client boundary with the loader data passed as
   a **prop**, which is what carries it across the Flight boundary. The wrapper
   keeps the **Remix-canonical route id** (`routes/concerts.$city`, and `root`
   for the root), so `useRouteLoaderData("root")` and code that matches on
   `m.id` keep working. A `meta` export becomes
   `export const generateMetadata = remixMeta(data.meta, data.loader)`.

Before, `app/routes/concerts.$city.tsx`:

```tsx
import { json } from "@remix-run/node";
import { useLoaderData, useParams } from "@remix-run/react";

export function loader() {
  return json({ soldOut: false });
}

export default function City() {
  const { city } = useParams();
  const data = useLoaderData<typeof loader>();
  return <h2>{city}: {data.soldOut ? "sold out" : "available"}</h2>;
}
```

After, `app/concerts/[city]/page.data.ts`:

```ts
// Generated by `denext migrate --from remix` — Remix route on denext.
import { json } from "denext/remix/server";

export function loader() {
  return json({ soldOut: false });
}
```

After, `app/concerts/[city]/page.client.tsx` (the boundary trimmed):

```tsx
"use client";
import { useLoaderData, useParams } from "denext/remix";
import type { loader } from "./page.data.ts";
import { RemixRouteProvider } from "denext/remix";

function City() {
  const { city } = useParams();
  const data = useLoaderData<typeof loader>();
  return <h2>{city}: {data.soldOut ? "sold out" : "available"}</h2>;
}

export default function __RemixRouteBoundary(props: { id: string; loaderData: unknown /* … */ }) {
  return (
    <RemixRouteProvider id={props.id} loaderData={props.loaderData} /* … */>
      <City />
    </RemixRouteProvider>
  );
}
```

After, `app/concerts/[city]/page.tsx`:

```tsx
import Route from "./page.client.tsx";
import * as data from "./page.data.ts";
import { RemixRoute } from "denext/remix/server";

export default function Page(props: { params: Record<string, string> }) {
  return RemixRoute({
    id: "routes/concerts.$city",
    loader: data.loader,
    Route,
    params: props.params,
  });
}
```

### 4.3 `route.ts` beside a page with an `action`

In Remix a POST to a route's URL runs its action. denext serves a page's GET
from `page.tsx`, so a page route that exports an `action` also gets a generated
`route.ts` with a single `POST` handler
(`runActionResponse(data.action, request, ctx.params)`), the URL params
threaded from the matched pattern. That is what keeps a **cross-route**
`fetcher.submit` or `<Form action="/other">`, and the no-JavaScript form post
to another page, working. A redirecting cross-route action is followed as a
soft navigation. Layout routes do not get one.

### 4.4 Resource routes

A route module with a `loader` or `action` but no default component is a
resource route. It becomes a denext API route: `page.data.ts` (or
`layout.data.ts`) plus a `route.ts` exporting `GET` (`runLoaderResponse`) and
/ or `POST` (`runActionResponse`), and the report notes the conversion.

### 4.5 `ErrorBoundary` → `error.tsx`

A route exporting `ErrorBoundary` (or a v1 `CatchBoundary`) gets an
`error.tsx` that renders the boundary through `RemixErrorProvider`, so
`useRouteError`, `isRouteErrorResponse`, and `useCatch` read the caught value.
When a route has both, only `ErrorBoundary` is wired (§7).

### 4.6 `app/root.tsx` → `app/layout.tsx`

`<Meta />`, `<Links />`, `<Scripts />`, `<ScrollRestoration />`, and
`<LiveReload />` are stripped: denext owns the document and injects its own
head and scripts. A `meta` export is bridged to `generateMetadata`. Then one of
two shapes is emitted:

- A **pure document shell** (no hooks, no JSX event handlers, no loader or
  action) becomes a plain **server** layout: the `<html>` / `<head>` / `<body>`
  wrapper is reduced to its body children (denext supplies the document
  element), `<Outlet />` becomes `{children}`, and the component signature
  gains `{ children }`.
- A root that **needs the client** (a hook, an `onClick`, a loader for the
  current user) goes through the same split as a route:
  `layout.client.tsx` + `layout.data.ts` + a `layout.tsx` wrapper calling
  `RemixLayout` with id `root`. Its `<Outlet />` keeps working through
  `OutletProvider`.

`entry.server.*` and `entry.client.*` are deleted; denext provides both
entries. After the routes are written, every remaining `.ts` / `.tsx` / `.js` /
`.jsx` file under `app/` (sessions, utils, shared components) has its
`@remix-run/*` and `react-router` imports remapped too, and the report counts
how many files that touched.

---

## 5. The import map

Specifiers are remapped mechanically, in route modules and across the rest of
`app/`. Only the module path changes; the named exports keep their Remix
names.

| Remix specifier                                                                            | denext module         | Notes                                                                                                                |
| ------------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@remix-run/react`                                                                         | `denext/remix`        | hooks, `Link`, `NavLink`, `Form`, `Outlet`, `Await`, the document components (rendered as nothing)                   |
| `@remix-run/node`, `@remix-run/cloudflare`, `@remix-run/deno`, `@remix-run/server-runtime` | `denext/remix/server` | `json`, `redirect`, `replace`, `redirectDocument`, `data`, `defer`, cookies, session storage, multipart form parsing |
| `@remix-run/css-bundle`                                                                    | `denext/remix/server` | `cssBundleHref` is `undefined`; denext builds CSS itself                                                             |
| `react-router`, `react-router-dom`                                                         | `denext/remix`        | covers React Router v7 framework-mode apps                                                                           |

`deno.json` also aliases `react`, `react-dom`, and `react-is` to denext, exactly
as in [README-NEXT-MIGRATION.md](./README-NEXT-MIGRATION.md) §3, so your own
`import { useState } from "react"` and your npm React libraries resolve to the
single denext React.

---

## 6. What carries over

- **Loaders and actions** run on the server with the request, the params, and
  the Remix helpers they already use. `json`, `redirect`, `replace`, `data`,
  and a thrown `Response` behave as in Remix; response cookies set by a thrown
  redirect are forwarded.
- **`<Form>` and `useSubmit`** are backed by denext Server Actions. A mutating
  `<Form>` with no explicit `action` binds to the current route's action;
  submitting sets `useNavigation()` to `submitting`, stores the result for
  `useActionData`, and triggers a revalidation that carries the form method and
  action into `shouldRevalidate`. `method="get"` is a soft search navigation.
  The DOM `action` attribute is the Server Action's endpoint URL, so the form
  still posts without JavaScript. `reloadDocument` opts out.
- **Data and navigation hooks**: `useLoaderData`, `useActionData`,
  `useRouteLoaderData`, `useMatches`, `useParams`, `useLocation`,
  `useNavigate`, `useSearchParams`, `useHref`, `useResolvedPath`,
  `useFormAction`, `useNavigation`, `useRevalidator`, `useFetcher` (same-route
  action, cross-route `load` and `submit`, following a redirecting action),
  `useFetchers`, and `useBlocker`.
- **Sessions and cookies**: `createCookie`, `isCookie`,
  `createCookieSessionStorage`, `createMemorySessionStorage`,
  `createSessionStorage`, `createSession`, `isSession`, and
  `unstable_parseMultipartFormData` with the memory upload handler, from
  `denext/remix/server`.
- **`defer` and `<Await>`**: a `defer()` promise leaves a placeholder so the
  shell flushes immediately with the `<Await>` fallback; the content streams in
  as its Suspense boundary resolves, and the resolved value is written into the
  tail Flight payload so hydration sees real data. A rejection drives
  `errorElement` through `useAsyncError`.
- **Nested routes and layouts**: `<Outlet />` in a layout renders the nested
  subtree, `<Outlet context>` / `useOutletContext` work, and an ancestor's
  loader data is readable from a nested route through `useMatches` and
  `useRouteLoaderData`, including during the Flight serialization pass.
- **`ErrorBoundary`** maps to `error.tsx` with `useRouteError` and
  `isRouteErrorResponse`; **`meta`** to `generateMetadata`.

---

## 7. The review warnings

The transform is assisted, not silent. Everything it cannot map one-to-one is
reported, never guessed at. The notes you can see, and what to do about each:

| Note                                                     | Meaning                                                                                               | What to do                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pathless "_auth" → route group "(auth)"`                | A pathless layout became a route group; the URL is unchanged.                                         | Informational. Confirm the group's `layout.tsx` is what you expect.                        |
| `layout break-out "dashboard_" (trailing _) flattened`   | denext has no direct equivalent of opting a segment out of its parent layout; the name was flattened. | Check the nesting: the route now renders inside the parent layout.                         |
| `v1 CatchBoundary → error.tsx (via useCatch)`            | The route only has a v1 `CatchBoundary`; it is wired and still renders.                               | Migrate it to a v2 `ErrorBoundary` with `isRouteErrorResponse` when convenient.            |
| `v1 CatchBoundary alongside ErrorBoundary`               | Both exist; only `ErrorBoundary` is wired to `error.tsx`.                                             | Fold the `CatchBoundary` cases into `ErrorBoundary` using `isRouteErrorResponse`.          |
| `layout renders no <Outlet/> — nested routes won't show` | A route became a layout (others nest under it) but its component has no `<Outlet />`.                 | Add `<Outlet />`, or restructure so the route is not a layout.                             |
| `resource route (no component) → generated a route.ts`   | A loader/action-only module became an API route.                                                      | Informational. Verify its method(s) and the response shape.                                |
| `root: meta/links exports — ported via generateMetadata` | The root's `meta` is bridged; `links` has no direct denext equivalent in `generateMetadata`.          | Look at the rendered `<head>`; move stylesheet or preload links into the layout if needed. |
| `rewrote @remix-run/* imports in N shared module(s)`     | Non-route files under `app/` were rewritten to the runtime specifiers.                                | Informational. Diff them once.                                                             |

The CLI prints up to twelve notes and a count of the rest.

---

## 8. Known limitations

> This is the migration-focused summary. The full statement lives in
> [KNOWN-LIMITATIONS.md → "Migration: Remix runs on the `denext/remix` runtime"](./KNOWN-LIMITATIONS.md#migration-remix-runs-on-the-denextremix-runtime).

- **`shouldRevalidate` is honored, and always-revalidate is the default.** On a
  client revalidation (a soft navigation or `useRevalidator`), the client echoes
  each route's prior loader data and params with the request (in headers, or a
  POST body when the echo is too large for headers). When a route's
  `shouldRevalidate` returns `false` the server skips that loader's work and
  renders from the echoed data. First paint, hard navigations, routes without
  `shouldRevalidate`, and an explicit `true` always run the loader, so nothing
  is ever stale.
- **Deferred data is whole at the end.** The `<Await>` content streams
  progressively and first paint is not blocked, but the Flight payload
  (`#__denext_flight`) is emitted once all boundaries resolve. A soft
  navigation to a deferred route therefore carries the resolved value rather
  than re-streaming the chunk.
- **`useBlocker` guards in-app navigations and browser back/forward, not a
  hard unload.** A registered blocker vetoes `<Link>`, `useNavigate`, and
  `<Form>` navigations and undoes a popstate until `proceed()`; one active
  blocker, matching react-router. A reload or tab close is still the browser's
  own `beforeunload` prompt; add one where you need it.
- **`links` has no automatic port.** A route's `links` export is moved into
  the data module and kept, but only `meta` is bridged into
  `generateMetadata`; stylesheet and preload links need a home in the layout.
- **`headers` and `handle` are carried, not interpreted as Remix does.**
  `handle` is threaded to `useMatches`; a `headers` export is preserved in the
  data module for you to apply through denext's `headers()` or middleware.
- **Prisma is auto-migrated to the Rust-free Deno client.** The schema
  generator becomes the ESM `prisma-client` with `queryCompiler` and
  `driverAdapters`, every `@prisma/client` import is repointed, the adapter is
  injected at each `new PrismaClient()`, and `deno.json` gets the `links` shim,
  npm pins, and a `prisma:setup` task. Run `deno task prisma:setup` once. Only
  runtime source under `app/` / `src/` / `lib/` is rewritten (a `prisma/seed.ts`
  is left for Node), a `new PrismaClient(<non-object>)` is flagged for a
  one-line manual adapter add, and non-SQLite datasources need their own driver
  adapter.
- **Everything that is not Remix-specific** (the default Content-Security-Policy
  and response headers, uncached `fetch()` by default, class components in npm
  libraries, native addons) is exactly as documented in
  [README-NEXT-MIGRATION.md](./README-NEXT-MIGRATION.md) §5, §7, and §8.

---

## 9. How this differs from the Next path

| Aspect             | Next.js path                                                                                                          | Remix path                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| What migrate does  | **Config only by default.** Writes `deno.json` + `denext.config.ts`; source is untouched unless you pass `--codemod`. | **Config + a route-tree transform.** Rewrites `app/` in place; routes are relocated and split.       |
| File conventions   | Already denext's own (App Router).                                                                                    | `app/routes/*` + `root.tsx` are converted to `app/**/page.tsx` + `layout.tsx`.                       |
| Data model         | Server Components and Server Actions, as written.                                                                     | Loaders and actions, preserved and run by the `denext/remix` runtime.                                |
| Framework imports  | `next/*` aliased in the import map; optional `--codemod` rewrites them to `denext`.                                   | `@remix-run/*` and `react-router` rewritten in the source to `denext/remix` / `denext/remix/server`. |
| Old toolchain deps | Inert toolchain, lint, and `@types/*` deps are dropped from the pins.                                                 | The same, plus `@remix-run/*` / `@react-router/*`.                                                   |
| Report             | Files written, deps classified.                                                                                       | Plus routes converted, loaders and actions wired, entries removed, and review notes (§7).            |
| Re-running         | Idempotent (generated files carry a sentinel).                                                                        | Config is idempotent; the route transform runs once, on a tree that still has `app/routes/`.         |

Both paths share the `deno.json` shape, the npm passthrough, the compat build
for real npm React libraries, and the Prisma wiring.

---

## 10. Suggested migration order

1. **Commit**, then check the install shape: a real `node_modules` (no Yarn
   PnP), and `--node-modules-dir=none` on the migrate command (§1).
2. **Probe non-Remix dependencies** with the probes in
   [README-NEXT-MIGRATION.md](./README-NEXT-MIGRATION.md) §1 so you know your
   blockers before touching code.
3. **Run `denext migrate --from remix`** (§3) and read the review notes (§7).
4. **Diff `app/`.** Skim one converted route of each kind (a page with a loader,
   one with an action, a layout, the root) so the three-file split is familiar.
5. **`deno task dev`**, then walk the app: navigation, a form submit, a fetcher,
   a deferred route, an error boundary.
6. **Address the notes**: break-outs, `CatchBoundary`, root `links`, layouts
   without an `<Outlet />`.
7. **Build and serve** with `deno task build` then `deno task start`, and test
   the no-JavaScript form path once.
8. Write **new** routes the denext way (a Server Component in `page.tsx`)
   alongside the migrated ones; there is no need to convert the old ones.

Contributions and issues welcome. See the main [README](./README.md).
