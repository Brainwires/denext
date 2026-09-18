---
title: Databases
slug: database
lead: Any database that runs on Deno runs on denext — node:sqlite and Deno KV are built in and zero-npm, and Drizzle and Prisma are verified recipes.
---

denext is "just Deno," so **any database that runs on Deno runs on denext** —
you open a connection in a server-only module and use it from Server Components
and Server Actions. There is no denext-specific database API to learn. This
guide covers the batteries-included options and is honest about what is and
isn't tested.

## TL;DR

| Option               | Setup                          | npm?        | Tested with denext                 | Best for                          |
| -------------------- | ------------------------------ | ----------- | ---------------------------------- | --------------------------------- |
| **`node:sqlite`**    | built into Deno                | **none**    | ✅ (via the better-sqlite3 compat) | single-instance apps, the default |
| **Deno KV**          | built into Deno                | **none**    | ⚠️ not in denext CI                | edge/serverless, simple KV data   |
| **Postgres / MySQL** | a Deno or `npm:` driver        | driver only | ⚠️ not in denext CI                | multi-instance / large apps       |
| **Drizzle ORM**      | `better-sqlite3` shim → compat | ORM only    | ✅ full app + e2e                  | typed SQL over SQLite             |
| **Prisma**           | driver adapter + `links` shim  | ORM only    | ✅ verified recipe (Rust-free)     | typed models + migrations         |

## SQLite via `node:sqlite` (recommended default, zero-npm)

Deno ships a built-in `node:sqlite` (`DatabaseSync`) — a real, file-backed SQL
database with **no dependency to install**. Open it once as a module singleton
and call it from the server:

