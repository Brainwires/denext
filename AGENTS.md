# Writing denext apps (for AI coding agents)

**denext is Next.js's App Router, reimplemented for Deno with its own small
React.** If you know Next.js, you already know denext — the file conventions,
hooks, and `app/` router are the same. This file lists ONLY what differs, so you
emit correct denext instead of Next.js.

## The 6 rules that make code denext, not Next

1. **Imports come from `denext`, not `react`.**
   `import { useState } from "denext"`. Server-only helpers come from
   `denext/server`; client-only from `denext/client`. There is **no `react` or
   `react-dom` package** — do not import them (in a _compat_ drop-in, `react` is
   aliased to denext, but new code should import `denext`).
2. **No `package.json`, no `npm install`.** A denext project has a
   **`deno.json`**. Dependencies are URL/`jsr:`/`npm:` imports in `deno.json`'s
   `imports` map. Run it with `deno task dev` / `deno task build` /
   `deno task start`. Migrating a Next app? `denext migrate` does it in one pass
   — writes the `deno.json` alias map so `next/*`+`react` resolve to denext with
   your source unchanged (add `--codemod` to rewrite imports to native `denext`). A **`pages/` (Pages
   Router) app** is migrated too: migrate wires the `@denext/pages-router`
   plugin (`denext.config.ts` + `deno.json`) and rewrites
   `next/router`/`next/head`/`next/link` to the plugin's compat modules.
3. **File conventions are the same as Next App Router:** `app/page.tsx`,
   `app/layout.tsx`, `app/loading.tsx`, `app/error.tsx`, `app/not-found.tsx`,
   `app/api/x/route.ts`, `app/blog/[slug]/page.tsx`, `middleware.ts`. Server
   Components by default; add `"use client"` at the top of a file for
   interactivity.
4. **Async Server Components work**
   (`export default async function Page() { const d =
   await db.query(); ... }`).
   Data fetching stays on the server.
5. **`next/*` still works in a drop-in** (aliased), but for NEW code prefer the
   denext equivalents (see the map). `cookies()`, `headers()`, `redirect()`,
   etc. come from **`denext/server`** (or the `denext/next/*` compat — e.g.
   `denext/next/navigation`, `denext/next/headers`), not `next/*`.
6. **Everything is a web standard.** `Request`/`Response`, `fetch`, `URL`,
   `crypto.subtle`, `Deno.env.get(...)`. Route handlers return a `Response`.

## Next.js → denext import map

| Next.js                                                | denext                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import { useState, useEffect, ... } from "react"`     | `from "denext"`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `import { cookies, headers } from "next/headers"`      | `import { cookies, headers } from "denext/server"`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `import { redirect, notFound } from "next/navigation"` | `from "denext"` — `redirect`, `permanentRedirect`, `notFound`, `forbidden`, `unauthorized`, `RedirectType` work in Server and Client Components alike (`denext migrate` rewrites `next/navigation` to `denext`). `denext/server` re-exports the same throwing helpers; its **middleware** helper that RETURNS a `Response` is `redirectResponse` (`return redirectResponse("/login", 307)` from `middleware.ts`; `redirect` there is a deprecated alias of it) |
| `import Link from "next/link"`                         | `import { Link } from "denext"` (or `denext/client`)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `import Image from "next/image"`                       | `import { Image } from "denext"`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unstable_cache`, `revalidatePath`, `revalidateTag`    | `from "denext/server"`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Route handler `export async function GET(req) {}`      | identical — returns a `Response`                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Common tasks

**A page with data (Server Component):**

```tsx
// app/page.tsx
export default async function Home() {
  const posts = await getPosts();
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
```

**An interactive component:**

```tsx
// app/counter.tsx
"use client";
import { useState } from "denext";
export function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
```

**A route handler (API):**

```ts
// app/api/hello/route.ts
export function GET(_req: Request): Response {
  return Response.json({ ok: true });
}
```

**A validated route handler + calling it with end-to-end types (no tRPC):** `defineApi`
takes Standard Schemas (Zod/Valibot/ArkType/TypeBox/hand-rolled) for `params` / `query` /
`body` / `response` plus the `errors` it may fail with; the handler gets parsed, typed input
and a schema mismatch is a structured 400 before it runs. `denext dev`/`build` generate
`.denext/api.ts` from the route modules' TYPES and register it, so `createApiClient()` and
`useApi` type-check every call — path, method, params, query, body, response, error codes.

