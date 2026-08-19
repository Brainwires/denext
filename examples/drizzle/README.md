# Drizzle ORM on denext

Typed SQL with [Drizzle ORM](https://orm.drizzle.team) over Deno's built-in
`node:sqlite` — **no native addon, no query engine**. Drizzle's `better-sqlite3`
driver talks to denext's [`better-sqlite3` compat](../../src/compat/better-sqlite3.ts),
which implements that API on top of `node:sqlite`.

The app is a tiny notes list: a Server Component runs the Drizzle query and renders
the rows, and a native `<form>` posts a Server Action that inserts through the same
Drizzle handle — the whole read/write path is server-only typed SQL, and the form
works with **no client JavaScript**.

## Run it

```sh
deno task install   # deno install — resolves drizzle-orm + the better-sqlite3 shim
deno task dev        # http://localhost:3000   (or: deno task build && deno task start)
```

By default it uses an in-memory database (seeded on boot). Set `DB_PATH` to persist:

```sh
DB_PATH=notes.db deno task start
```

## How the `better-sqlite3` resolution works

Drizzle's driver does an npm-package-**internal** `import "better-sqlite3"`. Deno
resolves that through `node_modules`, **not** the `deno.json` import map — so aliasing
`better-sqlite3` in the import map does **not** reach it. Instead this example installs
the compat _as_ the `better-sqlite3` package:

- [`vendor/better-sqlite3/`](./vendor/better-sqlite3) is a tiny package that re-exports
  the compat (`index.mjs` + a `package.json` naming it `better-sqlite3`).
- [`package.json`](./package.json) points `better-sqlite3` at it via `file:`, which
  satisfies Drizzle's optional peer dependency.
- [`deno.json`](./deno.json) sets `"nodeModulesDir": "manual"` (required for a `file:`
  dependency) and maps `drizzle-orm` for the app's own imports.

So there's still zero native code: the "package" is just a re-export of the
`node:sqlite`-backed compat. See [`DATABASE.md`](../../DATABASE.md) for the Postgres
and Prisma variants.

## Files

- [`lib/schema.ts`](./lib/schema.ts) — the Drizzle table definition.
- [`lib/db.ts`](./lib/db.ts) — opens SQLite once, wires Drizzle, exposes typed queries.
- [`app/page.tsx`](./app/page.tsx) — Server Component: runs the query, renders rows + the form.
- [`app/actions.ts`](./app/actions.ts) — `"use server"` insert.
