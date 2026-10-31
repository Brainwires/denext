---
title: Deployment targets
slug: deployment-targets
lead: Where a denext app runs, in one table, then a stanza per target with the one or two facts that platform needs — the port, the health probe, the drain, the disk. Two popular hosts are not targets; the table says why.
---

`denext build` writes `.denext/`; `denext start` serves it with `Deno.serve`.
Anything that can run a Deno process can run that. `denext deploy prepare --preset <name>` writes a target's files for you
([deploy adapters](/docs/deploy#deploy-adapters)). The differences between
targets are operational — who terminates TLS, whether the disk persists, how the
process is told to stop — and those are the columns below. The
[deployment guide](/docs/deploy) has the full Docker, Deno Deploy and systemd
recipes; this page is the map.

| Target                                                                   | Runs                                       | Persistent disk                                                        | Notes                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Docker](#docker)                                                        | the image `denext generate docker` writes  | if you mount a volume on a data dir (`/data`), never on `/app/.denext` | the reference target; everything below that takes a container starts here   |
| [Deno Deploy](#deno-deploy)                                              | `deno` on the platform's isolates          | **no**                                                                 | `Deno.cron` for jobs, `BroadcastChannel` for Live; memory cache per isolate |
| [systemd / VPS](#systemd--vps)                                           | `deno run … jsr:@denext/denext/cli start`  | yes                                                                    | nginx/Caddy in front for TLS and the connection ceiling                     |
| [Fly.io](#flyio)                                                         | the Docker image                           | a Fly volume, optional                                                 | `PORT` from `fly.toml`; health checks on `/_denext/health`                  |
| [Railway](#railway)                                                      | the Docker image                           | a Railway volume, optional                                             | injects `PORT`; deploys on push                                             |
| [Kubernetes](#kubernetes)                                                | the Docker image                           | a PVC, optional                                                        | probes, `terminationGracePeriodSeconds` vs the drain deadline               |
| [Static hosts](#static-hosts)                                            | `denext export` output, no server          | n/a                                                                    | any CDN or object store; no SSR, no route handlers                          |
| [Cloudflare Workers](#not-targets-cloudflare-workers-and-vercel)         | —                                          | —                                                                      | **not a target**: workerd is not Deno                                       |
| [Vercel](#not-targets-cloudflare-workers-and-vercel)                     | —                                          | —                                                                      | **not a target**: no Deno runtime for the server build                      |
| [`denext build --compile`](#a-single-binary-with-denext-build---compile) | one executable: `./app` (also `job`, `db`) | the working directory (`./.denext`)                                    | `deno compile` targets; Docker-baseline `--allow-*`; no `.env` embedded     |

## Docker

```sh
denext generate docker   # Dockerfile + docker-compose.yml + .dockerignore
docker build -t my-app . && docker run -p 3000:3000 -e SESSION_SECRET=… my-app
# or the whole stack the project needs (Postgres, MinIO, migrations) behind docker compose:
denext generate docker --stack && cp .env.example .env && docker compose up -d --build
```

The generated image builds in the image, runs as the unprivileged `deno` user,
starts with the least-privilege flags
(`--allow-net --allow-read --allow-env --allow-write=.denext`) and declares a
`HEALTHCHECK` on `/_denext/health`.

**Persistent state goes on a data volume, never on `/app/.denext`.** `/app/.denext` holds the
build the image was made with (`manifest.json`, the client bundles, the server copies); a volume
mounted there hides it. A Fly or Railway volume starts empty, so the server finds no build; a
Docker named volume is filled from the first image and then keeps serving that old build after
every redeploy. At run time `denext start` writes only three things there, all regenerable: the
ISR / data cache (`cache.db`), the job history (`jobs.db`, when `jobs.history` is on) and the
services snapshot (`services.json`). To keep the cache across containers, mount a volume on a
separate directory such as `/data`, point `cache: { path: "/data/cache.db" }` at it in
`denext.config.ts`, and add the directory to the `start` task's grant
(`--allow-write=.denext,/data`). Put your app database (`app.db`, `auth.db`) there too: unlike the
cache it is **not** regenerable. A shared job history needs `jobs.history: { store }` (e.g.
`postgresJobHistoryStore`). A `build --compile` binary moves all of its state at once with
`DENEXT_STATE_DIR=/data`; that variable applies only to a compiled app. Every managed-container platform below starts from this
image. Full recipe: [Deployment › Docker](/docs/deploy#docker); the compose stack with a
database, an object store and a migrations step:
[Deployment › Self-hosted stack](/docs/deploy#self-hosted-stack-postgres-storage-migrations).

## Deno Deploy

Point the entrypoint at `jsr:@denext/denext@^4.0.0/cli` with `start .` (or run
`deno task build` in a build step). What the platform changes:

- **No persistent disk**: the cache is per-isolate memory (`/_denext/health`
  reports `"cacheStore": "memory"`), job history is a fragment that resets when
  the isolate cycles, and a SQLite file does not survive. Use a hosted database,
  and a shared `CacheStore` if you need cross-isolate caching
  ([multi-instance](/docs/multi-instance)).
- **`Deno.cron` is present**, so schedules run on the platform's managed
  scheduler — once per deployment rather than once per isolate.
- **`BroadcastChannel` spans the deployment's isolates**, so
  `broadcastChannelTransport()` is the Live transport to install there.
- Set `SESSION_SECRET` and the other variables in the project's environment
  settings — there is no `.env` on disk
  ([Environment › Deno Deploy](/docs/environment#deno-deploy-and-other-platforms)).
- TLS and autoscaling are the platform's; still set `maxConcurrency` per
  isolate.
- The platform runs stock Deno, which has no `Deno.SQL`: give `@denext/backend`
  and your own code a postgres.js client
  (`fromPostgresJs(postgres(url))`, [Databases › Postgres](/docs/database#postgres)).

Recipe: [Deployment › Deno Deploy](/docs/deploy#deno-deploy).

## systemd / VPS

A unit that runs
`deno run --allow-net --allow-read --allow-env --allow-write=.denext
jsr:@denext/denext@^4.0.0/cli start .`
with `Restart=always`, `Environment=PORT=3000` and the secrets;
`denext task build` (or `deno task build`) in the deploy step, then `systemctl restart my-app`. Front it
with nginx or Caddy for TLS and the connection ceiling. For a zero-downtime
restart run two units on two ports and switch the upstream, or accept the drain
window (below). A `Deno.SQL` Postgres client needs the unit's `deno` to be denext's
toolchain (`denext toolchain path`). Long-lived work in `services/` runs inside this one
process under [a supervisor](/docs/services), so the unit's restart policy only has to cover
the server. Recipe:
[Deployment › Self-host](/docs/deploy#self-host-systemd).

## Fly.io

Deploy the Docker image; Fly sets `PORT` (declare `internal_port` to match, 3000
in the generated image) and terminates TLS. Point its HTTP health check at
`/_denext/health`:

```toml
# fly.toml
[http_service]
  internal_port = 3000
  force_https = true
  [[http_service.checks]]
    interval = "15s"
    timeout = "3s"
    method = "GET"
    path = "/_denext/health"

[env]
  DENEXT_CANONICAL_ORIGIN = "https://my-app.fly.dev"
  DENEXT_LOG = "json"
```

Fly's proxy sets `X-Forwarded-Proto`, so either pin `canonicalOrigin` (above,
preferred) or set `DENEXT_TRUST_PROXY=1`. Secrets go through
`fly secrets set SESSION_SECRET=…`. Fly sends `SIGTERM` and waits its
`kill_timeout` (5 s by default) — raise it above `DENEXT_SHUTDOWN_DRAIN_MS` (10
s default) or lower the drain, or a slow request is cut mid-flight. For a warm
cache across deploys, attach a Fly volume at a data directory such as `/data` (never at
`/app/.denext`, which would hide the image's build; see [Docker](#docker)) and set
`cache.path` there; a second machine is a second node (see [multi-instance](/docs/multi-instance)).

## Railway

Railway builds the Dockerfile it finds and injects `PORT`, which `denext start`
reads automatically (`--port` would override it). Set `SESSION_SECRET`,
`DENEXT_CANONICAL_ORIGIN` (your Railway domain or custom domain) and
`DENEXT_LOG=json` as service variables; set the service's health check path to
`/_denext/health`. Railway's proxy terminates TLS and forwards the scheme;
`canonicalOrigin` makes that irrelevant. A volume mounted at a data directory
such as `/data` (with `cache.path` pointing there; never at `/app/.denext`, see
[Docker](#docker)) keeps the cache warm; replicas beyond one are separate nodes.

## Kubernetes

The Docker image, plus three settings that map directly onto denext's built-ins:

```yaml
containers:
  - name: app
    image: my-app
    ports: [{ containerPort: 3000 }]
    env:
      - { name: DENEXT_LOG, value: json }
      - { name: DENEXT_SHUTDOWN_DRAIN_MS, value: "20000" }
      - { name: DENEXT_CANONICAL_ORIGIN, value: https://example.com }
    livenessProbe:
      httpGet: { path: /_denext/health, port: 3000 }
      periodSeconds: 10
    readinessProbe:
      httpGet: { path: /_denext/health, port: 3000 }
      periodSeconds: 5
terminationGracePeriodSeconds: 30
```

- **Probes.** `/_denext/health` answers `200` even when the cache backend is
  degraded (reads fall back to live renders). A check registered with
  `registerHealthCheck()` (`@denext/backend` registers `database`) turns it into
  a `503` while that dependency is down, which is what a readiness probe wants;
  a liveness probe on the same path would then restart pods during a database
  outage, so point liveness at a route of your own if you register checks
  ([Health & readiness](/docs/deploy#13-health--readiness)).
- **Drain.** On `SIGTERM` denext stops accepting and drains in-flight requests
  up to `DENEXT_SHUTDOWN_DRAIN_MS`, then force-exits. Keep it **below**
  `terminationGracePeriodSeconds` and above your longest request. A `preStop`
  sleep of a few seconds lets the endpoint slice stop routing to the pod before
  the drain starts.
- **Replicas.** Two pods are two nodes: shared cache/session/rate-limit stores,
  one job runner (a `CronJob` running `denext job <name>` is the
  Kubernetes-native choice), and a Live transport if you use channels — the
  whole [multi-instance](/docs/multi-instance) page applies.

## Static hosts

`denext export .` writes `out/` — plain HTML with 0 KB of JavaScript on static
pages — which any CDN, object store or GitHub Pages serves. It is the right
target when every page is static at build time (this documentation site is
deployed that way). It has no server, so no route handlers, no Server Actions at
request time, no ISR; a mostly static site that needs one API route is a server
target with a CDN in front. Recipe:
[Deployment › Static export](/docs/deploy#static-export).

## Not targets: Cloudflare Workers and Vercel

**Cloudflare Workers** runs `workerd`, not Deno. denext's server relies on Deno
APIs — `Deno.serve`, `node:sqlite`, `Deno.env`, the filesystem the build output
lives on — and its build emits a Deno module graph, not a Workers bundle. Pages
Functions and the Workers static-assets binding can host a `denext export`, but
that is the static target, not SSR.

**Vercel** builds and runs Node.js (and its Edge runtime); there is no Deno
runtime for the server build, and the Next.js-specific deployment output (the
build output API) is not what `denext build` writes. A static `denext export`
deploys there like any static site.

Both can still be reached through the **deploy adapter seam**: `denext build` writes a typed
deploy manifest (routes and how each is served, assets and their cache headers, the server entry,
jobs, services, env, permissions), and an adapter turns it into a target's files. denext ships
presets for the Deno-fit targets — Docker, Fly.io, Deno Deploy, a generic host (systemd + a
reverse proxy) and static hosts — and a third-party adapter for Workers or Vercel plugs into the
same seam. See [Deployment › Deploy adapters](/docs/deploy#deploy-adapters).

## Zero-downtime and rolling restarts

A denext process gives an orchestrator the two signals it needs: a health
endpoint that goes away only when the process does, and a drain on `SIGTERM`
bounded by `DENEXT_SHUTDOWN_DRAIN_MS` (10 s default; `0` waits forever; the
force-exit skips plugin teardown). The process exits by that deadline even when
an open handle, such as an app's database pool, outlives the drain. Close such
resources in `instrumentation.ts`'s `onShutdown()` to exit sooner. The rolling recipe is the same everywhere:

1. Start the new version; wait for `/_denext/health` to answer `200`.
2. Shift traffic (the balancer, the endpoint slice, the upstream).
3. Send the old version `SIGTERM`; it finishes what it has, up to the deadline.
4. Only then reclaim it — the orchestrator's grace period must exceed the drain
   deadline.

Live WebSockets are closed the moment shutdown begins (they would otherwise
never drain); the client reconnects to whichever instance is now routed, without
replay — pass a cold-start `initial` for anything that must not flicker. During
the overlap window two builds serve at once; each page links the content-hashed
chunks of the build that rendered it, so the pages themselves mix safely as long
as the old image keeps serving until it has drained. Server Action ids are the
exception: they are salted per build, so a form rendered by one build posts ids
the other does not know. The overlap is safe for them too when every build is
made with the same `DENEXT_ACTION_ID_SECRET` (set where `denext build` runs, not
only at runtime: a build made without it generates its own secret, and a
runtime-only value is ignored with a warning). Without a shared secret, a tab
rendered by the old build that posts to the new one gets `409` with
`x-denext-action: unknown` and reloads itself once to pick the new ids up — the
submission it was making is lost. See
[Server Actions › Action ids](/docs/server-actions#action-ids-and-which-actions-are-exposed).

## Idle memory trim

A long-running server's resident memory after a load burst is mostly memory glibc's allocator
keeps after the JavaScript heap has let go of it. denext's Deno from runtime `3.0.0-rc.5` can hand
it back: once the event loop has gone a second without work, it runs a full V8 GC and then
`malloc_trim(0)`. denext turns that on for the production server only:

| Where                                                  | How                                          |
| ------------------------------------------------------ | -------------------------------------------- |
| `denext start`, when it starts the server process      | `DENO_UNSTABLE_IDLE_TRIM=1` in its env       |
| `denext build --compile`                               | `--unstable-idle-trim` baked into the binary |
| `denext generate docker`, the `docker` / `fly` presets | `ENV DENO_UNSTABLE_IDLE_TRIM=1` in the image |
| the `genericHost()` systemd unit                       | `Environment=DENO_UNSTABLE_IDLE_TRIM=1`      |

`denext dev`, tests, `denext job`, the desktop runtime and stock Deno never get it, and it does
anything on glibc Linux only (macOS, Windows and musl ignore it). `denext start` can set it only on
a process it starts itself (the switch onto the toolchain, a compiled `denext`'s run of the
project's pinned denext). A `start` task run straight on the toolchain (`denext task start`)
starts with whatever its environment says, so run it as `DENO_UNSTABLE_IDLE_TRIM=1 denext task
start` to get it there.

The trim runs between event loop polls, never while JavaScript runs, at most once per idle period,
never twice within 10 s, and after the first only when the resident memory has grown 16 MB since the
last one left it, so a server woken by its own timers is not collected over and over. A request
that arrives during a trim waits for it once: on `examples/hello` after a load burst the GC took
112-217 ms and `malloc_trim` 9-26 ms (up to about 240 ms); a small handler's trim takes 8-20 ms.
Measured on an 8-vCPU Linux host:

| Server           | Resident after a burst, off | After 3 s idle, on | After 30 s idle, off |
| ---------------- | --------------------------- | ------------------ | -------------------- |
| `examples/hello` | 541-652 MB                  | 172 MB             | 400-451 MB           |
| a plain handler  | 139-148 MB                  | 65 MB              | 139-148 MB           |

Throughput and p99 latency were unchanged within run-to-run noise. Turn it off with
`start: { idleTrim: false }` in `denext.config.ts`, or `DENEXT_IDLE_TRIM=0` in the environment of
`denext start` (or of the `build --compile` / `generate` run, since a generated file keeps what it
was written with); an image or unit already written takes `DENO_UNSTABLE_IDLE_TRIM=0`. The config's
value is read as evaluated: `denext start` and `generate docker` take what the last `denext build`
recorded in `.denext/deploy-manifest.json` (so `idleTrim: isProd ? false : true` works), and only
before a first build read the file's text, comments ignored. A `build --compile` binary has the
trim baked in, and a flag baked into a binary can't be removed when it runs, so
`DENEXT_IDLE_TRIM=0` in the binary's environment holds the trim off instead: the binary wakes its
event loop at half the idle delay (`DENO_IDLE_TRIM_DELAY_MS`, 1 s by default), so it is never idle
long enough to trim. `DENO_IDLE_TRIM_TRACE=1` prints one line per trim to stderr.

## Resource limits

`start: { limits }` in `denext.config.ts` caps the production server process, enforced by denext's
Deno from runtime `3.0.0-rc.2`. Each limit ends the whole process with its own exit code and one
line on stderr, for a supervisor (Docker's restart policy, systemd's `Restart=always`, Kubernetes)
to start it again:

```ts
export default {
  start: {
    limits: {
      memory: "384m", // the main thread's JavaScript heap (a number is megabytes; at least 32 MB)
      cpuSeconds: 86_400, // process CPU time, every thread, counted from the start
      deadlineSeconds: 604_800, // wall clock, idle included: a weekly restart
    },
  },
};
```

| Limit             | Runtime flag            | Exit code | Message                                    |
| ----------------- | ----------------------- | --------- | ------------------------------------------ |
| `memory`          | `--max-memory=<size>`   | 137       | `Memory limit exceeded (--max-memory)`     |
| `cpuSeconds`      | `--max-cpu-time=<secs>` | 152       | `CPU time limit exceeded (--max-cpu-time)` |
| `deadlineSeconds` | `--max-time=<secs>`     | 124       | `Time limit exceeded (--max-time)`         |

137 is how a shell reports an OOM-killed process, 152 is `RLIMIT_CPU`'s SIGXCPU and 124 is GNU
`timeout`'s, so supervisors read them as they read those. denext puts the flags where the
production server starts:

| Where                                                  | How                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| `denext start`, on the process that serves             | on that `deno run`, with `DENEXT_LIMITS_APPLIED`            |
| `denext build --compile`                               | baked into the binary, which enforces them as it runs       |
| `denext generate docker`, the `docker` / `fly` presets | on the `CMD`'s `deno run`, with `ENV DENEXT_LIMITS_APPLIED` |
| the `genericHost()` systemd unit                       | on `ExecStart`, with `Environment=DENEXT_LIMITS_APPLIED`    |

`denext dev` (where a limit would end the dev server), tests and `denext job` never get
them. A `start` task run straight on the toolchain (`denext task start`) re-runs itself once with
them when it has `--allow-run` for its own Deno; the least-privilege task has not, so it warns
instead: put the flags after `run` in the task, and set `DENEXT_LIMITS_APPLIED` to them
(space-separated) to say so.
On stock Deno (`DENEXT_DENO=stock`) or an older toolchain they are never passed (Deno would refuse
the flags), and `denext start` / `build --compile` warn that they are not applied. The Docker image
needs a start task that is a plain `deno run` line, and the fly preset warns when `memory` is not
below the machine's memory (the OOM killer would end the server first).

The config is read as the idle trim's is: what the last `denext build` recorded in
`.denext/deploy-manifest.json` (`server.limits`), and before a first build the literal values in the
config file. A generated file keeps the limits it was written with; regenerate after a change.

`denext start` may re-run itself before it serves: onto denext's Deno toolchain from stock Deno, a
compiled `denext` handing the project to its pinned version, a source checkout's CSS or module
config. Only the last process, the one that serves, runs with the flags; the ones before it hand
the limits down as data and run without them, so no CLI hop's `--max-time` ends before the
server's (leaving it running without its parent) and no hop's own CPU time or heap counts.
`DENEXT_LIMITS_APPLIED` is compared with the flags the serving process's runtime takes, and every
re-run sets it for its child, so a value left in the environment by another process, or written
before the limits changed, makes the server re-run with the current ones rather than be believed.
When the hop before the server may still re-run, the server re-runs once more to take them, which
costs one more short-lived `deno` start and one more waiting parent process. The serving process
removes both variables from its own environment, so nothing it starts inherits them.

### Compiled binaries: `job` and `db` run under the limits too

`build --compile` bakes the limits into the executable, and denort reads them only from the
binary's own metadata: it takes no `--max-*` flag at run time (every argument goes to the program)
and no variable that lifts or changes them. So `./app job <name>` and `./app db migrate` run under
the server's `memory`, `cpuSeconds` and `deadlineSeconds` as well, and a long migration or job past
them ends with the limit's exit code. Those verbs print a notice naming the baked flags. Run long
jobs and migrations with `denext job` / `denext db` from the project, or from a second binary
compiled without `start.limits`.

These are best-effort guardrails, not a security boundary: subprocesses are neither counted nor
stopped, a `Worker` has its own heap (cap it with `new Worker(url, { deno: { memoryMb } })`), memory
outside the JavaScript heap is not counted, and sampling can overshoot by a 20 ms tick.

## Crash reports

denext's Deno from runtime `3.0.0-denext.5` can report its own crashes. Set
`DENEXT_CRASH_REPORT_URL` in the server's environment and, when the CLI or a compiled program
(`denort`) panics, it sends one JSON report (`schema: 2`) there: an `https:` endpoint gets one
POST (waited on for about 5 s at most, no retries, the answer ignored) and a
`file:///absolute/path.jsonl` gets one line appended. Reports are off while the variable is unset;
`http:`, a `file://` URL with a host and a value that is not a URL turn them off with one warning.
The fields, what is never sent (the environment, the command line, the working directory, host and
user names, addresses, JavaScript source) and what is not covered (the `--max-memory` exit 137,
SIGKILL, a native crash outside Rust) are in the
[runtime reference](/docs/runtime-reference#crashes-and-process-exit).

The URL is read when the process starts, from the environment only: no config key, build flag or
deploy-manifest field takes it, because such a URL often carries an ingest token and builds, images
and manifests get copied around. So it goes where the rest of the server's secrets go:

| Where                                      | How                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `denext generate docker` / `denext stack`  | `DENEXT_CRASH_REPORT_URL=` in `.env` (listed, empty, in `.env.example`) |
| the `genericHost()` systemd unit           | a line in the unit's `EnvironmentFile`                                  |
| `denext build --compile`                   | the binary's environment when it runs                                   |
| `denext start`, `denext job`, `denext dev` | the shell's environment, or `.env`                                      |

Each report carries an application name. denext's CLI hands `DENEXT_CRASH_REPORT_APP=denext@<version>`
to the Deno processes it re-runs itself on (the toolchain, a pinned denext, the CSS or module-config
and resource-limit re-runs), unless the variable is already set: set it yourself (up to 64 of
`A-Z a-z 0-9 @ . _ + / -`, for example `shop@2.3.1`) to name your app instead.

`denext doctor` checks a set URL: it warns on `http:` and on any URL the runtime would ignore, and
on stock Deno or an older runtime, which send no reports. `denext crash-report test` checks the
pipeline end to end: it runs the toolchain's `deno --version` with `DENEXT_CRASH_REPORT_SELFTEST=1`,
which panics on purpose just after start-up and sends one report with `kind: "selftest"`. For a
`file:` URL it prints the line that was written; for an endpoint, look for the report there.
Neither prints the URL's value.

## HTTPS without a proxy

`start: { tls }` in `denext.config.ts` makes `denext start` (and a `build --compile` server) serve
HTTPS itself, with no proxy in front. Each certificate lists the host names it serves, and names
the environment variables that hold the paths of its PEM certificate (chain) and private key
files; the paths never go in the config, so neither a key nor where it lives is committed:

```ts
export default {
  start: {
    tls: {
      certificates: [
        {
          hostnames: ["example.com", "www.example.com"],
          certFileEnv: "SITE_CERT",
          keyFileEnv: "SITE_KEY",
        },
        { hostnames: ["*.example.org"], certFileEnv: "ORG_CERT", keyFileEnv: "ORG_KEY" },
        { hostnames: ["*"], certFileEnv: "DEFAULT_CERT", keyFileEnv: "DEFAULT_KEY" },
      ],
    },
  },
};
```

```sh
SITE_CERT=/etc/ssl/site/fullchain.pem SITE_KEY=/etc/ssl/site/privkey.pem \
ORG_CERT=… ORG_KEY=… DEFAULT_CERT=… DEFAULT_KEY=… denext start --port 443
```

A host name is an exact name, a wildcard for one label (`*.example.org` serves `api.example.org`,
not `example.org` or `a.b.example.org`), or `"*"`: every name no other certificate lists, and a
client that sends no name at all (one connecting to an IP address). A handshake for a name nothing
matches is refused. The config validator rejects a malformed name, an environment variable name
that isn't one, and a name two certificates both list.

| Certificates | Runtime                                                                                |
| ------------ | -------------------------------------------------------------------------------------- |
| one          | any Deno: it is served for every name (`Deno.serve`'s `cert` / `key`)                  |
| several      | denext's Deno from runtime `3.0.0-denext.3`, with `"unstable": ["net"]` in `deno.json` |

Several certificates use the runtime's `resolveCertificate`, which picks one per connection by the
name the client asks for (SNI) and caches it per name. It is behind the unstable net APIs, so the
project's `deno.json` turns them on (`"unstable": ["net"]`), which every `deno` that runs the
server reads: `denext start` and a Docker image's or systemd unit's `deno run`; `denext build
--compile` bakes `--unstable-net` into the binary itself. On stock Deno, an older toolchain, or without the flag, the server
does not start and says which is missing, rather than serve one certificate for every name.

The files are read once, when the server starts: a variable that is unset or a file that can't be
read fails the start, and a renewed certificate takes a restart (a rolling one, as above). The
banner and `localServerOrigin()` say `https://`. `denext dev` never serves TLS.

### The generated deploy files

`denext generate docker`, `denext deploy prepare` and `denext build --compile` read `start.tls`
(from the last build's deploy manifest, `server.tls`; before a first build, the literal values in
`denext.config.ts`) and write what it needs. Each certificate's and key's variable is a
placeholder, never a value or a path of yours:

| Target                     | What `start.tls` changes                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate docker` / docker | `./certs` is mounted read-only at `/certs` and kept out of the image (`.dockerignore`); the variables are required in the compose file and listed empty in `.env.example` (set them to `/certs/…` paths); the `HEALTHCHECK` probes `https://localhost` without checking the certificate; a start task that scopes `--allow-read` gets `/certs` added |
| `genericHost()`            | the unit runs the server facing clients on every interface, default port 443 (`CAP_NET_BIND_SERVICE` below 1024), with no `DENEXT_TRUST_PROXY`; no `nginx.conf` or `Caddyfile` is written; `env.example` lists the variables, whose files the service user must read (or `LoadCredential=` hands a root-only key over, as the unit's comment shows)  |
| `fly()`                    | `fly.toml` passes TLS through as raw TCP on 443 (`[[services]]`, a TCP check) instead of Fly's HTTP proxy, and trusts no forwarded header                                                                                                                                                                                                            |
| `denoDeploy()`             | warns: the platform terminates TLS, and the server can't read the files there; leave `start.tls` out on Deno Deploy                                                                                                                                                                                                                                  |
| `build --compile`          | several certificates bake `--unstable-net` into the executable (the compile's own config carries no `unstable` from `deno.json`)                                                                                                                                                                                                                     |

The image's `CMD` and the unit's `ExecStart` run the start task's `deno run` from the project
directory, so `"unstable": ["net"]` in `deno.json` reaches them; with several certificates and
without it, the generators warn. With several certificates the Docker health probe's handshake
(server name `localhost`) needs a certificate that lists `"localhost"` or `"*"`; the generator
warns when none does. The static (SPA) image serves its files with Deno's std file server, which
`start.tls` doesn't reach (a warning says so).

## A single binary with `denext build --compile`

```sh
denext build --compile                                   # dist/<name> for this machine
denext build --compile --target x86_64-unknown-linux-gnu --output dist/my-app
scp dist/my-app server: && ssh server 'PORT=8080 ./my-app'
./my-app job cleanup --payload '{"days":7}'              # = denext job
./my-app db migrate                                      # = denext db migrate
```

`denext build --compile` builds the app, then runs `deno compile` on denext's
Deno toolchain over a generated entry (`.denext/compile/main.ts`) that does
what `denext start` does. The result is one executable with nothing to install
beside it. It embeds:

- the server modules (`app/`, the Pages Router's `pages/`, `denext.config.ts`, `middleware.ts`,
  `instrumentation.ts`, `jobs/`, `services/`, `functions/`), plus everything they import:
  the framework and your `jsr:` and `npm:` packages;
- the build's outputs in `.denext/` (client bundles, manifest, server copies, generated modules
  and the first-party plugins' outputs; an allow-list), `public/`, `migrations/` and
  `supabase/migrations/`. The rest of `.denext/` is development and run-time state and is not
  embedded; the build names any entry it doesn't know, which `compile.include` can add;
- any paths you list in `compile.include` (data files the app reads at run
  time, or a module that only a computed `import()` reaches).

**Dependencies resolve as your lockfile locks them.** The compile runs with its own config
(`.denext/compile/deno.json`), so it carries your project's lock and dependency-age rule into it:
it copies your `deno.lock` (or the file your `lock` setting names) beside that config, and Deno
resolves every locked specifier to the locked version and checks each package against the locked
integrity, as `denext build` does. A package that fails the integrity check fails the compile. What
the compile resolves that your lock does not list yet (the framework's standalone entry, say) is
recorded in your `deno.lock`; with `"lock": { "frozen": true }` the compile refuses instead,
listing the entries, and removes the binary. Your `minimumDependencyAge` and your `.npmrc` (its
`min-release-age` and registries) apply to the compile too; the `.npmrc` copy is never embedded.
With `"lock": false`, or no lockfile yet, the compile resolves without one, as your build does.

Stylesheet imports work without the CSS import map. Every module that reaches
a stylesheet is served through its build-time server copy, which imports the
stylesheet's JS shim instead of the `.css` file. Those copies are relocatable:
they import the project by relative paths and compute `import.meta.url`,
`.filename` and `.dirname` from their own location. So a copy works inside the
binary's embedded file system, and a `new URL("./data.txt", import.meta.url)`
in a component still finds the file beside it.

**Behaviour matches `denext start`.** The binary takes `--port`, else `$PORT`,
else 3000, plus `--host`. It drains on SIGTERM within
`DENEXT_SHUTDOWN_DRAIN_MS`. It reads `trustForwardedHeaders`, the cache and
every other config key from the embedded `denext.config.ts`, evaluated at
startup. It also sets the production signal (`DENEXT_ENV` / `NODE_ENV`). Each
verb (`start`, `job`, `db`) loads the production tier of the `.env` files in
the **working directory**.

**Nothing secret is baked in.** `.env*` files, `.npmrc` files, SQLite databases, database dumps
(`denext stack backup`'s) and `@denext/backend`'s dev key file are never embedded,
even from `compile.include`, and the environment is read at run time. What the binary writes goes
to the working directory:

- the page cache, the job history and `@denext/backend`'s storage metadata go
  under `./.denext` (`DENEXT_STATE_DIR` moves them);
- relative data paths (a SQLite `DB_PATH`, `fs({ dir })`, `app.db` in your own
  code) resolve against the working directory, not against the embedded
  project.

**Permissions are least-privilege.** By default the binary bakes the Docker
image's flags: `--allow-net --allow-env --allow-read --allow-write=.denext`,
with relative paths resolved against the working directory. Grant more in
`denext.config.ts`; each kind is unioned with the baseline:

```ts
export default {
  compile: {
    include: ["content/"],
    permissions: { write: ["app.db", ".storage"], sys: ["hostname"] }, // run / ffi too; "*" = unscoped
  },
};
```

`permissions: "all"` bakes `--allow-all`, and only when you ask for it. `denext build --compile`
prints the flags it baked.

**Scoping the network by direction.** denext's Deno (3.0.0-rc.2 and later) splits `--allow-net`
into `--allow-net-connect` (outbound: `fetch`, WebSocket, database clients) and
`--allow-net-listen` (`Deno.serve`, `Deno.listen`, `node:net` servers). Name either direction in
`compile.permissions` and the binary bakes the pair instead of `--allow-net`; an unset direction
stays unscoped (an empty list is a config error, since Deno would read it as unscoped too):

```ts
export default {
  compile: {
    permissions: {
      netListen: [":3000"], // the port the binary is deployed with (0.0.0.0, 127.0.0.1, localhost)
      netConnect: ["db.internal:5432", "api.example.com"], // or leave it unset: any host
    },
  },
};
```

The binary takes its port from `--port` / `$PORT` at run time, so denext does not narrow listen
unasked: list the port you deploy with, and a listener anywhere else (another port, a dependency's
own server) is refused. The split needs the toolchain compiling onto its own `denort`; on stock Deno
(`DENEXT_DENO=stock`), or for a target the toolchain has no `denort` for, the binary keeps
`--allow-net` and the build warns.

The generated deploy files scope listen for you, because they know the port: `denext generate
docker` (and the `docker()` / `fly()` adapters) turn the `start` command's `--allow-net` into
`--allow-net-connect --allow-net-listen=:<port>,[::]:<port>` (`0.0.0.0`, `[::]`, `127.0.0.1` and
`localhost` on that port), the static image's file server gets
`--allow-net-listen` for its port and no outbound access, and `genericHost()`'s systemd unit runs
`--allow-net-listen=127.0.0.1:<port>` (with `compile.permissions`' directions when you set them).
All of them run on denext's toolchain; a `start` task with `-A`, a scoped `--allow-net=<hosts>` or a
directional flag of its own is left as written. The deploy manifest carries the split as
`permissions.net` (`{ connect, listen }`, `["*"]` for an unscoped direction) for third-party
adapters.

### Signing the binary

```sh
export DENEXT_CODESIGN_IDENTITY="Developer ID Application: Example Inc (ABCDE12345)"
export DENEXT_NOTARY_PROFILE=denext            # or DENEXT_NOTARY_KEY + _KEY_ID + _ISSUER
denext build --compile --sign                  # signed, verified, notarized

export DENEXT_WINDOWS_CERT=certs/app.pfx DENEXT_WINDOWS_CERT_PASSWORD=...
denext build --compile --sign --target x86_64-pc-windows-msvc   # Authenticode, from any OS
```

`--sign` code-signs the binary after the compile, for the target it was built for. Set
`compile: { sign: true }` in `denext.config.ts` to sign every `--compile` build. The
difference is what happens when a credential or tool is missing: `--sign` fails with the
reason, and a configured `compile.sign` prints a warning and leaves the binary unsigned (a
developer machine without the certificate still builds).

**macOS** (signed on a Mac). The binary is signed as `DENEXT_CODESIGN_IDENTITY` with
`codesign --force --options runtime --timestamp --entitlements <plist>`, then checked with
`codesign --verify --strict`. The Hardened Runtime is what notarization requires, and under it
V8 needs one entitlement, `com.apple.security.cs.allow-jit`: on Apple Silicon it allocates its
code space with `MAP_JIT`, and without the entitlement the binary crashes at startup. A binary
whose `compile.permissions` grants `ffi` also gets `disable-library-validation`, because
`Deno.dlopen` and Node-API addons load libraries your Developer ID did not sign. Nothing else is
granted. To add keys, point `compile.sign.entitlements` (or `DENEXT_ENTITLEMENTS`) at a plist; a
key the plist sets, `false` included, wins. `DENEXT_CODESIGN_IDENTITY=-` signs ad-hoc with the same
Hardened Runtime and entitlements, which is useful for checking that the binary runs before you
have a certificate.

With notary credentials, the binary is zipped and submitted with `xcrun notarytool submit
--wait`. The credentials are a keychain profile (`DENEXT_NOTARY_PROFILE`, from `xcrun notarytool
store-credentials`) or an App Store Connect API key (`DENEXT_NOTARY_KEY`, the `.p8` path, plus
`DENEXT_NOTARY_KEY_ID` and, for a team key, `DENEXT_NOTARY_ISSUER`). A rejection fails the build
and names the submission, so `xcrun notarytool log <id>` shows why. Without credentials the
binary is signed but not notarized, and Gatekeeper blocks it when it is downloaded.
`compile.sign.notarize: true` makes notarization required and `false` skips it. **A bare
executable cannot be stapled** (stapler takes `.app`, `.dmg` and `.pkg` only), so Gatekeeper
checks the ticket online the first time the binary runs on a machine. If you ship to machines
that are offline at first launch, wrap the binary in a signed `.pkg` or `.dmg` and staple that.

**Windows** (`--target x86_64-pc-windows-msvc` or `aarch64-pc-windows-msvc`). The `.exe` is
Authenticode-signed with SHA-256 digests and an RFC-3161 timestamp (`DENEXT_SIGN_TIMESTAMP_URL`
or `compile.sign.timestampUrl`, DigiCert's by default). The certificate settings are the desktop
packager's: `DENEXT_WINDOWS_CERT` (a `.pfx`) with `DENEXT_WINDOWS_CERT_PASSWORD`, or
`DENEXT_WINDOWS_CERT_THUMBPRINT` for a certificate in the Windows certificate store. On Windows
it signs with `signtool` (Windows SDK). On macOS and Linux it signs with `osslsigncode` (`brew
install osslsigncode`, `apt install osslsigncode`), which reads the password from a private
temporary file, never from its command line; a store thumbprint needs `signtool`. `signtool`
takes a `.pfx` password only on its command line (`/p`), where a process listing or process
auditing (Sysmon, an EDR) would record it, so denext never passes it there: a
password-protected `.pfx` is imported into the user's certificate store (`CurrentUser\My`, its
key not exportable) by PowerShell, which reads the password from its standard input, signed with
by thumbprint, and removed again, key included, when signing ends or fails. A certificate the
store already held is left in place.

A Linux executable carries no OS signature, so `--sign` refuses a Linux target. Publish a
checksum, or a detached signature of the archive.

Credentials are read from the environment only. None are written to the project or printed, and
a failing command's message has the certificate password redacted. `denext doctor` reports the
signing readiness when `compile.sign` is set: the identity and whether the keychain holds it, the
notary credentials, the Windows certificate, and `signtool` / `osslsigncode`. The "Compiled
binary" tab of `denext ui`'s [Desktop panel](/docs/ui#desktop) shows the same.

**Cross-compiling** takes any `deno compile` target: `x86_64-unknown-linux-gnu`,
`aarch64-unknown-linux-gnu`, `x86_64-apple-darwin`, `aarch64-apple-darwin`,
`x86_64-pc-windows-msvc` or `aarch64-pc-windows-msvc` (Windows on Arm). The binary's
runtime is the `denort` of denext's [Deno toolchain](/docs/toolchain) for that
target (`2.9.7-denext.20` and later; Windows on Arm `2.9.7-denext.21` and later):
the same release as the CLI, pinned by SHA-256 in denext and downloaded into the
toolchain cache on first use, so the binary carries the toolchain's patches.
`Deno.SQL` is there (`postgresClient(url)` and `backend({ postgres: {} })` work
as under `denext start`). With `DENEXT_DENO=stock` (or another `deno` through
`DENEXT_DENO=<path>`), `deno compile` picks its own runtime, Deno's stock
`denort`, which has no `Deno.SQL`.

A compiled binary behaves as `denext start` does: its `request.signal` aborts
only when a response is not delivered, and it prints no `request.signal` notice
on its first request. That is the toolchain's default from `3.0.0-rc.5`; an
older toolchain compiles in `--unstable-no-legacy-abort` (kept from
`2.9.7-denext.21`).

**What does not compile:**

- a SPA (`mode: "spa"`), which has no server; ship it with `denext export` or
  the desktop packager;
- the build verbs: `dev`, `build` and `export` stay on the `denext` CLI.

A `next-compat` (drop-in) app and a Pages Router (`@denext/pages-router`) app compile like any
other: their pages, API routes and static assets are served from the binary. A Pages Router
build records its server copies as an App Router build does, so its pages take the web target's
platform files (`.web.tsx`), and `"use cache"` and inline `"use server"` functions work in the
binary as under `denext start`. A module served without a server copy (a Pages Router page)
imports its stylesheet through the compile's import map, whose stylesheet entries are relative to
the embedded config. A Pages Router app on npm React (the plugin's compat path) renders its pages
through the compat server bundles its build made and recorded (`.denext/pages-compat/`), which
`denext start` loads too instead of rebuilding them at startup; a binary from a build without
that record refuses to start and says to rebuild it.

A minimal app's binary is about 135 MB (macOS x86_64): about 118 MB is the toolchain's `denort`
runtime, and about 16 MB is embedded — your app, the build output, `public/` and the production
server's part of the framework. The binary embeds the module graph of what it runs, and that graph
holds none of the build pipeline: no esbuild, swc or lightningcss, and none of the build's npm
tooling (`sass`, `@mdx-js/mdx`, Babel, Prettier, …). Your own packages and your plugins' run-time
code are embedded as you import them. A plugin's build-step functions (`bundleRoutes`,
`buildAppCss`, `compileMdxSource`, `remixCodegen`, the next-compat build) are stand-ins inside
the binary that throw if called; a build step only runs at `denext build`. This holds for an app
on denext from JSR too: `denext task build --compile` runs the CLI the app pins, whose framework
URLs (`https://jsr.io/@denext/denext/<version>/…`) are the ones the binary's graph names.

The **`denext` executable** is a separate thing: the CLI itself, a
`deno compile`d front end. It never builds or serves an app in its own
process. Every module-loading verb (`dev`, `build`, `start`, `job`, `doctor`)
re-execs the denext version the _project_ pins, as a `deno run` child, so a
binary can never substitute its own framework for the one in your `deno.json`.
That is the skew rule in `src/cli/self-exec.ts`:

- the project's pin decides;
- an unversioned `jsr:@denext/denext` is a pin to latest;
- a directory with no pin is refused, with a message naming the fix.

That child runs on denext's own Deno toolchain, downloaded and SHA-256-verified
on first need, so no Deno install is required. Offline on first use, with no
toolchain cached, it needs a `deno` on PATH
([Known limitations](/docs/limitations)).

See also: [Production checklist](/docs/production-checklist),
[Deployment](/docs/deploy), [Multi-instance](/docs/multi-instance),
[Environment variables](/docs/environment).