```ts
// app/api/user/[id]/route.ts
import { createApi, defineApi, requireSession } from "denext/server";
import { z } from "zod";
export const GET = defineApi({
  params: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), name: z.string() }), // strips undeclared keys, in prod too
  errors: { not_found: 404 },
}, async ({ params, fail }) => (await db.users.get(params.id)) ?? fail("not_found"));
export const PATCH = createApi().use(requireSession()).define({
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string().min(1) }),
  errors: { not_owner: 403 },
}, async ({ params, body, ctx, fail }) => {
  if (ctx.session.user.id !== params.id) fail("not_owner");
  return db.users.update(params.id, body);
});
```

```ts
// anywhere (server component, client component, or a test)
import { createApiClient, isApiClientError } from "denext";
import type {} from "./.denext/api.ts"; // registers the schema (type-only; nothing ships)
const api = createApiClient(); // typed against THIS app's routes
const user = await api("/api/user/[id]", "GET", { params: { id: "1" } }); // user is typed
try {
  await api("/api/user/[id]", "PATCH", { params: { id: "1" }, body: { name: "" } });
} catch (err) {
  if (isApiClientError(err) && err.code === "not_owner") { /* narrowed to the declared codes */ }
}
```

```tsx
// a client component — the hook; GETs in one tick ride ONE batched request
"use client";
import { useApi } from "denext";
export function User({ id }: { id: string }) {
  const { data, error, pending } = useApi("/api/user/[id]", "GET", { params: { id } });
  return pending ? <p>…</p> : error ? <p>{error.code}</p> : <p>{data?.name}</p>;
}
```

Add the `@denext/openapi` plugin (`plugins: [openapi()]` in `denext.config.ts`) and those same
definitions serve `GET /openapi.json` (OpenAPI 3.1) + a docs page at `GET /docs`, write
`openapi.json` at build, and back `denext openapi emit | diff | lint` — zero extra annotation.
Schemas that implement Standard JSON Schema (Zod ≥ 4.2, ArkType, Valibot) or TypeBox are
described in full; others are `{}` + a lint warning.
Need GraphQL? `@denext/graphql` mounts GraphQL Yoga at `/graphql` (any `GraphQLSchema`;
Pothos recommended, no decorators) and `fromChannel(channel, key)` turns a `createChannel`
into a subscription source — the same push the Live socket delivers.

A plain handler still works and is still typed: return `TypedResponse<T>` / take a
`TypedRequest<B>` from `denext/server`. A plain `route.ts` body is capped at 1 MiB
(`export const maxBodyBytes = N | false`); `redirect()`/`notFound()` inside one are HTTP
responses; a thrown `ApiError(status, code, { data })` is a typed JSON error envelope.

**Typed live data (validated subscription + server push):**

```ts
// app/live.ts
"use server";
import { createChannel, defineSubscription } from "denext/server";
export const orderStatus = defineSubscription({
  input: z.object({ id: z.string() }), // validated on every subscribe
  tags: ({ id }) => [`order:${id}`], // server-derived; re-pushed on revalidateTag
  authorize: async ({ id }) => (await auth())?.user.id === (await db.orders.owner(id)),
  resolve: ({ id }) => db.orders.status(id),
});
export const orderEvents = createChannel<{ status: string }>({
  authorize: async (_ctx, key) => key === `user:${(await auth())?.user.id}`, // REQUIRED
});
// anywhere on the server: await orderEvents.publish(`user:${userId}`, { status: "shipped" });
```

```tsx
"use client";
import { useChannel, useSubscription } from "denext/live";
import { orderEvents, orderStatus } from "./live.ts";
const { data } = useSubscription(orderStatus, { id }, { initial });
const { data: event } = useChannel(orderEvents, `user:${userId}`);
```

**A typed Server Action (the mutation side, also type-checked):** `defineAction` validates
`FormData` into a typed input (a parser, or a Zod/Valibot/any Standard Schema) and its `Out`
flows into `useActionState`.

```ts
// app/actions.ts
"use server";
import { ActionValidationError, defineAction } from "denext/server";
export const createPost = defineAction({
  input: (f) => ({ title: String(f.title ?? "").trim() }), // typed input: { title: string }
  handler: async ({ title }) => {
    if (!title) throw new ActionValidationError("bad", { title: "Title is required" });
    return { id: await db.posts.insert({ title }) }; // Out inferred: { id: string }
  },
});
```

