# Databases with denext

denext is "just Deno," so **any database that runs on Deno runs on denext** — you
open a connection in a server-only module and use it from Server Components and
Server Actions. There is no denext-specific database API to learn. This guide
covers the batteries-included options and is honest about what is and isn't tested.

## TL;DR

| Option               | Setup                          | npm?        | Tested with denext                 | Best for                          |
| -------------------- | ------------------------------ | ----------- | ---------------------------------- | --------------------------------- |
| **`node:sqlite`**    | built into Deno                | **none**    | ✅ (via the better-sqlite3 compat) | single-instance apps, the default |
| **Deno KV**          | built into Deno                | **none**    | ✅ (also the cache store)          | edge/serverless, simple KV data   |
| **Postgres / MySQL** | a Deno or `npm:` driver        | driver only | ⚠️ not in denext CI                | multi-instance / large apps       |
| **Drizzle ORM**      | `better-sqlite3` shim → compat | ORM only    | ✅ full app + e2e                  | typed SQL over SQLite             |
| **Prisma**           | driver adapter + `links` shim  | ORM only    | ✅ verified recipe (Rust-free)     | typed models + migrations         |

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
[`examples/postgres-load`](./examples/postgres-load) does exactly that: a real
Postgres pool (`jsr:@db/postgres`, zero npm) driven by a load harness that fires
thousands of concurrent requests and reports throughput + latency percentiles —
demonstrating that with a bounded pool, concurrency above the pool size **queues**
for a free connection instead of exhausting the database. (Verified locally: 5,000
requests at concurrency 100 over a 10-connection pool, 0 errors.)

## ORMs

Both ORMs below run over denext's [`better-sqlite3` compat](./src/compat/better-sqlite3.ts)
— a drop-in for the `better-sqlite3` API backed by Deno's built-in `node:sqlite`, so
there is **no native addon** to compile and **no query engine** to download. The
catch is resolution: each ORM does an npm-package-**internal** `import "better-sqlite3"`,
and Deno resolves those through `node_modules`, **not** your `deno.json` import map —
so an import-map alias can't reach it. You install the compat _as_ `better-sqlite3`
instead. The two ORMs need slightly different mechanisms because of how they depend on
it.

### Drizzle (verified — full app + e2e)

Drizzle declares `better-sqlite3` as an optional peer dependency, so a top-level
`file:` package satisfies it. Add a tiny shim package that re-exports the compat and
point `better-sqlite3` at it via `package.json`:

```jsonc
// package.json
{
  "dependencies": {
    "drizzle-orm": "^0.44.7",
    "better-sqlite3": "file:./vendor/better-sqlite3"
  }
}
```

```js
// vendor/better-sqlite3/index.mjs   (+ a package.json: name "better-sqlite3")
// Re-export the compat. A `file:` shim is part of the project graph, so a relative
// import of the compat's .ts resolves (see examples/drizzle for the exact path).
export { Database, default } from "../../path/to/denext/src/compat/better-sqlite3.ts";
```

With `"nodeModulesDir": "manual"` in `deno.json` and `deno install`, Drizzle's
`drizzle-orm/better-sqlite3` driver talks to the compat unchanged. A complete app —
Server-Component reads + a Server-Action write, no client JS — is in
[`examples/drizzle`](./examples/drizzle), covered end to end by
`tests/e2e/drizzle.e2e.test.ts`. Drizzle's `postgres`/`mysql2` drivers work as plain
Deno usage (networked-driver caveat above).

### Prisma (verified recipe — Rust-free, over `node:sqlite`)

Prisma works too, via its **driver-adapter** path (`@prisma/adapter-better-sqlite3`)
with the Rust-free query compiler (the default in current Prisma). The adapter
depends _hard_ on `better-sqlite3`, so a top-level `file:` package won't override it —
use Deno's [`links`](https://docs.deno.com/runtime/fundamentals/modules/#overriding-dependencies)
field to substitute the compat for that nested dependency, and ship the compat as a
**bundled** `.mjs` (an npm-internal import of the compat's `.ts` fails with "Loading
unprepared module"; bundling it — it only imports the `node:sqlite` builtin — makes it
self-contained):

```jsonc
// deno.json
{
  "nodeModulesDir": "manual",
  "links": ["./patch/better-sqlite3"]
}
```

```prisma
// prisma/schema.prisma — the ESM, Deno-runtime generator (no Rust engine)
generator client {
  provider     = "prisma-client"
  output       = "../generated/client"
  runtime      = "deno"
  moduleFormat = "esm"
}
datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}
```

Steps: bundle the compat into the `links` package, install, generate, push, then use
the adapter:

```sh
deno run -A npm:esbuild better-sqlite3.ts --bundle --format=esm --platform=node \
  --external:node:sqlite --outfile=patch/better-sqlite3/index.mjs
deno install                       # applies the link
deno run -A npm:prisma generate    # generates ./generated/client
deno run -A npm:prisma db push     # creates the schema
```

```ts
import { PrismaBetterSQLite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/client/client.ts";

const prisma = new PrismaClient({ adapter: new PrismaBetterSQLite3({ url: "file:./dev.db" }) });
export const listNotes = () => prisma.note.findMany();
```

The `links` package's `package.json` `version` must satisfy the adapter's
`better-sqlite3` range — `^11.9.0` for `@prisma/adapter-better-sqlite3@6.x`,
`^12.6.0` for `7.x`. The **same** compat serves both majors; only the declared
version differs. This path is verified working (`create`/`findMany`/`update`/`count`
all round-trip); the compat surface Prisma drives — `bind()`, `reader`, `columns()`,
`safeIntegers()` — is covered by `tests/better-sqlite3.test.ts`. Because it requires
codegen (the `prisma` CLI) + a manual `node_modules`, it isn't run in denext CI; the
recipe above is the reproducible path. Prisma's `postgres` adapter works as plain
networked-driver usage.

## Where to put database code

- Put the connection and queries in a **server-only module** (imported by Server
  Components / route handlers / `"use server"` actions) — never from a `"use
  client"` component.
- Open the connection **once** at module scope; don't reopen per request.
- Do **mutations in Server Actions** so forms degrade gracefully without JavaScript.
- Run migrations from a startup `db.exec(...)` (as in `examples/notes`) or a
  separate `deno run` script — denext doesn't prescribe a migration tool.
