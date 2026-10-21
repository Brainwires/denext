---
title: Supervised services
slug: services
lead: Long-lived server work — a queue consumer, a change-feed tail, a socket to an upstream — under a supervisor that restarts it with backoff when it crashes, gives up on a crash loop, and stops it in reverse order on shutdown. Inspired by Erlang/OTP supervisors; restart semantics, not process isolation.
---

A route handler answers a request and is done. Some server work has no request: it starts with the
server and should run until the server stops. When it throws, somebody has to notice, wait a
moment, and start it again — and stop retrying when it is clearly broken. That somebody is a
**supervisor**.

```ts
// services/orders-consumer.ts
import { defineService } from "denext/server";

export default defineService({
  async start({ signal }) {
    const queue = await connectQueue({ signal });
    for await (const message of queue.read({ signal })) {
      await handle(message); // a throw here is a crash: the supervisor restarts the service
    }
  },
});
```

Put a service in `services/<name>.ts` and `denext dev` / `denext start` run it under one root
supervisor named `services`. Nothing else to configure.

## What this is, and what it is not

Supervision here borrows the _shape_ of Erlang/OTP supervisors: children started in order,
restart strategies, a restart intensity that escalates a crash loop, ordered shutdown. It does
**not** borrow the BEAM's runtime, and the difference matters:

- **No preemption.** Every service runs on the app's one JavaScript event loop. A service that
  computes for two seconds without awaiting blocks every request, every other service and the
  supervisor itself for those two seconds. A BEAM scheduler would have preempted it.
- **No memory isolation.** Services share the heap with the app. A leak in one grows the whole
  process; a service that corrupts shared module state corrupts it for everyone. A BEAM process
  has its own heap and dies alone.
- **One bad await can still block the loop.** A synchronous `while (true)`, a blocking FFI call or
  a huge `JSON.parse` cannot be interrupted, timed out or restarted — the supervisor's own timers
  never get to run. Restarting only works for work that _ends_: by rejecting, by returning, or by
  honouring its `AbortSignal`.
- **A stop is cooperative.** Stopping aborts the service's `signal` and calls its `stop()`. A
  service that ignores both is abandoned after `shutdownMs` (logged) — its promise is forgotten,
  not killed, and whatever it still holds stays held until the process exits.
- **Not a cluster.** A supervisor supervises work in its own process. Several replicas each run
  their own `services/` tree; there is no distribution, no global registry, no hot code upgrade.

For isolation, run the work out of process — a [sidecar](/docs/desktop#desktop-sidecars) on Deno
Desktop, or a separate deployment — and supervise _that_ (below). This is denext's own API; it is
not "OTP for JavaScript".

## Define a service

```ts
import { defineService } from "denext/server";

export default defineService({
  name: "ticker", // optional: defaults to the file's path under services/
  restart: "crash", // "always" | "crash" (default) | "never"
  shutdownMs: 5_000, // how long a stop may take before it is abandoned
  async start(ctx) {
    // ctx.name     "services/ticker" — its path in the tree
    // ctx.signal   aborted when it is being stopped
    // ctx.stopped  resolves when ctx.signal aborts
    // ctx.attempt  1, then 2 after the first restart, …
    // ctx.fail(e)  report a crash from a callback (an error event, a socket's close)
    const socket = openUpstream();
    socket.onclose = () => ctx.fail(new Error("upstream closed"));
    await ctx.stopped; // hold the resource until the service is stopped
    socket.close();
  },
  stop() {
    // optional: anything the signal cannot reach
  },
});
```

**The `start` promise is the service's life.** Resolving is a clean exit; rejecting (or throwing,
synchronously too) is a crash. A service that only holds something open awaits `ctx.stopped`.

**Restart policies.** `"crash"` (the default) restarts after a crash and leaves a clean exit
stopped; `"always"` restarts after either; `"never"` leaves the child `failed` or `stopped`. A
clean exit restarted under `"always"` counts toward the intensity like a crash.

## Supervisors