```tsx
// app/new-post.tsx
"use client";
import { idleActionState, useActionState } from "denext";
import { createPost } from "./actions.ts";
export function NewPost() {
  const [state, action] = useActionState(createPost, idleActionState<{ id: string }>());
  return (
    <form action={action}>
      <input name="title" />
      {!state.ok && state.fieldErrors?.title} {/* typed */}
      {state.ok && `created ${state.data.id}`} {/* typed */}
    </form>
  );
}
```

**Reading cookies / a session (auth):**

```ts
import { cookies, getSession } from "denext/server";
// cookies are Secure + httpOnly + SameSite=Lax by DEFAULT; pass { httpOnly: false } to opt out.
const session = await getSession<{ userId: string }>({
  secret: Deno.env.get("SESSION_SECRET")!,
});
if (!session.data) redirect("/login");
await session.set({ userId: user.id }); // sign in
```

**A database (zero-npm, server-only module):**

```ts
// lib/db.ts — Deno's built-in SQLite; no install. See DATABASE.md for KV/Postgres.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? "app.db");
export const listNotes = () => db.prepare("SELECT * FROM notes").all();
```

Open the connection once at module scope; do writes in Server Actions.

**A scheduled / background task (cron):** put it in `tasks/<name>.ts`; schedule it in
`denext.config.ts` (`scheduledTasks`) or per-task; run it on demand with `runTask(name)`
or `denext task <name>`. Uses `Deno.cron` where available (Deno Deploy), else a userland
tick — no npm cron dependency. **Cron expressions are evaluated in UTC** (matching `Deno.cron`),
and a schedule never fires on startup nor overlaps a still-running instance of the same task.

```ts
// tasks/cleanup.ts
import { defineTask } from "denext/server";
export default defineTask({
  description: "purge expired sessions",
  schedule: "0 3 * * *", // optional; or list it in config.scheduledTasks
  handler: async ({ payload }) => {
    await db.exec("DELETE FROM sessions WHERE expires_at < now()");
  },
});
// denext.config.ts → scheduledTasks: { "0 0 * * 1": ["digest", "warm-cache"] }
// anywhere on the server: import { runTask } from "denext/server"; await runTask("cleanup");
```

**A content collection (typed MD/MDX/YAML/JSON — the `@denext/content-collections` plugin):** add
`plugins: [contentCollections()]` to `denext.config.ts`, declare collections in `content.config.ts`
with a Standard Schema + a loader, then query them typed from a Server Component. The plugin
validates entries and generates types — live in `denext dev`, and at `denext build`.

```ts
// content.config.ts
import { defineCollection, defineContentConfig, glob } from "@denext/content-collections/config";
import { z } from "zod";
export default defineContentConfig({
  collections: {
    blog: defineCollection({
      loader: glob({ pattern: "**/*.md", base: "content/blog" }),
      schema: z.object({ title: z.string(), date: z.string(), draft: z.boolean().default(false) }),
    }),
  },
});
```

```tsx
// app/page.tsx — server-only query, typed to the schema
import "../.denext/content.ts"; // registers the collection types (generated)
import { getCollection } from "@denext/content-collections/runtime";
export default async function Blog() {
  const posts = await getCollection("blog", (p) => !p.data.draft); // p.data is typed
  return <ul>{posts.map((p) => <li key={p.id}>{p.data.title}</li>)}</ul>;
}
// Render an entry's body: `<Content entry={post} />` (or `await renderContent(post)`) from the
// same module — `.md` through the first-party renderer, `.mdx` through a module compiled at build.
// CLI: `denext content build | list | validate` (validate exits 1 on a schema failure — a CI gate).
```

