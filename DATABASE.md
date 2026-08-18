# Databases with denext

denext is "just Deno," so **any database that runs on Deno runs on denext** — you
open a connection in a server-only module and use it from Server Components and
Server Actions. There is no denext-specific database API to learn. This guide
covers the batteries-included options and is honest about what is and isn't tested.

## TL;DR

| Option               | Setup                           | npm?        | Tested with denext                 | Best for                          |
| -------------------- | ------------------------------- | ----------- | ---------------------------------- | --------------------------------- |
| **`node:sqlite`**    | built into Deno                 | **none**    | ✅ (via the better-sqlite3 compat) | single-instance apps, the default |
| **Deno KV**          | built into Deno                 | **none**    | ✅ (also the cache store)          | edge/serverless, simple KV data   |
| **Postgres / MySQL** | a Deno or `npm:` driver         | driver only | ⚠️ not in denext CI                | multi-instance / large apps       |
| **Drizzle ORM**      | alias `better-sqlite3` → compat | ORM only    | ⚠️ surface tested, full app not    | typed SQL over SQLite             |
| **Prisma**           | —                               | —           | ❌ **untested — unsupported**      | —                                 |

## SQLite via `node:sqlite` (recommended default, zero-npm)

Deno ships a built-in `node:sqlite` (`DatabaseSync`) — a real, file-backed SQL
database with **no dependency to install**. Open it once as a module singleton and
call it from the server:

```ts
// lib/db.ts  — a server-only module
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? "app.db");
db.exec(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT)`);

export function listNotes(): { id: number; title: string }[] {
  return db.prepare("SELECT id, title FROM notes ORDER BY id DESC").all() as never;
}
export function addNote(title: string): void {
  db.prepare("INSERT INTO notes (title) VALUES (?)").run(title);
}
```

```tsx
// app/page.tsx — an async Server Component reads it directly
import { listNotes } from "../lib/db.ts";
export default function Page() {
  return <ul>{listNotes().map((n) => <li key={n.id}>{n.title}</li>)}</ul>;
}
```

Run with read/write permission (`deno task dev` already uses `-A`). Writes belong
in Server Actions (`"use server"`), so forms work with no client JS. See
[`examples/notes`](./examples/notes) for a complete app (auth + CRUD + ISR) built
this way. `node:sqlite` is a **single-process** database — ideal for one container
or VM; for multiple instances, use Postgres or Deno KV.

## Deno KV (zero-npm, distributed)

Deno's built-in KV store needs no setup and works across instances (and on Deno
Deploy). denext already uses it as an optional [cache store](./DEPLOYMENT.md); it's
equally good as an app data store for key/value-shaped data:

```ts
const kv = await Deno.openKv();
await kv.set(["notes", crypto.randomUUID()], { title: "hi" });
const notes = [];
for await (const e of kv.list({ prefix: ["notes"] })) notes.push(e.value);
```

Run with `--unstable-kv` (the denext tasks already pass it).

## Postgres / MySQL (multi-instance)

For a horizontally-scaled app, use a networked database via a Deno-native or `npm:`
driver — all of which run on Deno:

```ts
import postgres from "npm:postgres"; // or "jsr:@db/postgres", "npm:mysql2"
const sql = postgres(Deno.env.get("DATABASE_URL")!);
export const getUsers = () => sql`SELECT id, email FROM users`;
```

Keep the pool a module singleton. These drivers are **not part of denext's CI** —
they're standard Deno usage, but validate your driver + pooling under your load.

## ORMs

- **Drizzle** — Drizzle's `better-sqlite3` driver targets the same surface denext's
  [`better-sqlite3` compat](./src/compat/better-sqlite3.ts) implements over
  `node:sqlite`. Alias it in your import map:

  ```jsonc
  "imports": { "better-sqlite3": "jsr:@denext/denext/better-sqlite3" }
  ```

  The compat's CRUD / prepared-statement / transaction surface **is tested**
  (`tests/better-sqlite3.test.ts`); a full Drizzle application is **not** part of
  denext's CI, so verify it against your schema before relying on it. Drizzle's
  `postgres`/`mysql2` drivers work as plain Deno usage (same caveat as above).

- **Prisma** — **untested and unsupported with denext.** Recent Prisma versions can
  run on Deno, but we have **not** verified Prisma end-to-end with denext. Do not
  assume it works; if you need Prisma, validate it yourself against a real schema
  first and treat any success as your own finding, not a denext guarantee.

## Where to put database code

- Put the connection and queries in a **server-only module** (imported by Server
  Components / route handlers / `"use server"` actions) — never from a `"use
  client"` component.
- Open the connection **once** at module scope; don't reopen per request.
- Do **mutations in Server Actions** so forms degrade gracefully without JavaScript.
- Run migrations from a startup `db.exec(...)` (as in `examples/notes`) or a
  separate `deno run` script — denext doesn't prescribe a migration tool.