`supervise({ children, strategy, intensity, period })` builds a supervisor. Nest one as a child of
another, or export one from a `services/` file to give part of the tree its own policy:

```ts
// services/ingest.ts — the fetcher feeds the writer, so a writer crash restarts both
import { defineService, supervise } from "denext/server";

const writer = defineService({ name: "writer", start: runWriter });
const fetcher = defineService({ name: "fetcher", start: runFetcher });

export default supervise({
  children: [writer, fetcher], // started in this order, stopped in reverse
  strategy: "rest_for_one",
  intensity: 5, // at most 5 restarts …
  period: 10_000, // … within 10 s
  backoff: { initialMs: 200, maxMs: 30_000, jitter: 0.2 },
});
```

| Option       | Default                             | Meaning                                                                                     |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `strategy`   | `"one_for_one"`                     | which children restart when one crashes (below)                                             |
| `intensity`  | `3`                                 | restarts (all children together) allowed within `period`; one more and the supervisor fails |
| `period`     | `5000`                              | the intensity window, in **milliseconds** (OTP counts seconds)                              |
| `backoff`    | 100 ms doubling to 30 s, 20% jitter | the wait before a child starts again                                                        |
| `restart`    | `"crash"`                           | when nested: whether its parent restarts it after it failed                                 |
| `shutdownMs` | `30000`                             | when nested: how long its parent waits for it to stop                                       |
| `onError`    | —                                   | at the top of the tree: called with the `SupervisorError` when it gives up                  |
| `log`        | the default log                     | `false` silences its events; a function receives them instead                               |

**Strategies.**

- `one_for_one` — restart only the crashed child.
- `one_for_all` — stop every other child (last-started first), then restart them all in start
  order. For children that cannot run without each other.
- `rest_for_one` — stop and restart the crashed child and every child started _after_ it. For a
  pipeline where later children depend on earlier ones.

A sibling with `restart: "never"` that a group restart stopped stays stopped.

**Backoff.** A child waits `initialMs × factor^(n-1)` before its n-th restart within `period`,
capped at `maxMs`, less a random share of up to `jitter` (so children that crashed together do not
retry together). `jitter: 0` makes the delays exact. A run that outlives `period` starts the count
again.

**Intensity and escalation.** More than `intensity` restarts within `period` is a crash loop. The
supervisor stops all its children (reverse order), enters `failed`, and:

- **nested** — its parent sees it as a crashed child and applies _its_ strategy and intensity: a
  restart of the nested supervisor starts its children afresh;
- **at the top** — it reports a `SupervisorError` to its `onError`, to `instrumentation.ts`'s
  `onServiceError` hook, and to the log, and the `services` health check turns `down`. A failed top
  level stays failed until something calls `start()` again.

```ts
// instrumentation.ts
export function onServiceError(error: unknown, context: { path: string }) {
  Sentry.captureException(error, { tags: { supervisor: context.path } });
}
```

## Shutdown and the server drain

On `SIGINT` / `SIGTERM` (on Windows: Ctrl-C, Ctrl-Break, or the Ctrl-C a service wrapper sends to
stop it) the server stops accepting connections and waits for in-flight requests to finish
(bounded by the drain deadline). **Then** every supervisor stops — the `services/` tree and
any your code started — last-started first, each child in reverse start order: its `signal`
aborts, its `stop()` runs, and the supervisor waits up to its `shutdownMs`. Plugin teardowns run
after that, so a service can still use a database pool a plugin owns while it stops. A request
that was in flight when shutdown began therefore still finds its services running.

`instrumentation.ts`'s `onShutdown()` runs last. Once the drain is done, the process exits by the
drain deadline (`DENEXT_SHUTDOWN_DRAIN_MS`, counted from the signal) even if a handle nothing
closed keeps it alive — a service abandoned after its `shutdownMs`, an app-owned pool, a timer —
and warns which held it. See [Graceful shutdown](/docs/deploy#10-graceful-shutdown).

## Supervising what denext already runs

- **Jobs.** `jobService("consume")` runs a `jobs/consume.ts` job whose handler is a long-running
  loop as a service: its handler's `signal` aborts on stop, and a throw (after the job's own
  `retry`, if any) is a crash.
