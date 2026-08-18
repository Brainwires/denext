# Writing denext apps (for AI coding agents)

**denext is Next.js's App Router, reimplemented for Deno with its own small React.**
If you know Next.js, you already know denext — the file conventions, hooks, and
`app/` router are the same. This file lists ONLY what differs, so you emit correct
denext instead of Next.js.

## The 6 rules that make code denext, not Next

1. **Imports come from `denext`, not `react`.** `import { useState } from "denext"`.
   Server-only helpers come from `denext/server`; client-only from `denext/client`.
   There is **no `react` or `react-dom` package** — do not import them (in a _compat_
   drop-in, `react` is aliased to denext, but new code should import `denext`).
2. **No `package.json`, no `npm install`.** A denext project has a **`deno.json`**.
   Dependencies are URL/`jsr:`/`npm:` imports in `deno.json`'s `imports` map. Run it
   with `deno task dev` / `deno task build` / `deno task start`.
3. **File conventions are identical to Next App Router:** `app/page.tsx`,
   `app/layout.tsx`, `app/loading.tsx`, `app/error.tsx`, `app/not-found.tsx`,
   `app/api/x/route.ts`, `app/blog/[slug]/page.tsx`, `middleware.ts`. Server
   Components by default; add `"use client"` at the top of a file for interactivity.
4. **Async Server Components work** (`export default async function Page() { const d =
   await db.query(); ... }`). Data fetching stays on the server.
5. **`next/*` still works in a drop-in** (aliased), but for NEW code prefer the denext
   equivalents (see the map). `cookies()`, `headers()`, `redirect()`, etc. come from
   **`denext/server`** / the `denext/navigation` compat, not `next/*`.
6. **Everything is a web standard.** `Request`/`Response`, `fetch`, `URL`,
   `crypto.subtle`, `Deno.env.get(...)`. Route handlers return a `Response`.

## Next.js → denext import map

| Next.js                                                | denext                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `import { useState, useEffect, ... } from "react"`     | `from "denext"`                                            |
| `import { cookies, headers } from "next/headers"`      | `import { cookies, headers } from "denext/server"`         |
| `import { redirect, notFound } from "next/navigation"` | `from "denext/server"` (server) / `denext/client` (client) |
| `import Link from "next/link"`                         | `import { Link } from "denext"` (or `denext/client`)       |
| `import Image from "next/image"`                       | `import { Image } from "denext"`                           |
| `unstable_cache`, `revalidatePath`, `revalidateTag`    | `from "denext/server"`                                     |
| Route handler `export async function GET(req) {}`      | identical — returns a `Response`                           |

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

**Reading cookies / a session (auth):**

```ts
import { cookies, getSession } from "denext/server";
// cookies are Secure + httpOnly + SameSite=Lax by DEFAULT; pass { httpOnly: false } to opt out.
const session = await getSession<{ userId: string }>({ secret: Deno.env.get("SESSION_SECRET")! });
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
const res = await client.submit(client.form((await client.get("/login")).text), {
  email,
  password,
});
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

**Config:** `denext.config.ts` exports `{ ... }` (redirects, rewrites, headers, i18n,
images, `plugins`, `experimental`). Not `next.config.js`.

## What's different to keep in mind

- **Pages Router** is not built in — it's the opt-in `@denext/pages-router` plugin
  (`plugins: [pagesRouter()]` in `denext.config.ts`).
- **Cache Components / PPR** are behind `experimental: { cacheComponents: true }`.
- **Zero runtime npm**: the framework itself pulls no npm; your app may still use
  `npm:`/`jsr:` libraries.
- Run checks with `deno task check` (fmt + lint + type-check + tests).

When unsure, write it the Next.js App Router way and change only the imports per the
map above — that is almost always correct denext.