```ts
// lib/db.ts  — a server-only module
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(Deno.env.get("DB_PATH") ?? "app.db");
db.exec(
  `CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT)`,
);

export function listNotes(): { id: number; title: string }[] {
  return db.prepare("SELECT id, title FROM notes ORDER BY id DESC")
    .all() as never;
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

Run with read/write permission (`deno task dev` already uses `-A`). Writes
belong in Server Actions (`"use server"`), so forms work with no client JS. See
[`examples/notes`](https://github.com/Brainwires/denext/tree/main/examples/notes)
for a complete app (auth + CRUD + ISR) built this way. `node:sqlite` is a
**single-process** database — ideal for one container or VM; for multiple
instances, use Postgres or Deno KV.

## Deno KV (zero-npm, distributed)

Deno's built-in KV store needs no setup and works across instances (and on Deno
Deploy). It's a solid app data store for key/value-shaped data:

```ts
const kv = await Deno.openKv();
await kv.set(["notes", crypto.randomUUID()], { title: "hi" });
const notes = [];
for await (const e of kv.list({ prefix: ["notes"] })) notes.push(e.value);
```

Run with `--unstable-kv` (add it to your `deno task` definitions; the framework
itself does not need it).

## Postgres / MySQL (multi-instance)

For a horizontally-scaled app, use a networked database via a Deno-native or
`npm:` driver — all of which run on Deno:

```ts
import postgres from "npm:postgres"; // or "jsr:@db/postgres", "npm:mysql2"
const sql = postgres(Deno.env.get("DATABASE_URL")!);
export const getUsers = () => sql`SELECT id, email FROM users`;
```

Keep the pool a module singleton. These drivers are **not part of denext's CI**
— they're standard Deno usage, but validate your driver + pooling under your
load.
[`examples/postgres-load`](https://github.com/Brainwires/denext/tree/main/examples/postgres-load)
does exactly that: a real Postgres pool (`jsr:@db/postgres`, zero npm) driven by
a load harness that fires thousands of concurrent requests and reports
throughput + latency percentiles — demonstrating that with a bounded pool,
concurrency above the pool size **queues** for a free connection instead of
exhausting the database. (Verified locally: 5,000 requests at concurrency 100
over a 10-connection pool, 0 errors.)

## ORMs

Both ORMs below run over denext's
[`better-sqlite3` compat](https://github.com/Brainwires/denext/blob/main/src/compat/better-sqlite3.ts)
— a drop-in for the `better-sqlite3` API backed by Deno's built-in
`node:sqlite`, so there is **no native addon** to compile and **no query
engine** to download. The catch is resolution: each ORM does an
npm-package-**internal** `import "better-sqlite3"`, and Deno resolves those
through `node_modules`, **not** your `deno.json` import map — so an import-map
alias can't reach it. You install the compat _as_ `better-sqlite3` instead. The
two ORMs need slightly different mechanisms because of how they depend on it.

### Drizzle (verified — full app + e2e)

Drizzle declares `better-sqlite3` as an optional peer dependency, so a top-level
`file:` package satisfies it. Add a tiny shim package that re-exports the compat
and point `better-sqlite3` at it via `package.json`:

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
`drizzle-orm/better-sqlite3` driver talks to the compat unchanged. A complete
app — Server-Component reads + a Server-Action write, no client JS — is in
[`examples/drizzle`](https://github.com/Brainwires/denext/tree/main/examples/drizzle),
covered end to end by `tests/e2e/drizzle.e2e.test.ts`. Drizzle's
`postgres`/`mysql2` drivers work as plain Deno usage (networked-driver caveat
above).

### Prisma (verified recipe — Rust-free, over `node:sqlite`)

Prisma works too, via its **driver-adapter** path
(`@prisma/adapter-better-sqlite3`) with the Rust-free query compiler (the
default in current Prisma). The adapter depends _hard_ on `better-sqlite3`, so a
top-level `file:` package won't override it — use Deno's
[`links`](https://docs.deno.com/runtime/fundamentals/modules/#overriding-dependencies)
field to substitute the compat for that nested dependency, and ship the compat
as a **bundled** `.mjs` (an npm-internal import of the compat's `.ts` fails with
"Loading unprepared module"; bundling it — it only imports the `node:sqlite`
builtin — makes it self-contained):

```jsonc
// deno.json
{
  "nodeModulesDir": "manual",
  "links": ["./patch/better-sqlite3"]
}
```

```prisma
// prisma/schema.prisma — the ESM, Deno-runtime generator. `queryCompiler` +
// `driverAdapters` select the Rust-free query compiler (no native engine binary);
// without them the generator emits the library engine, which needs a native `.node`
// binary and rejects `{ adapter }` under Deno ("driverAdapters preview not enabled").
generator client {
  provider        = "prisma-client"
  output          = "../generated/client"
  runtime         = "deno"
  moduleFormat    = "esm"
  previewFeatures = ["queryCompiler", "driverAdapters"]
}
datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}
```

> **`denext migrate` does all of this for you.** Migrating a Next.js or Remix
> app that uses Prisma auto-wires the whole path — it rewrites the schema
> generator to the block above, repoints every `@prisma/client` import at the
> generated Deno client, injects the driver adapter at each
> `new PrismaClient()`, writes the `deno.json` `links` + npm pins + a
> `prisma:setup` task, and drops the superseded `@prisma/client` /`prisma` from
> `package.json`. Then just run `deno task prisma:setup` once. The manual steps
> below are what that automation encodes.

Steps: bundle the compat into the `links` package, install, generate, push, then
use the adapter:

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

const prisma = new PrismaClient({
  adapter: new PrismaBetterSQLite3({ url: "file:./dev.db" }),
});
export const listNotes = () => prisma.note.findMany();
```

