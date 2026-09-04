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
   — writes the `deno.json` and rewrites `next/*`+`react` imports to native
   `denext` (`--drop-in` to keep the compat alias instead). A **`pages/` (Pages
   Router) app** is migrated too: migrate wires the `@denext/pages-router`
   plugin (`denext.config.ts` + `deno.json`) and rewrites
   `next/router`/`next/head`/`next/link` to the plugin's compat modules.
3. **File conventions are identical to Next App Router:** `app/page.tsx`,
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

| Next.js                                                | denext                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `import { useState, useEffect, ... } from "react"`     | `from "denext"`                                                                                                                                                                                                                                                                                                                                                       |
| `import { cookies, headers } from "next/headers"`      | `import { cookies, headers } from "denext/server"`                                                                                                                                                                                                                                                                                                                    |
| `import { redirect, notFound } from "next/navigation"` | `from "denext"` — `redirect`, `permanentRedirect`, `notFound`, `forbidden`, `unauthorized`, `RedirectType` work in Server and Client Components alike (`denext migrate` rewrites `next/navigation` to `denext`). NOT `denext/server`: its `redirect()` is the **middleware** helper that RETURNS a `Response` (`return redirect("/login", 307)` from `middleware.ts`) |
| `import Link from "next/link"`                         | `import { Link } from "denext"` (or `denext/client`)                                                                                                                                                                                                                                                                                                                  |
| `import Image from "next/image"`                       | `import { Image } from "denext"`                                                                                                                                                                                                                                                                                                                                      |
| `unstable_cache`, `revalidatePath`, `revalidateTag`    | `from "denext/server"`                                                                                                                                                                                                                                                                                                                                                |
| Route handler `export async function GET(req) {}`      | identical — returns a `Response`                                                                                                                                                                                                                                                                                                                                      |

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

**A typed route handler + calling it with end-to-end types (no tRPC):** return
`TypedResponse<T>` (and take a `TypedRequest<B>`) from `denext/server` so
`denext dev`/`build` can generate `.denext/api.ts`; then `createApiClient` type-checks
every call to your own API — a wrong path/method/param/body is a compile error.

```ts
// app/api/user/[id]/route.ts
import { json, type TypedRequest, type TypedResponse } from "denext/server";
export function GET(): TypedResponse<{ id: string; name: string }> {
  return json({ id: "1", name: "Ada" }); // json() === Response.json() at runtime
}
export async function POST(
  req: TypedRequest<{ name: string }>,
): Promise<TypedResponse<{ ok: true }>> {
  await req.json(); // typed as { name: string }
  return json({ ok: true }, { status: 201 });
}
```

```ts
// anywhere (server component, client component, or a test)
import { createApiClient } from "denext";
import type { ApiSchema } from "./.denext/api.ts";
const api = createApiClient<ApiSchema>();
const user = await api("/api/user/[id]", "GET", { params: { id: "1" } }); // user is typed
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
i18n, images, `plugins`, `experimental`, `tailwind`, `csp`, `compatibilityMode`;
`mode: "spa"` + `spa: { entry, … }` for SPA mode). Not `next.config.js`.

**Writing a plugin:** a `DenextPlugin` (`{ name, setup(ctx) }` from
`denext/server`) hooks five seams — `addRouteSynthesizer` (add/adjust routes),
`addRequestHandler` (claim unmatched requests), `addBuildStep` (emit assets),
`addTeardown` (dispose on drain), and `addCommand` (contribute a CLI verb). Declare
it as `plugins: [myPlugin()]`. See
[PLUGINS.md](./PLUGINS.md) and
[`examples/plugin-aliases`](./examples/plugin-aliases).

## What's different to keep in mind

- **Pages Router** is not built in — it's the opt-in `@denext/pages-router`
  plugin (`plugins: [pagesRouter()]` in `denext.config.ts`).
- **Cache Components / PPR** are behind
  `experimental: { cacheComponents: true }`.
- **Zero runtime npm**: the framework itself pulls no npm; your app may still
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
  the HTML/error — SEE what your edit produces), and `denext_route_map` (the full render
  tree at a path: layouts, boundaries, server/client split). Resources: `denext://guide`,
  `denext://import-map`.
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
