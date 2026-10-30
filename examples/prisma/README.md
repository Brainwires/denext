# Prisma ORM on denext

[Prisma](https://www.prisma.io) with typed models over Deno's built-in
`node:sqlite` — **Rust-free** (the modern query compiler, no native query
engine) and **no native addon**. Queries run through Prisma's `better-sqlite3`
driver adapter, which talks to denext's
[`better-sqlite3` compat](../../src/compat/better-sqlite3.ts).

The app is a tiny notes list: a Server Component awaits the Prisma query and
renders the rows, and a native `<form>` posts a Server Action that inserts
through the same Prisma client — no client JavaScript.

## Run it

```sh
denext task setup   # one-time: bundle the shim, install, prisma generate + db push
denext task dev      # http://localhost:3000   (or: denext task build && denext task start)
```

`denext task setup` is required first (and again whenever the schema changes).
It's also network + codegen heavy — it installs `@prisma/*` and runs the
`prisma` CLI. The example pins Prisma 7 (`prisma`, `@prisma/client` and
`@prisma/adapter-better-sqlite3` at `7.10.1`); following the
[Prisma 7 upgrade guide](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-to-prisma-7),
the datasource URL lives in `prisma.config.ts`, the adapter class is
`PrismaBetterSqlite3`, and `db push` no longer runs `prisma generate` (setup
runs both).

## Why the extra setup (vs. the Drizzle example)

Prisma's adapter (`@prisma/adapter-better-sqlite3`) depends _hard_ on the real,
native `better-sqlite3`, and it constructs it internally — so a top-level
`file:` shim (as in [`examples/drizzle`](../drizzle)) can't override it. Two
pieces bridge that:

1. **`links`** ([`deno.json`](./deno.json)) substitutes a local package for the
   adapter's nested `better-sqlite3` dependency. Its `package.json` `version`
   (`12.6.2`) satisfies the `^12.6.0` range of
   `@prisma/adapter-better-sqlite3@7.10.1` (Prisma 6's adapter wants `^11.9.0`;
   the same compat serves both majors).
2. A **bundled** shim. The `links` package is loaded as an npm package, and an
   npm-internal import of the compat's `.ts` fails ("Loading unprepared
   module"). So [`scripts/setup.ts`](./scripts/setup.ts) `deno bundle`s the
   compat (it only imports the `node:sqlite` builtin) into
   `patch/better-sqlite3/index.mjs` before installing.

The result is still zero native code — just Deno's built-in `node:sqlite` behind
the Prisma API. See [the database guide](https://denext.dev/docs/database) for the full write-up and
the Drizzle / Postgres variants.

## Files

- [`prisma/schema.prisma`](./prisma/schema.prisma) — models + the ESM/Deno
  generator.
- [`prisma.config.ts`](./prisma.config.ts) — Prisma 7's CLI config: the schema
  path and the datasource URL `prisma db push` writes to.
- [`lib/db.ts`](./lib/db.ts) — the Prisma client wired to the adapter + compat.
- [`app/page.tsx`](./app/page.tsx) — Server Component: awaits the query, renders
  rows + the form.
- [`app/actions.ts`](./app/actions.ts) — `"use server"` insert.
- [`scripts/setup.ts`](./scripts/setup.ts) — bundles the shim + runs
  install/generate/push.

An opt-in end-to-end test lives at `tests/e2e/prisma.e2e.test.ts`
(`denext task test:e2e`).