The `links` package's `package.json` `version` must satisfy the adapter's
`better-sqlite3` range — `^11.9.0` for `@prisma/adapter-better-sqlite3@6.x`,
`^12.6.0` for `7.x`. The **same** compat serves both majors; only the declared
version differs. A complete app wired up this way — Server-Component read +
Server-Action write, plus a `scripts/setup.ts` that runs the whole bundle →
install → generate → push flow — is in
[`examples/prisma`](https://github.com/Brainwires/denext/tree/main/examples/prisma),
with an opt-in end-to-end test (`tests/e2e/prisma.e2e.test.ts`). This path is
verified working (`create`/`findMany`/`update`/`count` all round-trip); the
compat surface Prisma drives — `bind()`, `reader`, `columns()`, `safeIntegers()`
— is covered by `tests/better-sqlite3.test.ts`. Because it requires codegen (the
`prisma` CLI) + a manual `node_modules`, the e2e is opt-in rather than in denext
CI. Prisma's `postgres` adapter works as plain networked-driver usage.

## Migrations & seeding

denext ships no migration tool and does not need one: a migration is server code
that runs before the app takes traffic, and the framework already has a place
for server code you run on demand — a [task](/docs/tasks) — and a place for a
project-local CLI verb — `commands` in `denext.config.ts`. The three recipes
below are ordered by how much machinery they bring; the first one is verified
here and is enough for most SQLite apps.

### Plain SQL files on `node:sqlite` (verified)

`migrations/NNN_name.sql`, applied in filename order, each inside a transaction,
each recorded once in a `_migrations` table. The runner is a task, so it is
`denext task migrate` from a shell or a deploy step and `runTask("migrate")`
from app code:

```ts
// tasks/migrate.ts — apply migrations/NNN_name.sql in order, once each, on node:sqlite.
import { DatabaseSync } from "node:sqlite";
import { defineTask } from "denext/server";

const DB_PATH = Deno.env.get("DB_PATH") ?? "app.db";
const DIR = new URL("../migrations/", import.meta.url);

export default defineTask({
  description: "apply pending migrations/*.sql",
  handler: () => {
    const db = new DatabaseSync(DB_PATH);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`);
      const applied = new Set(
        (db.prepare("SELECT name FROM _migrations").all() as { name: string }[])
          .map((r) => r.name),
      );
      const files = [...Deno.readDirSync(DIR)]
        .filter((e) => e.isFile && /^\d+_.*\.sql$/.test(e.name))
        .map((e) => e.name)
        .sort(); // zero-padded NNN_ prefixes sort lexically
      const pending = files.filter((f) => !applied.has(f));
      const record = db.prepare(
        "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
      );
      for (const file of pending) {
        const sql = Deno.readTextFileSync(new URL(file, DIR));
        db.exec("BEGIN");
        try {
          db.exec(sql);
          record.run(file, Date.now());
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw new Error(
            `migration ${file} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      return `applied ${pending.length} migration(s): ${pending.join(", ") || "none"}`;
    } finally {
      db.close();
    }
  },
});
```

```sql
-- migrations/001_notes.sql
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

```sh
denext task migrate          # applied 2 migration(s): 001_notes.sql, 002_notes_body.sql
denext task migrate          # applied 0 migration(s): none
denext task --list           # migrate  —  apply pending migrations/*.sql
```

Verified against this runner: a second run is a no-op, a file with a syntax
error is rolled back as a unit (the tables it created before the bad statement
are gone) and the run exits `1`, and the task's returned line lands in the run
history when `tasks: { history: true }` is on. Use it from a deploy step
(`deno run -A jsr:@denext/denext@^2/cli task migrate` before `start`), a
Kubernetes init container or a `preStart` hook — and keep the schema step out of
the app's boot so a bad migration fails the deploy, not the first request. The
runner needs `--allow-read` on `migrations/` and `--allow-write` on the
database's directory, which the scaffold's `-A` tasks already grant. Down
migrations are deliberately absent: write a new forward file.

### Drizzle: `drizzle-kit generate` + `migrate()` (verified)

Drizzle's migrator and its CLI both run under Deno against the `better-sqlite3`
compat, through the same `file:` shim
[the Drizzle section](#drizzle-verified--full-app--e2e) wires. Verified with
`drizzle-kit@0.31.10` / `drizzle-orm@0.44.7` on Deno 2.9.6 (`npm:drizzle-kit`
added to `package.json`, `deno install`):

`deno run -A npm:drizzle-kit generate` diffs `lib/schema.ts` against the last
snapshot and writes `drizzle/0000_….sql` + `drizzle/meta/` — pure codegen, no
database. `migrate()` from `drizzle-orm/better-sqlite3/migrator` then applies
the folder at boot or from a task, recording in `__drizzle_migrations`:

```ts
// tasks/migrate.ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { defineTask } from "denext/server";

export default defineTask({
  description: "apply drizzle/ migrations",
  handler: () => {
    const sqlite = new Database(Deno.env.get("DB_PATH") ?? "app.db");
    try {
      migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
    } finally {
      sqlite.close();
    }
  },
});
```

`deno run -A npm:drizzle-kit migrate` and `deno run -A npm:drizzle-kit push`
also work: with no `@libsql/client` installed the kit takes its `better-sqlite3`
branch, which resolves to the shim, so both talk to `node:sqlite`. `push` is the
prototyping shortcut (schema → database, no files); `generate` + `migrate` is
the deployable one.

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "./app.db" },
});
```

### Prisma: `db push` (verified) vs `migrate deploy`

`examples/prisma` runs `deno run -A npm:prisma@^6.7.0 db push --skip-generate`
in its setup script, so **`db push`** — schema straight to the database, no
migration files — is the verified path over the driver adapter.
**`prisma migrate
dev` / `migrate deploy`** use the same CLI and the same schema
engine, so they are expected to work the same way, but they are **not exercised
in denext's CI**; treat a first run as something to check on a copy of the
database. Either way the command runs the Prisma CLI, not your app, so it
belongs in the deploy step, not in a task (the generated client is what the app
imports).

### Seeding

A seed is server code you run once, on demand — the same two homes:

```ts
// denext.config.ts — `denext seed` becomes a verb of this project
import type { DenextConfig } from "denext/server";

export default {
  commands: [{
    name: "seed",
    summary: "Load fixtures into the database",
    flags: [{ name: "reset", type: "boolean", help: "truncate first" }],
    run: async (ctx) => {
      const { seed } = await import("./lib/seed.ts");
      await seed({ reset: ctx.flags.reset === true });
    },
  }],
} satisfies DenextConfig;
```

`denext seed --reset` gets the same flag parsing, `--help` and did-you-mean as a
built-in verb; `denext commands` lists it. A task (`tasks/seed.ts`,
`denext task
seed --payload '{"reset":true}'`) is the other home, and the right
one when app code should be able to call it (`runTask("seed")` from a test
setup, say). Keep seeds **idempotent** — `INSERT OR IGNORE`, or a check on an
empty table as `examples/drizzle` does at boot — so a second run on a shared
database is harmless.

### Deno Deploy

Deploy has no persistent local disk, so a SQLite file — and the `_migrations`
table in it — does not survive an isolate. Migrate a **hosted** database from
your deploy pipeline (`denext task migrate` in the workflow, against the
production DSN) rather than from the running app; the same applies to any
platform whose containers start from a clean image without a mounted volume. See
[Deployment targets](/docs/deployment-targets).

## Where to put database code

- Put the connection and queries in a **server-only module** (imported by Server
  Components / route handlers / `"use server"` actions) — never from a
  `"use
  client"` component.
- Open the connection **once** at module scope; don't reopen per request.
- Do **mutations in Server Actions** so forms degrade gracefully without
  JavaScript.
- Run migrations from a startup `db.exec(...)` (as in `examples/notes`) for a
  schema that only ever grows, or from a task once it needs ordering and a
  record of what ran — see [Migrations & seeding](#migrations--seeding). denext
  doesn't prescribe a migration tool.
