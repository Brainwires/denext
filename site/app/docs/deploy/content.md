---
title: Deployment
slug: deploy
lead: denext ships secure, production-minded defaults (graceful drain, request cancellation/timeout, body/cache/prefetch caps, error redaction, correlation ids, opinionated hardening headers, config validation). A few operational responsibilities are yours to configure at the edge/platform — this guide lists them.
---

denext ships secure, production-minded defaults (graceful drain, request
cancellation/timeout, body/cache/prefetch caps, error redaction, correlation
ids, opinionated hardening headers, config validation). A few operational
responsibilities are **yours** to configure at the edge/platform — they are
deliberately not baked into the framework so denext stays a thin, fast core.
This document lists them. See [the security guide](/docs/security) for the
threat-by-threat security posture and [the differences guide](/docs/differences)
for the safe defaults that deliberately differ from Next's.

## 0. Deploy recipes

`denext build` writes a `.denext/` output; `denext start` serves it. Build in
the image/CI, then run `start`.

### Deploy adapters

`denext build` also writes **`.denext/deploy-manifest.json`**, a typed, versioned description of
what it built (the `DeployManifest` type from `denext/deploy` and `denext/plugin-kit`):

- every route and how it is served: `static`, `isr` (with its `revalidate`), `dynamic` (with the
  reason: `force-dynamic`, a request API such as `cookies()`, or a dynamic segment without
  `generateStaticParams`), `route-handler` (with its methods; metadata routes such as
  `sitemap.ts` are marked) and `middleware` (with a literal `matcher`);
- the files served as they are, by directory, with the `Cache-Control` the server sends
  (content-hashed `/_denext/client/` files are immutable; `public/` revalidates);