**A compile-time feature flag (dead-code-eliminated):** `feature("KEY")` from `denext/feature`
folds to a boolean literal at build time for any KEY in `experimental.features` — denext's
`feature()` (cf. Bun's `bun:bundle`). `feature()` always returns the configured value; the untaken
branch is dead-code eliminated where it folds (native App Router component modules, SPA, dev), and
read at runtime on the compat drop-in App Router path. Keep the argument a string literal; a key
not listed reads `false`. Flag names/states are embedded in the client bundle (don't encode secrets).

```tsx
import { feature } from "denext/feature";
export function Checkout() {
  return feature("NEW_CHECKOUT") ? <NewCheckout /> : <LegacyCheckout />;
}
// denext.config.ts → experimental: { features: { NEW_CHECKOUT: false } }
```

**Inspect / shrink the client bundle:** `denext analyze` breaks the bundle down by chunk + role;
`denext analyze --md` writes a markdown report (per-module on the esbuild path) to pipe into CI.
Imports of one export from a `"sideEffects": false` dep (lucide-react, Radix) are tree-shaken
automatically on the esbuild path.

**Testing an app (no browser, JS-disabled path):**

```ts
import { createTestApp, createTestClient } from "denext/testing";
const client = createTestClient(await createTestApp("./"));
const res = await client.submit(
  client.form((await client.get("/login")).text),
  {
    email,
    password,
  },
);
// res.status, client.cookies — a cookie jar persists the session across requests.
```

**Testing a component (hooks/effects/events, no browser):**

```ts
import { fireEvent, render } from "denext/testing";
import { h } from "denext/jsx-runtime";
const screen = await render(h(Counter, null)); // async — await it
await screen.fireEvent.click(screen.getByRole("button"));
// getByRole/getByText/getByLabelText/getByTestId; fireEvent.change wires to onChange.
```

**Conformance-probing every route (CI gate):**

```ts
import { formatReport, probeApp } from "denext/testing";
const report = await probeApp("./"); // renders every route, asserts valid HTML docs
if (!report.ok) throw new Error(formatReport(report)); // or run `denext doctor`
```

**Config:** `denext.config.ts` exports `{ ... }` (redirects, rewrites, headers,
i18n, images, `cacheComponents`, `streaming`, `live`, `plugins`, `experimental`,
`tailwind`, `csp`, `compatibilityMode`;
`mode: "spa"` + `spa: { entry, … }` for SPA mode). Not `next.config.js`.

**Writing a plugin:** a `DenextPlugin` (`{ name, setup(ctx) }` from
`denext/plugin-kit`, the semver-stable toolkit) hooks six seams — `addRouteSynthesizer` (add/adjust routes),
`addRequestHandler` (claim unmatched requests), `addBuildStep` (emit assets),
`addPrepareStep` (codegen the app imports — runs at build AND dev startup, and re-runs on
`watch`-glob changes in dev), `addTeardown` (dispose on drain), and `addCommand` (contribute a
CLI verb). Declare it as `plugins: [myPlugin()]`. See
[PLUGINS.md](./PLUGINS.md) and
[`examples/plugin-aliases`](./examples/plugin-aliases).

## What's different to keep in mind

- **Pages Router** is not built in — it's the opt-in `@denext/pages-router`
  plugin (`plugins: [pagesRouter()]` in `denext.config.ts`).
- **Cache Components / PPR** are a stable **opt-in**: `cacheComponents: true`
  (top-level) in `denext.config.ts`. Not `experimental.cacheComponents` — that
  legacy key still works but dev-warns.
- **Zero runtime npm**: nothing the framework ships to the runtime pulls npm
  (CI-enforced). The build-time toolchain still uses a few npm tools — `esbuild`
  (core) plus opt-in `sass` / `@mdx-js/mdx` / `ws`; the CSS + swc-AST tooling is
  the first-party `@denext/lightningcss` / `@denext/swc` wasm. Your app may still
  use `npm:`/`jsr:` libraries.
- Run checks with `deno task check` (fmt `--check` + lint + tests; type-checking
  happens transitively via `deno test`, there's no separate type-check step).
  `deno task
  check:fix` auto-fixes formatting + fixable lint, then reports the
  rest. The `denext/*` lint rules (rules-of-hooks, hooks-in-component,
  no-hooks-in-async, directive-placement) are **correctness** rules with **no
  auto-fix** — resolve them by hand; [CONTRIBUTING.md](./CONTRIBUTING.md) says
  how.

When unsure, write it the Next.js App Router way and change only the imports per
the map above — that is almost always correct denext.

## Tooling for AI agents (MCP + llms.txt)

denext ships tooling so agents get it right the first time:

- **MCP server** — `deno run -A jsr:@denext/denext/cli mcp` (or `denext mcp`). It speaks
  MCP over stdio; configure it as an MCP server in your client. Tools:
  `denext_check_snippet` (lint a code string for Next-isms before you write it),
  `denext_import_map` (map a Next/React import to denext), `denext_generate` (scaffold),
  `denext_doctor`, `denext_codemod`, `denext_list_routes` (an app's pages + API routes),
  `denext_dev_logs` (the RUNNING dev server's recent events — server errors, server +
  browser console, completed requests, and HMR — so you can see what actually happened at
  runtime), `denext_render` (render a route or component server-side, no browser, and get
  the HTML/error — SEE what your edit produces), `denext_route_map` (the full render
  tree at a path: layouts, boundaries, server/client split), `denext_profile` (build
  unminified, serve, and profile a route in headless Chromium — CPU self-time by
  function + heap growth + a leak check; pass `interact` to profile a re-render, `budget`
  to gate a regression), `denext_search_docs` (BM25
  over the denext docs), and the codebase tools `denext_index_codebase` /
  `denext_query_codebase` / `denext_find_definition` / `denext_find_references`.
  `denext mcp --disable rag,docs` hides tool groups or individual tools to trim an
  agent's context. Resources: `denext://guide`, `denext://import-map`.
- **`llms.txt`** — [denext.dev/llms.txt](https://denext.dev/llms.txt) (concise) and
  [llms-full.txt](https://denext.dev/llms-full.txt) (this guide + an API summary).

---

## Releasing: `main` always equals the published release

All work lands on `development`, and releases are cut there with
`deno task release <version>` (which tags `v<version>` and pushes). Active
`development` runs ahead of `main` by design.

**`main` must always be exactly what is published.** So **cutting a version is not
done until `development` is merged into `main`** — the release flow is: tag
`v<version>` → verify the JSR publish succeeded → open a `development → main` PR
(`gh pr create --base main --head development`, same flow as PRs #5–#11) → **merge
it** (`gh pr merge <n> --merge`). "Cut a version" _implies_ this merge; do it as part
of the release, not as a separate maintainer step. A tag without `main` merged to it
is an incomplete release. The PR may batch several rc tags since the previous merge;
that's fine.

---

## Before committing: measured coverage first

Run `deno task coverage:fallow` before `git commit` whenever `coverage/coverage-final.json`
is missing (it is git-ignored, so a fresh clone or a disk sweep removes it) or when your change
touches a function with cyclomatic complexity ≥ 10. The fallow gate below scores CRAP with that
measured map; without it fallow estimates coverage from the import graph and can block a commit
on internals that tests reach only transitively (the fiber reconciler, the request pipeline).
The task runs the unit suite (~10 min) and needs no other setup. See
[CONTRIBUTING.md](./CONTRIBUTING.md) → _The Fallow gate_.

<!-- fallow:setup-hooks:start -->

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent` (add `--coverage coverage/coverage-final.json` when that file exists — `deno task coverage:fallow` generates it, and it turns fallow's estimated CRAP coverage into measured coverage; see CONTRIBUTING.md). If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking.

Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. Inherited findings on touched files are reported under `attribution` and annotated with `introduced: false`, but do not block the commit. Set `[audit] gate = "all"` in `fallow.toml` to gate every finding in changed files.

For non-skill agents, treat the task map below as the local onboarding source: run the listed fallow command before destructive edits, before commits, and before pull request handoff.

## Fallow task map

| When the agent is about to...                                     | Run                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| delete an "unused" export or file                                 | `fallow dead-code --trace <file>:<export>`                                           |
| prove a TypeScript symbol's exact consumers before refactoring    | `fallow dead-code --type-aware --symbol-impact <file>:<export-or-class.method>`      |
| delete an "unused" dependency                                     | `fallow dead-code --trace-dependency <name>`                                         |
| commit or open a PR                                               | `fallow audit --base <ref>`                                                          |
| prioritize refactoring                                            | `fallow health --hotspots --targets`                                                 |
| ask who owns code                                                 | `fallow health --ownership`                                                          |
| check untested-but-reachable code                                 | `fallow health --coverage-gaps`                                                      |
| consolidate duplication                                           | `fallow dupes --trace dup:<fingerprint>`                                             |
| find feature flags                                                | `fallow flags`                                                                       |
| check which architecture rules apply to a file before changing it | `fallow guard <files>`                                                               |
| surface security candidates                                       | `fallow security`                                                                    |
| understand a finding                                              | `fallow explain <issue-type>`                                                        |
| scope a monorepo                                                  | `--workspace <glob> / --changed-workspaces <ref>` (global flags, prefix any command) |

<!-- fallow:setup-hooks:end -->
