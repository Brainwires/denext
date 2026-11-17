# denext × Postgres under load

denext's own Postgres client (`postgresClient()` from `denext/server`, on
`Deno.SQL`) runs in denext's CI; a third-party driver and its pool are yours to
validate under your load (see the
[database guide](https://denext.dev/docs/database)). This example does that for
one driver. It's a denext app backed by a real **Postgres** connection pool
(`jsr:@db/postgres`, zero npm), plus a load harness that sends it concurrent
requests and reports throughput and latency percentiles.

The lesson it demonstrates: with a bounded pool (`POOL_SIZE=10`) and concurrency
far above it (say 100), requests **queue for a free connection** instead of
opening an unbounded number of connections and exhausting Postgres — so latency
stays bounded and no request errors out.

## Run it

Needs Docker with Compose (for `db:up`), or any Postgres you point
`DATABASE_URL` at. From the repo root:

```sh
cd examples/postgres-load
cp .env.example .env           # the tasks load it with --env-file=.env

denext task db:up              # start Postgres 16 in Docker (or point .env anywhere)
                               # it publishes 127.0.0.1:5432 — this machine only
denext task build              # build the app
denext task start              # serve on http://localhost:3005
```

`denext task dev` serves the same app in dev mode on the same port.

| Variable       | Read by     | What it is                                                                            |
| -------------- | ----------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL` | the app     | Required. Postgres URL; `.env.example` matches `docker-compose.yml`.                  |
| `POOL_SIZE`    | the app     | Connections in the pool (default `10`).                                               |
| `CONCURRENCY`  | `load` task | Requests in flight at once (default `50`).                                            |
| `REQUESTS`     | `load` task | Total requests (default `2000`).                                                      |
| `TARGET_URL`   | `load` task | Endpoint to POST to (default `http://localhost:3005/api/hit`; a first argument wins). |

Open <http://localhost:3005> — the homepage reads the live count from Postgres
on every request and lets you record a visit with a plain `<form>` (works with
no client JS). Then, in another terminal, apply load:

```sh
# 5000 requests, 100 concurrent, against POOL_SIZE=10
CONCURRENCY=100 REQUESTS=5000 denext task load
```

```
  load: 5000 POSTs @ concurrency 100  ▸  http://localhost:3005/api/hit

  requests   5000/5000 ok
  wall       ...
  throughput ... req/s
  latency    min ...  p50 ...  p90 ...  p99 ...  max ... ms

  PASS — every request succeeded; the pool absorbed the concurrency.
```

## What to try

- **Shrink the pool.** Set `POOL_SIZE=2` in `.env`, restart, and re-run the
  load. Throughput drops and p99 latency climbs (more queueing) — but it should
  still reach `5000/5000 ok`. That is the pool doing its job: bounding
  connections, not dropping work.
- **Turn up concurrency.** `CONCURRENCY=500`. The pool still caps Postgres
  connections at `POOL_SIZE`; the extra 490 virtual users wait in
  `pool.connect()`.
- **Add a denext concurrency ceiling.** Pair this with `maxConcurrency` on the
  prod server (see `examples/concurrency` and the
  [deployment guide](https://denext.dev/docs/deploy)) to add HTTP-level
  backpressure in front of the pool.

## How it's built

| File                   | Role                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `lib/db.ts`            | The Postgres **pool singleton** + `withClient` (borrow → run → release). |
| `app/page.tsx`         | A `force-dynamic` Server Component that reads the DB every request.      |
| `app/actions.ts`       | A `"use server"` write, wired to the homepage form (no-JS friendly).     |
| `app/api/hit/route.ts` | The write+count endpoint the load harness targets.                       |
| `load.ts`              | The **reusable** concurrent load harness (worker pool + percentiles).    |

`load.ts` is deliberately generic — a task is just `(i) => Promise<boolean>` —
so its throughput/percentile logic is unit-tested in denext's CI
(`tests/postgres-load.test.ts`) against in-process tasks, with **no database
required**. The Postgres integration is what you run here, with a real database.

## Notes

- The driver (`jsr:@db/postgres`) is standard Deno usage; swap in
  `postgresClient()` from `denext/server`, `npm:postgres`, `npm:mysql2`, or any
  other by editing `lib/db.ts`. Keep the pool a module singleton.
- `denext task db:down` stops Postgres and deletes its volume.
- This is the multi-instance counterpart to [`examples/notes`](../notes) (which
  uses zero-npm `node:sqlite` for the single-process case). See
  [the database guide](https://denext.dev/docs/database) for the full decision
  guide.
