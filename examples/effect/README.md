# denext migrate — Effect (Next app) fixture

An **actual Next.js App Router app** that depends on
[Effect](https://effect.website), used as the golden fixture for
`denext migrate`'s Effect support.

The source is a normal Next app — `react`/`next`/`effect` imports, a
`next.config.mjs`, and a `tsconfig.json` with a `@/*` path alias. It never
imports `@denext/effect`; the bridge is wired by the migration, not the app
source.

## What migrate generates (the golden files)

Running `denext migrate` here produces the committed denext config files:

- `deno.json` — react/next aliased to denext, `effect` pinned as an npm
  passthrough, `@denext/effect` mapped (because the app depends on `effect`),
  and the `@/` path alias translated from `tsconfig.json`.
- `denext.config.ts` — `compatibilityMode: true`, `trailingSlash: true`
  (translated from `next.config.mjs`), and `plugins: [effect()]` — the
  `@denext/effect` bridge wired in because `effect` is a dependency.
- `.gitignore` / `.vscode/*` — build-artifact ignores + the Deno LSP toggle.

These files are **generated**, and `tests/migrate-effect-fixture.test.ts`
enforces that `denext migrate` reproduces them exactly: it copies this fixture,
deletes the generated files, re-runs the migration, and asserts the output is
byte-for-byte identical.

## Regenerating

The golden files use published-JSR specifiers so they are machine-independent.
To refresh them (e.g. after the denext version bumps), from the repo root:

```sh
deno run -A cli.ts migrate examples/effect
```

For a **locally runnable** copy (against this checkout, not published JSR),
migrate a copy with `--denext-local-path`:

```sh
deno run -A cli.ts migrate <copy> --denext-local-path .
```

## Files

- `package.json` / `next.config.mjs` / `tsconfig.json` — the Next app config
  (migrate input).
- `services.ts` — a `Users` Effect service + `AppLayer` (plain Effect, no
  denext).
- `app/page.tsx` — a Server Component running an Effect via `Effect.runPromise`.
- `deno.json` / `denext.config.ts` / `.gitignore` / `.vscode/` — **generated**
  by migrate.