- **Sidecars (Deno Desktop).** `sidecarService(app.sidecar("api"))` wraps a sidecar handle. The
  sidecar keeps its own restart-with-backoff; once it gives up (`failed`), the supervisor counts a
  crash and its restart starts the sidecar again with a fresh attempt count. Both use the same
  backoff helper.

```ts
// desktop.ts
const app = await runDesktop({/* … */});
await supervise({ name: "desktop", children: [sidecarService(app.sidecar("api"))] }).start();
```

- **Live subscriptions.** `defineSubscription({ …, restart: true })` restarts a recompute whose
  resolver threw, with backoff (default: 5 restarts a minute, 250 ms doubling to 10 s), instead of
  leaving the subscription on a `failed` frame until its next invalidation. The socket stays open,
  the client keeps its last value and sees no `failed` frame while a restart is pending; past
  `maxRestarts` within `period` the client gets `failed` as before. A denied, not-found or
  redirecting resolver is never restarted. Off by default.
- **Channel publishers.** `createChannel({ …, publisher })` runs a producer per active key: started
  when the key gets its first subscriber on this instance, its `signal` aborted when the last one
  leaves. A throw restarts it with backoff (`publisherRestart`, same defaults); the subscribers
  stay connected throughout.

```ts
export const prices = createChannel<{ price: number }>({
  authorize: () => true,
  publisher: async ({ key, signal, publish }) => {
    for await (const tick of upstreamFeed(key, { signal })) await publish({ price: tick.price });
  },
});
```

## Status, health and logs

- **`supervisionStatus()`** (from `denext/server`) returns every started top-level supervisor with
  its children: `state` (`running`, `restarting`, `stopping`, `stopped`, `failed`), `restarts`,
  `lastError` (message and time), `retryAt` while restarting. `supervisor.status()` and
  `supervisor.onStatus(fn)` give one tree.
- **Health.** With a `services/` tree, `/_denext/health` carries a `services` check: `down` (and
  the probe `503`) once the tree has given up.
- **`denext ui`** has a Services page: the `services/` files and the status a running `denext dev`
  / `denext start` last wrote to `.denext/services.json` (the UI never runs project code, so it
  reads the file).
- **Logs.** Crashes, restarts (with the delay) and give-ups are always logged; starts, stops and
  clean exits only with `DENEXT_LOG` set. `DENEXT_LOG=json` prints one JSON object per line —
  `{ "level": "warn", "msg": "supervision", "event": "restart", "path": "services/queue",
  "restarts": 2, "delayMs": 200 }` — like the request log.

## Starting a supervisor yourself

`services/` is the convention; any code can build a tree and start it — from `instrumentation.ts`'s
`register()`, a plugin, a test. A started top-level supervisor is registered for
`supervisionStatus()` and stopped by the server drain.

```ts
import { defineService, supervise } from "denext/server";

const tree = supervise({ name: "workers", children: [defineService({ start: work })] });
await tree.start();
// …
await tree.stop(); // reverse order, each within its shutdownMs
```

Every module under `services/` is found, at any depth, and named by its path without the
extension (`services/reports/daily.ts` is `reports/daily`). An entry whose path _below_
`services/` has a segment starting with `_` or `.` is skipped (`_shared/`, `_helper.ts`,
`.cache/`), so helpers can live beside the services; directories above `services/` never count,
so a project checked out under a `.apps/` or `_work/` directory keeps its services. Like `jobs/`,
the directory is
discovered once at boot: an edited service takes a dev-server restart. SPA mode has no server
boot, so it runs no `services/`. A
[single binary from `denext build --compile`](/docs/deployment-targets#a-single-binary-with-denext-build---compile)
embeds the `services/` tree and runs it the same way; its `services.json` status snapshot goes to
the binary's state directory.
