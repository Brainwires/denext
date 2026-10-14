# Upgrading to denext 4.0

denext 4.0 changes what runs your code (denext's own Deno toolchain), renames background and
scheduled **tasks** to **jobs** end to end, gives `denext task` Deno's meaning, and moves every
first-party plugin to a new release. Most of a 3.x app needs no change; this page is the checklist
for the parts that do. Every change is also listed, with the details, in the
[changelog](/docs/changelog).

## 1. Move the pins

`denext upgrade` moves the `jsr:@denext/denext` pin, the CLI tasks that run it and every
first-party `@denext/*` plugin together, to the newest versions that work with each other:

```sh
denext upgrade --dry-run   # print the plan, write nothing
denext upgrade             # write deno.json (and every workspace member's)
```

While 4.0 is in release candidates, name the version: `denext upgrade --to 4.0.0-rc.N`. A
package that imports no denext (the `@denext/swc`, `@denext/lightningcss`, `@denext/photon`,
`@denext/avif` and `@denext/og` codecs) stays within its caret range unless you add
`--allow-major`. In CI, `denext upgrade --check` exits 1 while anything is out of date.

The plugins' releases built for 3.x don't work with 4.0. These are the first that do:

| Package                       | 3.x release | 4.0 release |
| ----------------------------- | ----------- | ----------- |
| `@denext/backend`             | 0.2         | 0.3         |
| `@denext/content-collections` | 0.4         | 0.5         |
| `@denext/effect`              | 0.1         | 0.2         |
| `@denext/graphql`             | 0.2         | 0.3         |
| `@denext/htmx`                | 2.0         | 2.1         |
| `@denext/openapi`             | 0.3         | 0.4         |
| `@denext/pages-router`        | 0.11        | 0.12        |
| `@denext/react-router`        | 0.2         | 0.3         |

## 2. Tasks are now jobs

Background and scheduled work is called a job everywhere, with no aliases. A config that still
sets `tasks` or `scheduledTasks` **fails to load**, and the error names the new key.

| 3.x                                                                  | 4.0                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `tasks/<name>.ts`                                                    | `jobs/<name>.ts`                                              |
| `defineTask`, `runTask`                                              | `defineJob`, `runJob`                                         |
| `registerTask`, `getTask`, `isTask`, `taskNames`                     | `registerJob`, `getJob`, `isJob`, `jobNames`                  |
| types `Task`, `TaskContext`, `TaskDefinition`, `TaskRetry`, …        | `Job`, `JobContext`, `JobDefinition`, `JobRetry`, …           |
| `sqliteTaskHistoryStore`, `postgresTaskHistoryStore`                 | `sqliteJobHistoryStore`, `postgresJobHistoryStore`            |
| config `scheduledTasks`                                              | `scheduledJobs`                                               |
| config `tasks: { history, historyMaxRuns }`                          | `jobs: { history, historyMaxRuns }`                           |
| `denext task <name>`, `--list`, `--history`, `--clear-history`       | `denext job <name>`, `--list`, `--history`, `--clear-history` |
| `denext task --list --json` → `tasks`                                | `denext job --list --json` → `jobs`                           |
| `denext generate task`                                               | `denext generate job`                                         |
| `tasks/migrate.ts`, `tasks/seed.ts` (from `generate migration/seed`) | `jobs/migrate.ts`, `jobs/seed.ts`                             |
| `.denext/tasks.db`, a run's `task` field                             | `.denext/jobs.db`, `job`                                      |
| Postgres history: `task_runs` (column `task`)                        | `job_runs` (column `job`)                                     |

```sh
git mv tasks jobs
# then rename the imports and config keys above; `deno check` finds the rest
```

**Run history.** The history is not migrated: the 4.0 store starts empty in `.denext/jobs.db`
(or `job_runs`). To keep it, rename before the first 4.0 run:

```sh
# SQLite (the default store)
mv .denext/tasks.db .denext/jobs.db
sqlite3 .denext/jobs.db 'ALTER TABLE runs RENAME COLUMN task TO job'
```

```sql
-- postgresJobHistoryStore (add your schema prefix if you set `schema`)
ALTER TABLE task_runs RENAME TO job_runs;
ALTER TABLE job_runs RENAME COLUMN task TO job;
```

A `jobs/migrate.ts` written by an older denext applied SQLite migration files whole; run
`denext generate migration <name>` once to replace it (the job loader refuses to run the old one
while any migration has a `-- migrate:down` section). See [Scheduled jobs](/docs/jobs).

## 3. The CLI

- **Project code runs on denext's Deno toolchain.** `dev`, `build`, `export`, `start`, `test`,
  `check`, `job`, `doctor`, `analyze`, `profile`, the desktop and mobile build verbs and your
  project's own verbs re-run themselves on the pinned `2.9.7-denext.N` build (Deno 2.9.7 plus
  `Deno.SQL` and Vitest/Jest compatibility in `deno test`), downloaded and SHA-256-verified on
  first need. The `deno` on your PATH is never replaced. `DENEXT_DENO=stock` opts out; a launcher
  without `--allow-run` (the least-privilege `start` task) or a first run with no network stays on
  stock Deno. See [denext's Deno toolchain](/docs/toolchain).
- **`denext task <name>` is `deno task`** on the toolchain, every argument verbatim, and every
  `deno` inside the task is the toolchain too. Your background work is `denext job <name>`.
- **Every Deno verb works through `denext`.** A verb denext doesn't define is forwarded
  (`denext compile …`, `denext run …`, `denext bench …`), and `denext main.ts` is `deno run`. A
  project verb that shadows a Deno verb prints one notice; `denext deno <verb>` always reaches
  Deno's.
- **`denext info <module>` is Deno's `deno info`.** `denext info [dir]` still prints denext's
  environment and project facts; Deno's cache info is `denext deno info`.
- **`denext audit` also runs `deno audit`**, which needs the network and a `deno.lock`. For an
  offline CI step, or a project without a lockfile, pass `--skip-deno-audit`.
- **Forwarded verbs keep `--`.** `denext test a.test.ts -- --seed 1` hands `--seed 1` to the
  script.

## 4. Per-address limits

- `rateLimit()` now follows the app's `trustForwardedHeaders` (`DENEXT_TRUST_PROXY=1`) unless the
  limiter sets its own, so behind a trusted proxy it keys on the last `x-forwarded-for` hop.
- `denextAuth`'s per-IP budgets are skipped for any loopback or private socket peer with no
  trusted forwarded hop. Where those peers are your real clients (a LAN or VPN deployment), set
  `rateLimitLocalAddresses: true`.
- New: `rateLimitHeader` (`DENEXT_RATE_LIMIT_HEADER`) keys every per-address limit on a header
  your proxy writes, such as `cf-connecting-ip`. See [Security](/docs/security).

## 5. Builds: esbuild

denext no longer imports `npm:esbuild`. It runs the esbuild 0.25.5 binary its toolchain ships
(verified by SHA-256), or the official `@esbuild/<platform>` binary under stock Deno.
`ESBUILD_BINARY_PATH` must point at 0.25.5. If your own code imports esbuild, add it to your
`deno.json`. A regular-expression plugin `filter` now honours its flags (`/…/i`).

## 6. `@denext/backend`

Supabase compatibility is opt-in, one option per service: `backend({ supabase })` for the API
keys and `/auth/v1`, `rest` for `/rest/v1`, `storage` for `/storage/v1`, `realtime` for
`/realtime/v1`, `functions` for `/functions/v1`. An app that sets none of them behaves as before,
apart from:

- **`db()` scopes every query with the request's identity** (`resolveIdentity()`). With
  `supabase` keys, a request carrying the secret key runs as `service_role` with no row-level
  security, and a refused credential is a `401` (`IdentityError`).
- **Storage:** `listBuckets` for anon and signed-in callers is an empty list and `getBucket` is
  `Bucket not found` (they were `403`); a bucket's `authorize` receives the request's `identity`;
  a bucket created at runtime, or declared without `authorize`, is decided by
  `storage.authorize`, else open only to the service role.
- **Auto-REST:** `readRestCatalog(sql, schemas, tables)` takes a list of schemas and returns the
  whole catalog; `generateRestTypes(catalog)` takes the catalog alone; the client's `range()`
  sends `offset` / `limit` instead of a `Range` header.
- **`denext db` is a core verb.** The plugin no longer contributes it, so nothing changes in how
  you call it.
- **`denext generate docker`'s Postgres publishes no host port.** The app reaches it as
  `db:5432`; add `--expose-db` for `127.0.0.1:5432`.

See [Backend](/docs/backend) and [Coming from Supabase](/docs/coming-from-supabase).

## 7. Auth

A TOTP secret a 3.x denext kept in the user's MFA record moves into the shared factor store the
first time that user's factors are read, so `denextAuth()` and `/auth/v1` see the same factors.
Nothing to do, but keep a database backup from before the upgrade if you might roll back to 3.x.

## 8. Deno Desktop

denext 4.0 requires Deno Desktop runtime `2.9.7-denext.14` or later and pins a newer one;
`denext desktop run`, `dev` and the package scripts download it. See
[the runtime](/docs/desktop-runtime).