- the server: its start command, port (`PORT`), health path and drain;
- the jobs under `jobs/` and every schedule (`scheduledJobs` and each job's own), the services
  under `services/`;
- the environment variables the app reads (the detected stack's secrets and every literal
  `Deno.env.get` / `process.env` read; `required` when the stack needs it or the read is
  asserted with `!`);
- the Deno permissions, the image optimizer, the cache store and the `build --compile` output.

The manifest is read from the sources as text, like Next's segment config: a route's
`dynamic` / `revalidate` must be literal exports, and a page that reads request data only through
a helper of its own (not `cookies()` / `headers()` / `auth()` / `searchParams`) is classified by
what its route files say. Version 1 only ever gains fields; a breaking change bumps `version`.

A **deploy adapter** turns the manifest into a target's files. Name one in `denext.config.ts`
(`denext create` maps `denext/deploy`; an older project adds
`"denext/deploy": "jsr:@denext/denext@^4/deploy"` to `deno.json`'s imports):

```ts
// denext.config.ts
import { fly } from "denext/deploy";
export default { deploy: { adapter: fly({ app: "my-app", region: "ams" }) } };
```

```sh
denext build                       # build, write the manifest, run the adapter's prepare
denext deploy prepare              # run prepare again (on the last build's manifest)
denext deploy prepare --preset static --dry-run   # a preset without the config; write nothing
denext deploy                      # prepare, then push with the target's CLI
```

Credentials come **only from the environment** (`FLY_API_TOKEN`, `DENO_DEPLOY_TOKEN`), are never
written to a file or passed on a command line, and nothing is pushed without an explicit
`denext deploy`. A file a preset writes at the project root (`Dockerfile`, `fly.toml`,
`denext.deploy.ts`) carries a generated-file marker: the next prepare replaces it only while the
marker is there, so delete the marker line to keep your edits (`--force` replaces it anyway).
Deno's own `deno deploy` is `denext deno deploy`.

| Preset                          | Writes                                                                                                                                                                                                                                                                                                           | `denext deploy`                                                      | Can't support                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker({ … })`                 | what `denext generate docker` writes (`Dockerfile`, compose file, `.dockerignore`; `stack: true` adds Postgres, storage and migrations)                                                                                                                                                                          | `docker build -t <image>`; `push: true` pushes (your `docker login`) | nothing app-side; persistence is a volume you mount, and replicas are separate nodes ([multi-instance](/docs/multi-instance))                                                                                  |
| `fly({ app, region })`          | the Docker files plus `fly.toml`: `PORT`, `SIGTERM` with a 30 s kill timeout (above the drain), a health check on `/_denext/health`, the required secrets listed; machines stay on when the app has schedules or services                                                                                        | `fly deploy --remote-only` (needs `flyctl` and `FLY_API_TOKEN`)      | a persistent cache across machines and deploys (use a shared `cache.store`); schedules run on every machine, so keep one or use a shared job runner                                                            |
| `denoDeploy({ org, app })`      | `denext.deploy.ts`, the entrypoint: the schedules registered with `Deno.cron` at its top level (where Deno Deploy records crons), the cache on Deno KV when `cache.store` is unset, then the server; `.denext/deploy/deno-deploy/app.json` with the build settings and the one-time `deno deploy create` command | `deno deploy --prod` (needs `DENO_DEPLOY_TOKEN`)                     | a persistent disk (SQLite files, the default job history), `Deno.SQL` (use postgres.js), long-lived `services/` (isolates start and stop on demand), the `build --compile` executable                          |
| `genericHost({ name, domain })` | under `.denext/deploy/generic-host/`: a systemd unit (the compiled executable when there is one, else the least-privilege `start`; `SIGTERM`, sandboxing, `ReadWritePaths` on the build dir), nginx and Caddy snippets, `env.example`                                                                            | none: copy the files to the host yourself                            | rolling restarts across hosts (one unit, one process); schedules run in that process, so run one instance or move them to timers running `denext job <name>`                                                   |
| `staticHost()`                  | runs `denext export`, then `out/_headers` (immutable caching for the content-hashed files)                                                                                                                                                                                                                       | none: upload `out/` with your host's tool                            | **refuses** an app with any `isr`, `dynamic`, `route-handler` or `middleware` route and lists each one with its reason; metadata routes, `jobs/`, `services/` and the image optimizer are reported as warnings |

Your own adapter is an object with a `name`, a `prepare(ctx)` and, optionally, a `deploy(ctx)`;
`ctx` carries the `manifest`, `writeFile(path, contents, { in: "output" | "project", marker })`
(the adapter's own `.denext/deploy/<name>/`, or a marked project file), `env(name)`,
`which(...names)`, `run(command)`, `exportStatic()` and `dryRun`. A plugin contributes one with
`addDeployAdapter(adapter)` (the config's `deploy.adapter` wins). This is the seam for targets
denext does not ship, such as a Workers or Vercel adapter:

```ts
import { defineDeployAdapter } from "denext/deploy";
export const myHost = defineDeployAdapter({
  name: "my-host",
  async prepare({ manifest, writeFile }) {
    const routes = manifest.routes.filter((r) => r.kind !== "static").map((r) => r.path);
    await writeFile("routes.json", JSON.stringify(routes, null, 2));
  },
});
```

### Static export

If your app is fully static (no per-request data), export it to plain HTML and
host it anywhere — this very docs site is built that way:

```sh
denext export .   # writes out/ — pure HTML, 0 KB JS on static pages
```

An app with an `app/global-error.tsx` also gets `out/500.html`, its global-error page
pre-rendered and hydrating (its `reset` re-fetches the page). Point your host's error page at it
where the host supports one.

### Docker

```dockerfile
FROM denoland/deno:2.9.7

# Build and run as the image's unprivileged `deno` user — /app must be its own, because
# the build writes .denext/ and the durable cache (.denext/cache.db) lives there too.
WORKDIR /app
RUN chown deno:deno /app
USER deno

# Dependency layer: cached until deno.json / deno.lock change.
COPY --chown=deno:deno deno.json deno.lock* ./
RUN deno install

COPY --chown=deno:deno . .
RUN deno task build

EXPOSE 3000
# The built-in probe; its body reports the cache store ("memory" = write grant missing).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD deno eval "fetch('http://127.0.0.1:3000/_denext/health').then((r)=>Deno.exit(r.ok?0:1)).catch(()=>Deno.exit(1))"

# tini (PID 1) signals the whole process group, and the CMD is the `start` task's own
# `deno run` line: `deno task` does not forward SIGTERM, so `docker stop` would otherwise
# wait out its grace period and SIGKILL the server (no drain, no plugin teardowns).
# --allow-net --allow-read --allow-env --allow-write=.denext is the least-privilege task
# `denext create` writes; the write grant keeps the cache durable.
ENTRYPOINT ["/tini", "-g", "--", "docker-entrypoint.sh"]
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-env", "--allow-write=.denext", "jsr:@denext/denext@^4.0.0/cli", "start", "."]
```

`denext build` / `denext export` set `DENEXT_PHASE=build` while they run: a `RUN deno task build`
layer has no runtime secrets, so `denextAuth({ secret: Deno.env.get("AUTH_SECRET")! })` builds
with a throwaway secret, and its OAuth client credentials and production `canonicalOrigin` are
checked when the server starts instead. Nothing else needs a build-time `.env`.

`docker build -t my-app . && docker run -p 3000:3000 -e SESSION_SECRET=… my-app`.
Put a concurrency ceiling / TLS in front (§1) — a reverse proxy or your
platform. Behind that proxy, tell denext its public origin (§6):
`-e DENEXT_CANONICAL_ORIGIN=https://example.com` (or `DENEXT_TRUST_PROXY=1`) —
without it every Server Action posted through a proxy that rewrites `Host` is
refused as cross-origin (`403`).

**Don't hand-write it.** `denext generate ci` writes a GitHub Actions workflow
(`.github/workflows/ci.yml`: Deno pinned to the version that generated it, then
the project's `check` task — else `deno fmt --check`, `deno lint`, `deno test` —
and its `build` task, or `export` for a SPA). `denext generate docker` writes the `Dockerfile`,
`docker-compose.yml` and `.dockerignore` for you — SSR or static image
auto-detected from your config — plus, when the project needs them, a database, an object store
and a migrations step (the [self-hosted stack](#self-hosted-stack-postgres-storage-migrations)
below). The [Project UI](/docs/ui)'s Docker panel regenerates the same files with the same
options and shows a per-file diff before it writes. Both are the same templates, and an existing
file is never overwritten: the CLI skips it and prints its diff (`--force` overwrites, `--dry-run`
writes nothing), and the UI refuses a file you edited by hand (one without the generated-file
sentinel header). The generator is the source of truth: the snippet above is a readable
illustration and can lag it in details like the dependency-cache layer, the exact run flags and
whether the port comes from `PORT` or `--port`.

### Self-hosted stack (Postgres, storage, migrations)

`denext generate docker` reads your project and adds the services it needs to the compose
file — Supabase's self-hosted layout, on denext:

```sh
denext generate docker            # detect: report what the project needs, write it
denext generate docker --stack    # everything detected, and Postgres even if nothing asked
denext generate docker --postgres --pgvector --no-storage --dev --dry-run
cp .env.example .env              # then fill in every secret it lists
docker compose up -d --build
```

| Service      | Added when (detected)                                         | Flag                           | What it is                                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web`        | always                                                        | `--port`, `--deno-tag`         | the app image; waits for every service below                                                                                                                                                                                                                                                                 |
| `db`         | `@denext/backend` in the config, or a Postgres `DATABASE_URL` | `--postgres` / `--no-postgres` | Postgres 17 (`postgres:17-alpine`), `DATABASE_URL` wired into the app, a `db-data` volume                                                                                                                                                                                                                    |
| `db-init`    | with `db`                                                     |                                | one-shot, as the superuser: creates the app's own role (`POSTGRES_APP_USER`, the database's owner, never a superuser), sets its password from `.env`, with pgvector creates the extension, and with `realtime({ source: "logical" })` gives the role `REPLICATION` (`db` then runs with `wal_level=logical`) |
| (`db` image) | `create extension … vector` in `migrations/`                  | `--pgvector`                   | `pgvector/pgvector:pg17` instead                                                                                                                                                                                                                                                                             |
| `minio`      | an `s3()` storage driver in `backend({ storage })`            | `--storage` / `--no-storage`   | an S3 store with a `storage-data` volume; the app gets `AWS_*` / `S3_*`                                                                                                                                                                                                                                      |
| `minio-init` | with `minio`                                                  |                                | one-shot `mc mb --ignore-existing` for the bucket (the literal `s3({ bucket })`, or `S3_BUCKET`)                                                                                                                                                                                                             |
| `migrate`    | `migrations/` and `jobs/migrate.ts` (or `@denext/backend`)    | `--migrate` / `--no-migrate`   | one-shot before the app starts: with `@denext/backend`, `denext migration up` (the backend's own migrations — the `anon` / `authenticated` roles, the storage and realtime schemas — then yours); else `denext job migrate` (your `migrate` task when you have one)                                          |

Every long-running service has a health check, the app's `depends_on` waits for
`service_healthy` / `service_completed_successfully`, every service has a restart policy, and
data lives in named volumes. The database publishes no host port: the app reaches it as
`db:5432`. `--expose-db` publishes it on `127.0.0.1:5432` (`DB_PORT` in `.env` moves it).
MinIO is published on `127.0.0.1:9000` (`MINIO_PORT`) so the default presigned URLs work for a
browser on that machine.
`--dev` also writes `compose.dev.yml`, an overlay that runs `denext dev` on a bind mount of the
project (as your user: `export UID GID=$(id -g)` first) and publishes Postgres on loopback: `docker compose -f docker-compose.yml -f compose.dev.yml up --build`. The dev server
asks a browser on another address for its per-run token, so open the URL it logs.

**Secrets.** `.env.example` lists every variable the stack reads — `POSTGRES_PASSWORD`,
`POSTGRES_APP_PASSWORD`,
`AUTH_SECRET` (with `denextAuth`); with `@denext/backend` the Supabase keys
`DENEXT_PUBLISHABLE_KEY`, `DENEXT_SECRET_KEY` and `DENEXT_JWT_SIGNING_KEYS` (from `denext backend
keys`; the legacy `DENEXT_JWT_SECRET` only for HS256 keys), `DENEXT_VAULT_KEY` (required only
with `vault`) and `DENEXT_WEBHOOK_SECRET` (read only with `webhooks`); `DENEXT_STORAGE_SECRET`
(with backend storage), `MINIO_ROOT_PASSWORD`, … — each with the command that generates a value
(`openssl rand -base64 32`). Required ones are left
empty, and the compose file reads them as `${NAME:?…}`, so `docker compose` refuses to start
until `.env` sets them; nothing is ever written with a real secret. `.dockerignore` keeps `.env`
out of the image — keep it out of git too (the generator warns when `.gitignore` doesn't).

**The database role.** The app and the `migrate` service connect as `POSTGRES_APP_USER`
(default `denext_app`): the owner of the database and its `public` schema with `CREATEROLE` —
what the backend's own DDL needs (its schemas, tables and triggers, and the `anon` /
`authenticated` roles) — and never a superuser, so neither `db.service()` nor a SQL injection
runs with superuser rights. The superuser (`POSTGRES_USER`) is used only by `db-init` and the
database's health check. `db-init` runs on every `up`, so a changed `POSTGRES_APP_PASSWORD` takes
effect on the next one. Realtime with `source: "logical"` also needs
`ALTER ROLE denext_app REPLICATION` (run it as the superuser). A stack whose tables were created
before this (owned by the superuser) has to start over (`denext stack down --volumes`) or move
them to the app role with `ALTER TABLE … OWNER TO denext_app`.

**Per-IP limits.** Inside Docker every client reaches the app from the bridge's private address,
which per-address limits skip by default, so the stack sets
`DENEXT_RATE_LIMIT_LOCAL_ADDRESSES=1`: sign-in, sign-up and code budgets stay on. Behind a
reverse proxy also set `DENEXT_TRUST_PROXY=1` (or `DENEXT_RATE_LIMIT_TRUSTED_PROXIES`), so each
client gets its own budget instead of sharing the proxy's.

**The runtime.** With Postgres or `@denext/backend`, the image runs on denext's Deno toolchain
(the build already downloaded it; a layer puts it first on `PATH`), because
`@denext/backend`'s Postgres client is `Deno.SQL`, which stock Deno does not have.

**Object storage from the browser.** The app talks to the store at `S3_ENDPOINT` (default
`http://minio:9000`, which only the containers can resolve), and signs every URL it hands a
browser — presigned uploads, downloads, multipart parts — for `S3_PUBLIC_ENDPOINT` instead
(`s3({ publicEndpoint })`; SigV4 signs the host, so the URL must be signed for the name the
browser uses). Its default, `http://localhost:9000`, is the port the stack publishes MinIO on
(loopback only), so uploads and downloads work from a browser on the machine running the stack.
In production route a public HTTPS hostname to the `minio` service and set
`S3_PUBLIC_ENDPOINT` to it. MinIO no longer publishes pullable
images, so the service uses Bitnami's legacy build of the same server, pinned by digest;
`MINIO_IMAGE` in `.env` swaps in any MinIO-compatible image that has `mc`.

### Operating the stack

`denext stack` runs the stack the way `supabase start` does, and operates it once it is up:

```sh
denext stack up | down | status        # start (writing the stack and .env when missing), stop, URLs
denext stack health [--json] [--watch [seconds]]
denext stack logs [service] [--service s] [--level warn] [--since 30m] [--until t] [--grep text]
denext stack passwd --postgres [--dashboard] [--generate]
denext stack roll [--include-secret] [--keep-old | --drop-old]
denext stack backup [file] [--full]
denext stack restore <file> [--yes]
```

**Health.** `health` lists every service with its compose health check (a one-shot such as
`db-init` or `migrate` counts once it has exited 0), then calls the app's own
[`/_denext/health`](#13-health--readiness) and lists its readiness checks (`database`, …). It
exits 1 when anything is unhealthy, so a script or a cron job can act on it. `--json` prints
`{ ok, checkedAt, services: [{ name, state, health, ok }], app: { url, status, httpStatus,
checks } }`. `--watch` repeats every 5 seconds, or every N with `--watch N`.

**Logs.** `logs` is `docker compose logs` with filters: `--service` (repeatable, next to the
positional service), `--since` / `--until` (a timestamp such as `2026-10-14T09:00:00Z`, or a
relative `30m`, passed to compose), `--level debug | info | warn | error` (that level and above;
the level is read from a JSON or logfmt `level` field or a level word such as Postgres's `ERROR:`;
a line naming none counts as `info`) and `--grep` (plain text, case-sensitive, or `/regex/flags`).
`--follow` works with every filter.

**Passwords.** `passwd --postgres` changes the superuser's password (`POSTGRES_PASSWORD`) and the
app role's (`POSTGRES_APP_PASSWORD`). It runs `ALTER ROLE` for both inside the running database,
in one transaction, before it writes `.env`, so the two never disagree; if the database refuses,
`.env` is left as it was. The superuser's new password comes from stdin (typed twice without echo
on a terminal, or one line piped in) or `--generate`; the app role always gets a fresh random one,
since only the app reads it. `passwd --dashboard` sets `DASHBOARD_PASSWORD`. A password is never
accepted as an argument, where `ps` would show it, and none is printed unless you pass
`--show-secrets`. A Postgres password may use `A-Z a-z 0-9 . _ ~ -` only (it goes into
`DATABASE_URL`).

**Keys.** `roll` replaces `DENEXT_PUBLISHABLE_KEY` and `DENEXT_SECRET_KEY` with a new pair (the
same minting as `denext backend keys`). Clients holding the old keys need the new ones.
`--include-secret` also replaces `DENEXT_JWT_SIGNING_KEYS`, and `DENEXT_JWT_SECRET` when it is
set. That ends every access token, refresh session and legacy JWT key already issued, so it warns
and asks first (`--yes` skips the question; off a terminal, `--yes` is required).

**Rotating without a cut-over.** `roll --keep-old` starts a rotation instead: the new key goes
first and the one in effect until now stays listed after it (the backend accepts every
comma-separated publishable or secret key, and every key in `DENEXT_JWT_SIGNING_KEYS`, signing with
the first), so clients and tokens holding the old keys keep working. With `--include-secret` the
old signing key stays as a verifier, so no token ends and nothing is asked. The legacy
`DENEXT_JWT_SECRET` holds one value, so `--keep-old` leaves it as it is (`roll --include-secret`
without `--keep-old` replaces it, ending the legacy JWTs). Finish the rotation once every client
has the new keys and, after an `--include-secret` roll, once the access tokens the old key signed
have expired (an hour by default):

```sh
denext stack roll --include-secret --keep-old   # new keys first, the previous ones still valid
# …ship the new publishable key to every client, wait out the old access tokens…
denext stack roll --drop-old                     # keep only the newest key of each kind
```

`--drop-old` mints nothing: it keeps the first publishable key, secret key and signing key and
drops the rest. A second `roll --keep-old` also retires the previous keys, keeping the key that
was current next to an even newer one.

**After a change.** `passwd` and `roll` edit `.env` in place. Comments, blank lines, order and
every other variable keep their bytes, and the file is replaced atomically with its mode (0600
for a new one). Then the containers that read the changed values have to be recreated:
`--restart` does it at once (`docker compose up -d --wait web`), `--no-restart` leaves them, and
with neither the command asks on a terminal and prints the restart command anywhere else.

**Backups.** `backup` writes the database as a `pg_dump` custom-format file, by default to
`.denext/backups/stack-<time>.dump` (which `.dockerignore` keeps out of the image). `--full`
writes one `.tar.gz` holding the non-superuser roles and their memberships (no passwords),
the extensions, the dump, the database and role settings, the storage objects (the MinIO bucket,
or the `fs()` driver's directory: a literal `fs({ dir })` in the config, or `--storage-dir`) and
a `MANIFEST.txt` that records the restore order. Every Postgres tool runs inside the stack's
`db` container, so the machine needs no Postgres client. Backups are written 0600 and never
overwrite an existing file.

**Restore.** `restore <file>` recognizes a dump or a full backup by its first bytes. It refuses
a database that already has tables unless you pass `--yes` (a stack that ran its migrations
already has some). It then stops the app, runs `pg_restore --clean --if-exists` in one
transaction (the full backup's steps in its manifest's order), and starts the app again. A full
backup is extracted and checked before anything is touched: an entry with an absolute path or
`..`, a link that leaves the backup, a hard link or a device is refused, and restore runs only
the steps it knows, from the files the manifest names. The roles' passwords are not in a backup,
so the restoring stack keeps the ones in its own `.env`.

### The dashboard

With Postgres the stack has a `dashboard` service: [`denext dashboard`](/docs/ui#the-stack-dashboard),
a Studio-style view of the stack's database. Tables and rows (browse, filter, sort, page, insert,
edit, delete), a SQL editor, row-level security policies, migrations, storage buckets and objects
(upload, download, delete), denext auth's users (search, create, ban, set a password, revoke,
delete), realtime (the publication opt-in, live channels, presence keys, `postgres_changes`
subscribers), Edge Functions with their recent invocations, the logs, and health. It runs the
app's own image with the app's environment, so its database and storage are the app's, reads the
running app at `DASHBOARD_APP_URL` (`http://web:<port>`; the backend's admin endpoint answers it the
secret key the app's environment already holds), and publishes on this machine's loopback only:

```sh
denext stack status      # Dashboard URL  http://127.0.0.1:3100
```

It is behind `DASHBOARD_PASSWORD`, which `denext stack up` generates into a new `.env`
(`denext stack status --show-secrets` prints it) and `denext stack passwd --dashboard` changes.
Without one (a stack whose `.env` predates the dashboard) it stays locked and says how to set
one. `DASHBOARD_PORT` moves the port; `--no-dashboard` on `denext generate docker` (or
`denext stack up`) leaves it out. To reach it from another machine, put a TLS reverse proxy in
front and add `"--origin", "https://<its host>"` to its command: over that https origin the session
cookie is `__Host-` and `Secure` (a plain-http origin off this machine is refused), sign-ins are rate limited, and every change needs a same-origin request and a CSRF token.

**Logs and service health.** The dashboard's container has no Docker, so its Logs page and the
services on its Health page read through a relay:
`--dashboard-logs` (opt-in) adds a `dashboard-logs` service, the only one that mounts the Docker
socket (`DOCKER_SOCKET` in `.env` points it at another, for rootless Docker or Podman). It runs as
root to read the socket, is on a network of its own with the dashboard (`internal: true`, no
published port), answers only GETs for this project's own services and their logs behind a bearer
token derived from `DASHBOARD_PASSWORD`, and never reads another container's settings or runs
anything. Without it the Logs page says so; `denext stack logs` works either way.

### Deno Deploy

Push the repo and point the entrypoint at `jsr:@denext/denext@^4.0.0/cli` with args
`start .`, or add a build step running `deno task build`. Deno Deploy provides
TLS and autoscaling; still set a per-instance `maxConcurrency` (§1) and your
secrets (`SESSION_SECRET`, etc.) as environment variables.

denext's cache defaults to Deno's built-in `node:sqlite` (a local SQLite file),
but Deno Deploy has no persistent local filesystem, so the cache falls back to a
per-instance **in-memory** store there. For a cache that is durable and shared
across edge instances, inject your own `CacheStore` via `cache.store` in
`denext.config.ts`.

### Self-host (systemd)

```ini
# /etc/systemd/system/my-app.service
[Service]
WorkingDirectory=/srv/my-app
Environment=PORT=3000
Environment=SESSION_SECRET=…
Environment=DENEXT_CANONICAL_ORIGIN=https://example.com
ExecStart=/usr/local/bin/deno run --allow-net --allow-read --allow-env --allow-write=.denext jsr:@denext/denext@^4.0.0/cli start .
Restart=always
[Install]
WantedBy=multi-user.target
```

Run `denext task build` (or `deno task build`) in your deploy step, then
`systemctl restart my-app`. The least-privilege `start` spawns no child process, so it runs
on whichever `deno` the unit names; it needs no `--allow-run` and no toolchain download.
An app whose Postgres client is `Deno.SQL` (`postgresClient()`, `@denext/backend`'s default)
needs that `deno` to be [denext's toolchain](/docs/toolchain): point `ExecStart` at the path
`denext toolchain path` prints, or give the app a postgres.js client
([Databases › Postgres](/docs/database#postgres)).
Front it with nginx/Caddy for TLS + the concurrency limit (§1).

### Single binary

`denext build --compile` turns the app's server into one executable that does what
`denext start` does (and runs `job` and `db` too), with the least-privilege flags baked in and
no `.env` or database embedded. Copy it to the host and run it from the directory that should hold
its `.env` and `./.denext` state. Targets, permissions and what it embeds:
[Deployment targets › A single binary](/docs/deployment-targets#a-single-binary-with-denext-build---compile).

## 1. Put a concurrency ceiling in front of denext (required)

denext does **not** impose a built-in cap on concurrent in-flight requests or a
CPU ceiling. A single Deno process will accept as many connections as the
runtime allows; a flood (or a few very expensive renders) can exhaust memory or
peg the CPU. In production you **must** bound concurrency at the layer in front:

- a reverse proxy (`nginx` `limit_conn`/`limit_req`, Caddy, HAProxy),
- a platform autoscaler + per-instance connection limit, or
- an API gateway / load balancer with request-rate and concurrency limits.

Run multiple denext instances behind that layer to scale out; size each
instance's concurrency to its CPU/memory budget.

**Optional in-process backstop (`maxConcurrency`).** As a complement — _not_ a
replacement — for the edge ceiling, set `maxConcurrency` in `denext.config.ts`
(or the `DENEXT_MAX_CONCURRENCY` env var; the config wins when both are set):
the max number of client requests one instance handles at once. A request that
arrives at capacity is **shed immediately** with a `503` and `Retry-After: 1`.
It is fast-fail, never queued, so shedding stays O(1) and can't itself amplify
the overload. A slot is held from arrival until the response is **produced** and
released on every exit path (success, error, abort, timeout); for a streaming
body the slot frees when the `Response` is returned, not when the body finishes.
This is deliberate: it bounds handler/render concurrency up to Response
production, but does **not** count a stream's client-read duration. Holding a
slot until a stream drains would let a slow-reading client pin slots (slowloris)
and would let long-lived SSE exhaust the ceiling — so the client-read duration
of streaming bodies (SSE, chunked handler responses, large static files) must be
bounded at the **edge / load balancer** (slow-client read timeouts, max
concurrent connections), not by this in-process counter. Background ISR
regeneration is exempt. Default: no limit. Set it slightly above your
steady-state target so a single instance self-protects if the edge limit is
misconfigured — the edge ceiling above is still required.

```ts
// denext.config.ts
export default { maxConcurrency: 100 } satisfies DenextConfig;
// or, per deployment: DENEXT_MAX_CONCURRENCY=100 denext task start
```

**`slotBackstop` (with `requestTimeout: 0`).** If you disable the request
timeout (`requestTimeout: 0`) _and_ set `maxConcurrency`, a render that never
settles would otherwise hold its slot forever and could eventually wedge the
whole ceiling to 503s. A backstop timer (default 120s, tune via the
`slotBackstop` config key) force-frees the slot in that case — it frees only the
counter, it does **not** abort the render (you opted out of timing requests
out). With the default `requestTimeout` in place, the timeout already settles
the request, so the backstop is inert.

## 2. `requestTimeout` bounds _awaiting_, not _CPU_

`requestTimeout` (a `denext.config.ts` key in milliseconds, or
`DENEXT_REQUEST_TIMEOUT_MS`; default 30s, `0` disables) aborts a request whose
work is cooperative — i.e. it awaits I/O and threads the per-request
`AbortSignal` into its `fetch()`es. It **cannot** preempt a synchronous CPU loop
(a tight `while`, a pathological regex, an unbounded synchronous render):
JavaScript is single-threaded, so a synchronous hot loop blocks the event loop
until it returns. Keep render/handler code free of unbounded synchronous work,
and rely on the edge concurrency ceiling (§1) to contain the blast radius.
Under `denext dev`, time the dev server spends building on a request's behalf (route scans,
boundary crawls, a next-compat build on a target's first request) does not count against the
deadline; the app's own handler time does. `denext start` never pauses it.

A surface with a time budget of its own replaces the deadline for its requests with
`setRequestTimeout(ms)` from `denext/server` (from the request's start; `0` removes it; it may
also shorten it). `@denext/backend` does this for its surfaces, so the app's 30 s never cuts
them: an Edge Function gets its `timeoutMs` (150 s by default) plus 10 s, a storage upload or
download (`/storage/v1`, `/_denext/storage`, TUS) an hour, and an auto-REST request
`rest.statementTimeout` plus 6 s when that is longer than the app's deadline.

Reach the signal from anywhere in the request with `requestSignal()` from
`denext/server` — a route handler already has `request.signal`, but a Server
Component or Server Action fetching data does not, and threading
`requestSignal()` into those `fetch()`es is what lets the timeout (and a client
disconnect) actually reclaim the work. It returns `undefined` outside denext's
server loop, so a test that calls a handler directly is unaffected, and
`undefined` inside a `use cache` scope — a cached fill is shared with other
readers (single-flight followers, background refreshes), so one client's
disconnect must not abort it. React 19.2's `cacheSignal()` (from the `react` alias) is the
same signal one step later: it also aborts when the render ends (its last streamed byte
included), so work a `cache()`d function started and the page no longer needs is cancelled; it
is `null` on the client, outside a request and inside a `use cache` scope. The client
IP and the correlation id are reachable the same way: `clientIp()` (the trusted
proxy's last `x-forwarded-for` hop when `trustForwardedHeaders` is set, else the
socket peer — never read the header yourself) and `requestId()` (the value
`x-request-id` and `DENEXT_LOG=json` carry). `clientIp()` is a dynamic read, like
`headers()`; `requestSignal()` and `requestId()` are plumbing and keep a render
cacheable.

## 3. Outbound `fetch()` is not SSRF-pinned by default

denext's image optimizer pins DNS and refuses private/loopback/link-local
targets via `safeFetch`. **Your own** server-side `fetch()` calls (in server
components, route handlers, Server Actions) are ordinary `fetch` — they are
**not** DNS-pinned. If you fetch a **user-controlled URL** on the server, wrap
it in the exported `safeFetch` so a hostile host/redirect can't reach your
metadata endpoint or internal network:

```ts
import { safeFetch } from "denext/server";

// Refuses if any resolved A/AAAA is loopback/private/link-local/CGNAT/etc.
const res = await safeFetch(userProvidedUrl);
```

That covers link previews, "import from URL", avatar-by-URL, webhooks, and
anything else where the user names the host: `safeFetch` resolves + validates
the host, refuses internal addresses, pins the connection (closing DNS
rebinding), and bounds time and size.

```ts
import { safeFetch, SafeFetchError } from "denext/server";

try {
  const res = await safeFetch(userUrl, {
    allowedHosts: ["*.trusted-cdn.com"], // optional; omit = any public host
    maxBytes: 5_000_000,
    signal: AbortSignal.timeout(8000), // or an AbortController's signal
  });
} catch (e) {
  if (e instanceof SafeFetchError) { /* e.code: "blocked-address", … */ }
}
```

For fixed, trusted URLs plain `fetch` is fine. Keep using `fetch`/`cachedFetch`
for your **own** backends (internal services, `localhost`) — those are exactly
the addresses `safeFetch` deliberately blocks.

## 4. Redirect helpers

- `redirect()` (control-flow), config-driven `redirects()`, and the **middleware
  `redirectResponse()` helper** normalize their target through
  `safeRedirectLocation`, collapsing protocol-relative escapes (`//host`,
  `/\host`, …) to a same-origin path.
- `safeRedirectLocation` **passes an explicit absolute URL through verbatim**
  (that is intended — you asked to leave the origin), so
  `redirect("https://" + userInput)` is still an open redirect. Do not pass a
  user-controlled absolute URL to a redirect without validating it against your
  own allowlist first.
- **Don't build a redirect/rewrite destination _host_ from request input.** A
  config rule like `{ destination: "https://:host/..." }` substitutes a URL
  param into the host — an open redirect. A `rewrite` to an external host is
  **not** an SSRF in denext (rewrites re-route by pathname against your local
  manifest and never proxy), but it is still a misconfiguration. Keep params in
  the path.
- `NextResponse.redirect(url)` keeps Next.js's stricter contract: `url` must be
  absolute and a relative string throws.

## 5. CSP is applied to page responses, not Flight/API/static

denext computes a strict Content-Security-Policy for HTML page responses,
**buffered and streamed** alike — a streamed page and a Cache Components / PPR
shell with per-request holes carry the same hash-based policy, because the swap
runtime is a hashed constant and the head's inline styles are hashed before the
first byte flushes (see the streaming note below). **Flight/RSC** payload
responses are not HTML documents and carry no framework-generated CSP; neither
do API-route or static responses. If you want a policy on those, **set it at the
edge** (reverse proxy / CDN). (A streamed PPR response is `private, no-store`,
so an intermediary never shares it.)

The framework CSP keeps `script-src 'self'` and never hashes arbitrary inline
`<script>` output (so injected script can't self-authorize a hash) — denext
emits no executable inline script of its own on the buffered path; its data
islands are `type="application/json"` and its runtime is a same-origin
`<script src>`. It DOES hash each inline `<style>` block into `style-src`.
External scripts/styles are blocked until a route opts hosts in.

**Configuring it (three-state, global with per-file override):**

```ts
// denext.config.ts — app-wide default:
export default {
  csp: "strict", // default: the hash-based strict policy
  // csp: "off",                    // emit NO CSP header (set it at the edge / Next-style)
  // csp: { connectSrc: ["https://api.example.com"] }, // strict + these global opt-ins
};
```

```ts
// a route file overrides the global for that route:
export const csp = { scriptSrc: ["https://plausible.io"] }; // strict + this route's opt-ins
// export const csp = "off";   // disable CSP for just this route (e.g. an embed)
// export const csp = "strict"; // force strict here even when the global default is "off"
```

**Incremental streaming (`streaming`).** **On by default.** A route with a
pending `<Suspense>` boundary flushes its shell first and streams each boundary
as it resolves; streamed responses carry the **same strict hash-based CSP** as
buffered ones (the swap runtime is a hashed constant). A fully synchronous route
(no holes) is still delivered buffered, so it stays shared-cacheable, and
ISR/PPR-cacheable routes take their own path first — so streaming never bypasses
the page cache. A streamed route is rendered per request (`no-store`), not
ISR-cached. Opt the whole app out with `streaming: false` (a top-level config
field).

## 6. Tell denext about your proxy (origin + forwarded headers)

Behind a TLS-terminating reverse proxy, denext needs to know its real public
origin for correct absolute URLs, Server-Action **CSRF origin checks**, and
HSTS. Configure one of, in `denext.config.ts` or as an env var (the config wins
when both are set):

- **`canonicalOrigin: "https://example.com"`** (env `DENEXT_CANONICAL_ORIGIN`) —
  pins the public origin outright (wins over any header; the most robust
  option). A bare origin — scheme + host, no path; anything else fails config
  validation at boot. Or
- **`trustForwardedHeaders: true`** (env `DENEXT_TRUST_PROXY=1`) — trust
  `x-forwarded-proto` / `x-forwarded-host` from the proxy. Only enable this when
  clients **cannot** reach denext directly and spoof those headers.

```ts
// denext.config.ts
export default {
  canonicalOrigin: "https://example.com",
} satisfies DenextConfig;
```

With neither set, denext derives the origin from the `Host` header / request URL
and treats `x-forwarded-proto` as untrusted (so a spoofed
`x-forwarded-proto:
https` will **not** induce HSTS, and the action-CSRF check
uses the connection's own scheme). The symptom of a proxy that rewrites `Host`
with neither set is every Server Action answering `403` (its `Origin` no longer
matches the `Host` denext sees) — set one of the two and it clears.

The same rule governs the helpers: **`absoluteUrl`/`requestOrigin` derive the
origin from the `Host` header** unless you opt in with `trustForwardedHeaders`.
A client can spoof `Host`, so for a fixed public origin set `canonicalOrigin` —
it overrides the header and is the robust choice for canonical and `og:image`
URLs.

Generated metadata URLs (the `og:image` an `opengraph-image` file adds, automatic hreflang and
canonical links) go further: they resolve against `canonicalOrigin`, else the page's
`metadataBase`, and never take the request's origin in a page that may be cached. A client
controls `Host`, so an origin read from it and stored by the ISR cache or a CDN would be served
to every later visitor (web cache poisoning). Without either setting, a cacheable page
(`revalidate`, `force-static`) keeps `og:image` relative and omits hreflang / canonical; a
per-request page uses the request's origin and is sent `no-store`, as is a `generateSitemaps`
sitemap index built on it. Production logs one warning when neither is set.

### Per-address limits behind a proxy

Every per-address limit — `rateLimit()`'s default key, `denextAuth`'s per-IP
budgets, `live.limits.maxConnectionsPerIp` and `@denext/backend` realtime's
signed-out quota — keys on the address `clientIpForLimits()` answers: the
trusted proxy's last `x-forwarded-for` hop, else the socket peer. A loopback or
private socket peer with no trusted hop is skipped (one warning), because behind
an undeclared proxy every visitor shares that address and its limit would be
site-wide. Two settings, modelled on Supabase Auth's `GOTRUE_RATE_LIMIT_HEADER`,
change that:

- **`rateLimitHeader: "cf-connecting-ip"`** (env `DENEXT_RATE_LIMIT_HEADER`) —
  key the limits on the client address your proxy writes into that header
  (`fly-client-ip` on Fly.io, `x-real-ip` from nginx's
  `proxy_set_header X-Real-IP $remote_addr`). Its last comma-separated value is
  used, an IPv6 address counts as its `/64` and an IPv4-mapped one as its IPv4;
  a private address there is counted too. A request **without** an IP address in
  it did not come through that proxy, so it falls back to the rule above with one
  warning — Supabase Auth applies no limit to such a request, which would let a
  client that reaches the server directly skip every limit by leaving the header
  out. The header names the limit key only: `clientIp()` still follows
  `trustForwardedHeaders`. The proxy must **overwrite** the header.
- **`rateLimitTrustedProxies: ["173.245.48.0/20", …]`** (env
  `DENEXT_RATE_LIMIT_TRUSTED_PROXIES`, comma-separated) — the socket peers
  whose `rateLimitHeader` is believed. From any other peer the header is ignored
  (one warning) and the limit keys on that peer. With none listed, a
  loopback/private peer is trusted while `trustForwardedHeaders` is on (an nginx
  or `cloudflared` on the same host or network); with neither set the header is
  never believed and the server warns at boot. Supabase Auth trusts
  `GOTRUE_RATE_LIMIT_HEADER` from anyone; denext does not, because where the
  origin is reachable directly (a leaked origin IP, an exposed app port) a client
  could send a fresh value on every request and get a fresh bucket each time —
  defeating `denextAuth`'s IP-wide lockout, `rateLimit()` and the Live cap
  silently.
- **`rateLimitLocalAddresses: true`** (env `DENEXT_RATE_LIMIT_LOCAL_ADDRESSES=1`)
  — count a loopback/private socket peer by its own address instead of skipping
  it: a LAN, VPN or container-network deployment where those peers are the real
  clients.

```ts
// denext.config.ts — behind Cloudflare (its edge connects from its published ranges;
// copy the full current list from https://www.cloudflare.com/ips/)
export default {
  canonicalOrigin: "https://example.com",
  rateLimitHeader: "cf-connecting-ip",
  rateLimitTrustedProxies: ["173.245.48.0/20", "103.21.244.0/22", "2400:cb00::/32" /* … */],
} satisfies DenextConfig;
```

## 7. Cookies are secure by default

`cookies().set()` defaults to **`httpOnly` + `SameSite=Lax` + `Secure`** (Secure
is added over HTTPS — directly or behind a proxy that sets
`x-forwarded-proto: https`). This is stricter than Next.js (which adds nothing)
— a deliberate secure default. To set a cookie the browser's JS must read, opt
out explicitly:

```ts
cookies().set("theme", "dark", { httpOnly: false }); // client-readable
```

For sessions, set a strong `SESSION_SECRET` (≥32 chars; a shorter one warns in
dev and throws in production) and prefer the built-in signed-cookie helper
instead of hand-rolling:

```ts
import { getSession } from "denext/server";
const session = await getSession<{ userId: string }>({
  secret: Deno.env.get("SESSION_SECRET")!, // long + random (≥32 chars; shorter warns in dev, throws in prod)
  hostPrefix: true, // recommended: origin-lock the cookie (__Host- → Secure, Path=/, no Domain)
});
await session.set({ userId: user.id }); // signed (HMAC), httpOnly, Secure, SameSite=Lax
```

`hostPrefix: true` renames the cookie to `__Host-denext_session` and pins the
browser-enforced origin-lock invariants, so a sibling subdomain can't set or
read it. Enable it from the start on new apps (turning it on later logs existing
users out once, since the cookie is renamed).

## 8. Correlation ids

Every response carries a request id (surfaced in the request log and echoed as
`x-request-id` on error responses). When the app trusts its proxy
(`trustForwardedHeaders` / `DENEXT_TRUST_PROXY=1`), denext reuses an inbound
`x-request-id` (sanitized to safe token characters and length-bounded);
otherwise it mints a UUID, so a client can't choose the id your logs carry.
Propagate a trace id from your edge as `x-request-id` to correlate proxy and
app logs.

## 9. Request logging

Set `DENEXT_LOG=json` for structured (one-JSON-object-per-line) request logs
suited to log pipelines — each object carries a `statusClass` field (`2xx`,
`5xx`, …) ready to ingest; any other truthy value (e.g. `DENEXT_LOG=1`) emits a
compact human-readable one-line-per-request log. Logged fields (method, path,
status, duration, request id) are safe against log forging (the request id is
sanitized; JSON output escapes control characters). For a programmatic hook
instead of (or alongside) the env var, see the `onRequest` callback in §14.

## 10. Graceful shutdown

On `SIGTERM`/`SIGINT` the server stops accepting new connections and drains
in-flight requests. Then it stops the
[`services/` tree](/docs/services#shutdown-and-the-server-drain), runs the plugin
teardowns, and finally runs `instrumentation.ts`'s `onShutdown()`. Draining is
bounded by a deadline (default **10s**): set `DENEXT_SHUTDOWN_DRAIN_MS` to tune
it, or `0` to drain indefinitely. If the deadline elapses with requests still in
flight, the process force-exits and plugin teardown is skipped. When the
deadline passes after the drain, the process exits even if a handle nothing
closed keeps it alive, such as an app-owned database pool, a timer or a socket.
To exit sooner, close such resources in `onShutdown`:

```ts
// instrumentation.ts
import { sql } from "./lib/db.ts"; // e.g. postgres(url)
export async function onShutdown() {
  await sql.end({ timeout: 5 });
}
```

Size it above your longest
expected request and below your orchestrator's kill grace (e.g. k8s
`terminationGracePeriodSeconds`, typically 30s; the generated compose file sets
`stop_grace_period: 30s`). The signal must reach the server process itself: run
`deno run … start` directly (as the generated Dockerfile does), not under `deno task`, which
does not forward `SIGTERM`.

## 11. The ISR page-cache key omits the Host (multi-tenant caveat)

The built-in ISR page cache keys entries on `pathname + sorted search params` —
**not** the request's `Host`. This is correct for the common case (one instance
serves one origin) and keeps the key stable behind a proxy that may rewrite
Host.

It matters only if you run **one denext instance serving multiple tenants on
different hostnames from a shared `PageCache`**: a cacheable route at the same
path (e.g. `/dashboard`) would collide across tenants, and one tenant could be
served another's cached HTML. If that is your topology, do one of:

- run a separate instance (and cache) per tenant — the recommended shape; or
- put the tenant in the path (`/t/:tenant/…`) so it is part of the key; or
- supply a `PageCache` whose keys you namespace by tenant.

Single-origin deployments (the default) are unaffected. Note this partitioning
concern is distinct from the soft-nav variant partitioning (`x-denext-nav`,
which the cache already keeps separate from the HTML variant).

## 12. ISR cache-key query params (high-cardinality caveat + allowlist)

By default **every** query parameter participates in the ISR page-cache key
(only their _order_ is normalized, so `?a=1&b=2` and `?b=2&a=1` share one
entry). That is correct, but a cacheable route hit with high-cardinality junk
params — `?utm_*`, `?fbclid`, a random cache-buster — will mint a distinct entry
per distinct value, inflating the cache and churning its LRU (the default store
is the durable `node:sqlite` file under `.denext/`, so `denext start` needs
`--allow-write=.denext`; the in-memory fallback applies when that write is not
permitted). Both stores are byte- and count-bounded, so this degrades hit-rate
rather than exhausting memory, but it still wastes work.

Two mitigations, use either or both:

- **Strip junk params at the edge** before they reach denext (a reverse proxy
  can drop `utm_*`/`fbclid`), and/or
- **Set `cacheKeyParams`** in `denext.config.ts` (an opt-in allowlist of param
  names) so only the params that actually change cacheable output fork the key.
  Every other param is dropped from the key but **still reaches the render** via
  `searchParams` — so list every param whose value changes what a cacheable page
  emits. Omit it to keep the default (all params participate).

```ts
// denext.config.ts
export default { cacheKeyParams: ["page", "sort"] } satisfies DenextConfig;
// ?page=2&utm_source=x and ?page=2&utm_source=y now share one cached entry.
```

## 13. Health & readiness

The production server answers a built-in liveness probe at **`/_denext/health`**
(GET/HEAD only — other methods get a `405`), meant for load balancers and k8s
probes. It returns `200` even when the cache backend is down — the site serves,
since reads degrade to live renders — and the JSON body reports cache
reachability so operators aren't blind to an outage:

```json
{ "status": "ok", "cache": "ok", "cacheStore": "sqlite" }
```

A dependency the app cannot serve without registers a readiness check with
`registerHealthCheck(name, check)` from `denext/server`; `@denext/backend` registers
`database` (`select 1` on its Postgres client). While any check fails (or takes over 2 s) the
probe answers **`503`** with `"status": "degraded"` and the check named — never its error, the
probe is public — so a load balancer or the generated compose healthcheck stops routing to an
instance that could only answer errors:

```json
{ "status": "degraded", "cache": "ok", "cacheStore": "sqlite", "checks": { "database": "down" } }
```

`denext doctor` runs the backend's checks too: its setup accepts the configuration (API keys,
storage secret), the database answers, the backend's and the app's migrations are applied, and
the storage driver answers.

`"cache": "degraded"` means the active cache store failed its probe.
`cacheStore` is what backs it: `"sqlite"` (the durable default), `"memory"`
(per-process — nothing survives a restart; in production this almost always
means `denext start` was launched without `--allow-write=.denext`, and the boot
log says so in one line), or `"custom"` (your own `cache.store`). If you want
the same signal on a route of your own (a readiness check with app-level logic),
`cacheStoreHealthy()` probes the active cache backend **without throwing** —
expose it on a `/healthz` route:

```ts
// app/healthz/route.ts
import { cacheStoreHealthy } from "denext/server";
export async function GET() {
  return Response.json({
    ok: true,
    cache: (await cacheStoreHealthy()) ? "ok" : "degraded",
  });
}
```

## 14. Observability

**`onRequest(info)`.** Export `onRequest` from your root `instrumentation.ts`
(beside `register` / `onRequestError`) for per-request logging/metrics — `info`
carries `method`, `path`, `status`, `durationMs`, and a `requestId` (which is
also echoed as the `x-request-id` response header on an error, for correlation —
§8). It is called once after every response under `denext start` and
`denext dev`; a throw from it is swallowed. It replaces the `DENEXT_LOG` default
logger when present. `requestTimeout` (ms) responds `503` when exceeded (§2).

**Env-var logging.** If you don't need a callback, `DENEXT_LOG=1` gives a
compact one-line-per-request logger and `DENEXT_LOG=json` a structured object
per request (with a `statusClass` field) — see §9 for the fields and their
log-forging guarantees.

**Client-side instrumentation.** A root `instrumentation-client.{ts,tsx,js}`
(Next's convention) is bundled into every browser entry and runs before the
app's client code starts — the place for a monitoring/analytics init.

**OpenTelemetry recipe.** Wire `onRequest` to a histogram and `onRequestError`
to your tracer/error sink, both from `instrumentation.ts`:

```ts
// instrumentation.ts
import type { RequestLogInfo } from "denext/server";
export function onRequestError(err, request, ctx) {
  tracer.recordException(err, {
    "http.route": ctx.routePath,
    "http.url": request.path,
  });
}
export function onRequest(i: RequestLogInfo) {
  httpDuration.record(i.durationMs, {
    "http.method": i.method,
    "http.status_code": i.status,
    "http.status_class": `${Math.floor(i.status / 100)}xx`,
  });
}
```

**Custom server.** Everything above is also a `createApp()` / `serve()` option
(`onRequest`, `requestTimeout`, `maxConcurrency`, `slotBackstop`,
`canonicalOrigin`, `trustForwardedHeaders`, `actionMaxBodyBytes`,
`cacheKeyParams`) for an app that embeds denext instead of running
`denext start`. A custom server reads neither `denext.config.ts`'s server keys
nor the `DENEXT_*` env vars for them — pass the values yourself.

## 15. Ops runbook

- **Health:** point the load balancer at `/_denext/health`, or expose
  `cacheStoreHealthy()` on your own `/healthz` route for readiness checks (§13).
- **Correlate an error:** a `500` returns an `x-request-id` header; grep the
  logs (`DENEXT_LOG=json`) for that `requestId` to find the full server-side
  error and digest (§8, §9).
- **Runaway request:** bounded by `requestTimeout` (default 30s → `503`); the
  render is signal-aware, so a client disconnect or timeout actually cancels the
  work (§2).
- **Graceful shutdown:** on `SIGINT`/`SIGTERM` the server stops accepting
  connections and drains in-flight requests before exiting — abort the `serve()`
  signal to trigger it (§10 for the drain deadline).
- **Cache backend down:** reads/writes are best-effort — requests serve uncached
  and errors are logged (rate-limited per operation), never surfaced as `500`s.

## 16. App-layer responsibilities

A few things the framework deliberately cannot decide for you:

- **`dangerouslySetInnerHTML` and `metadata.head` emit raw HTML** — never pass
  unsanitized user/CMS content to them.
- **Middleware matchers see the locale-stripped path.** Under `i18n`, a
  `matcher: "/admin/:path*"` fires for `/fr/admin/x` as well as `/admin/x` (the
  matcher is tested against the path with the locale prefix removed, as in
  Next.js), so a locale prefix can never route around a path-restricted
  middleware. `ctx.locale` / `req.nextUrl.locale` carry the peeled locale.
- **Bound request sizes and rate-limit at your edge/proxy** — denext caps action
  bodies and image sources, but a proxy-level limit and rate limiting are still
  the right place for broad DoS protection (§1).

**Run production with least privilege.** The `dev`/`build` tasks use `-A`
because they bundle; `denext start` serves prebuilt output and never needs
`--allow-run`. The `start` task `denext create` writes is the least-privilege
set, and it is what the Docker image runs:

```sh
deno run --allow-net --allow-read --allow-env --allow-write=.denext jsr:@denext/denext/cli start .
```

`--allow-write=.denext` is not optional if you want the cache to survive a
restart: the durable `node:sqlite` store (the default) lives at
`.denext/cache.db`, and without the grant denext falls back to the per-process
memory store — it logs one line at boot naming the path and the grant, and
`/_denext/health` reports `"cacheStore": "memory"` (§13). Point the grant at the
directory of `cache.path` instead if you moved the file. `dev`/`build`/`export`
re-exec a child bundler; that child inherits the parent's actual grants instead
of a blanket `-A`, so narrowing the parent narrows the child too.
