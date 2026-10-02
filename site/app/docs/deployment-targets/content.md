---
title: Deployment targets
slug: deployment-targets
lead: Where a denext app runs, in one table, then a stanza per target with the one or two facts that platform needs — the port, the health probe, the drain, the disk. Two popular hosts are not targets; the table says why.
---

`denext build` writes `.denext/`; `denext start` serves it with `Deno.serve`.
Anything that can run a Deno process can run that. The differences between
targets are operational — who terminates TLS, whether the disk persists, how the
process is told to stop — and those are the columns below. The
[deployment guide](/docs/deploy) has the full Docker, Deno Deploy and systemd
recipes; this page is the map.

| Target                                                           | Runs                                      | Persistent disk                         | Notes                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| [Docker](#docker)                                                | the image `denext generate docker` writes | if you mount a volume on `/app/.denext` | the reference target; everything below that takes a container starts here    |
| [Deno Deploy](#deno-deploy)                                      | `deno` on the platform's isolates         | **no**                                  | `Deno.cron` for tasks, `BroadcastChannel` for Live; memory cache per isolate |
| [systemd / VPS](#systemd--vps)                                   | `deno run … jsr:@denext/denext/cli start` | yes                                     | nginx/Caddy in front for TLS and the connection ceiling                      |
| [Fly.io](#flyio)                                                 | the Docker image                          | a Fly volume, optional                  | `PORT` from `fly.toml`; health checks on `/_denext/health`                   |
| [Railway](#railway)                                              | the Docker image                          | a Railway volume, optional              | injects `PORT`; deploys on push                                              |
| [Kubernetes](#kubernetes)                                        | the Docker image                          | a PVC, optional                         | probes, `terminationGracePeriodSeconds` vs the drain deadline                |
| [Static hosts](#static-hosts)                                    | `denext export` output, no server         | n/a                                     | any CDN or object store; no SSR, no route handlers                           |
| [Cloudflare Workers](#not-targets-cloudflare-workers-and-vercel) | —                                         | —                                       | **not a target**: workerd is not Deno                                        |
| [Vercel](#not-targets-cloudflare-workers-and-vercel)             | —                                         | —                                       | **not a target**: no Deno runtime for the server build                       |
| [`deno compile`](#a-single-binary-with-deno-compile)             | —                                         | —                                       | **not a documented target** for SSR; see the stanza                          |

## Docker

```sh
denext generate docker   # Dockerfile + docker-compose.yml + .dockerignore
docker build -t my-app . && docker run -p 3000:3000 -e SESSION_SECRET=… my-app
```

The generated image builds in the image, runs as the unprivileged `deno` user,
starts with the least-privilege flags
(`--allow-net --allow-read --allow-env --allow-write=.denext`) and declares a
`HEALTHCHECK` on `/_denext/health`. Two things to decide: mount a volume on
`/app/.denext` if you want the ISR cache and task history to outlive the
container (they are regenerable — losing them costs a cold cache, not data), and
put your app database (`app.db`, `auth.db`) on a volume too, because those are
**not** regenerable. Every managed-container platform below starts from this
image. Full recipe: [Deployment › Docker](/docs/deploy#docker).

## Deno Deploy

Point the entrypoint at `jsr:@denext/denext@^2/cli` with `start .` (or run
`deno task
build` in a build step). What the platform changes:

- **No persistent disk**: the cache is per-isolate memory (`/_denext/health`
  reports `"cacheStore": "memory"`), task history is a fragment that resets when
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

Recipe: [Deployment › Deno Deploy](/docs/deploy#deno-deploy).

## systemd / VPS

A unit that runs
`deno run --allow-net --allow-read --allow-env --allow-write=.denext
jsr:@denext/denext@^2/cli start .`
with `Restart=always`, `Environment=PORT=3000` and the secrets;
`deno task build` in the deploy step, then `systemctl restart my-app`. Front it
with nginx or Caddy for TLS and the connection ceiling. For a zero-downtime
restart run two units on two ports and switch the upstream, or accept the drain
window (below). Recipe:
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
s default) or lower the drain, or a slow request is cut mid-flight. Attach a
volume at `/app/.denext` only if you want a warm cache across deploys; a second
machine is a second node (see [multi-instance](/docs/multi-instance)).

## Railway

Railway builds the Dockerfile it finds and injects `PORT`, which `denext start`
reads automatically (`--port` would override it). Set `SESSION_SECRET`,
`DENEXT_CANONICAL_ORIGIN` (your Railway domain or custom domain) and
`DENEXT_LOG=json` as service variables; set the service's health check path to
`/_denext/health`. Railway's proxy terminates TLS and forwards the scheme;
`canonicalOrigin` makes that irrelevant. A volume mounted at `/app/.denext`
keeps the cache warm; replicas beyond one are separate nodes.

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
  degraded (reads fall back to live renders), so it is a liveness probe. For
  readiness with app-level logic, expose `cacheStoreHealthy()` and your own
  database ping on a route
  ([Health & readiness](/docs/deploy#13-health--readiness)).
- **Drain.** On `SIGTERM` denext stops accepting and drains in-flight requests
  up to `DENEXT_SHUTDOWN_DRAIN_MS`, then force-exits. Keep it **below**
  `terminationGracePeriodSeconds` and above your longest request. A `preStop`
  sleep of a few seconds lets the endpoint slice stop routing to the pod before
  the drain starts.
- **Replicas.** Two pods are two nodes: shared cache/session/rate-limit stores,
  one task runner (a `CronJob` running `denext task <name>` is the
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

Both are the reason the roadmap carries a **deploy adapter API** — a typed build
manifest (routes, prerenders, assets, cache rules) plus a pluggable adapter seam
with first-party presets for the Deno-fit targets (static, Deno Deploy, Node
under `deno` compat, Docker) and a documented third-party seam for Workers and
Vercel. It is a larger, separate bet; see
[ROADMAP.md](https://github.com/Brainwires/denext/blob/main/ROADMAP.md).

## Zero-downtime and rolling restarts

A denext process gives an orchestrator the two signals it needs: a health
endpoint that goes away only when the process does, and a drain on `SIGTERM`
bounded by `DENEXT_SHUTDOWN_DRAIN_MS` (10 s default; `0` waits forever; the
force-exit skips plugin teardown). The rolling recipe is the same everywhere:

1. Start the new version; wait for `/_denext/health` to answer `200`.
2. Shift traffic (the balancer, the endpoint slice, the upstream).
3. Send the old version `SIGTERM`; it finishes what it has, up to the deadline.
4. Only then reclaim it — the orchestrator's grace period must exceed the drain
   deadline.

Live WebSockets are closed the moment shutdown begins (they would otherwise
never drain); the client reconnects to whichever instance is now routed, without
replay — pass a cold-start `initial` for anything that must not flicker. During
the overlap window two builds serve at once; each page links the content-hashed
chunks of the build that rendered it, so the mix is safe as long as the old
image keeps serving until it has drained.

## A single binary with `deno compile`

Not a documented target, and the honest answer has two parts.

The **`denext` executable** (a `deno compile`d CLI) never builds or serves an
app in its own process: every module-loading verb — `dev`, `build`, `start`,
`task`, `doctor` — re-execs the denext version the _project_ pins, as a
`deno run` child, so a binary can never substitute its own framework for the one
in your `deno.json`. That is the skew rule in `src/cli/self-exec.ts`: the
project's pin decides, an unversioned `jsr:@denext/denext` is a pin to latest, a
directory with no pin is refused with a message naming the fix. The consequence
is that the binary needs a reachable `deno` for those verbs — it is a
convenience front end, not a self-contained server
([Known limitations](/docs/limitations)).

Compiling **your app** with `deno compile` into one SSR binary is not something
denext tests or documents. `denext start` loads route modules from `.denext/` at
runtime and serves static assets from disk, both of which would have to be
embedded with `--include`, and the CSS import-map re-exec the CLI performs for a
project that imports CSS is exactly what a standalone binary cannot do (it
warns, and `import "./globals.css"` fails). If you want one artifact to ship,
the supported shapes are the Docker image (one artifact, batteries included) and
the [desktop packager](/docs/desktop), which compiles a _static export_ plus a
native window — not an SSR server.

See also: [Production checklist](/docs/production-checklist),
[Deployment](/docs/deploy), [Multi-instance](/docs/multi-instance),
[Environment variables](/docs/environment).
