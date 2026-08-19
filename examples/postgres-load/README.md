# denext × Postgres under load

DATABASE.md says of networked databases: _"these drivers are not part of denext's
CI — validate your driver + pooling under your load."_ This example **is** that
validation, made runnable. It's a denext app backed by a real **Postgres**
connection pool (`jsr:@db/postgres`, zero npm), plus a load harness that hammers it
and reports throughput and latency percentiles.

The lesson it demonstrates: with a bounded pool (`POOL_SIZE=10`) and concurrency
far above it (say 100), requests **queue for a free connection** instead of opening
an unbounded number of connections and exhausting Postgres — so latency stays
bounded and no request errors out.

## Run it

```sh
cd examples/postgres-load
cp .env.example .env         # DATABASE_URL + POOL_SIZE

deno task db:up              # start Postgres in Docker (or point .env anywhere)
deno task start              # build + serve on http://localhost:3005
```

Open <http://localhost:3005> — the homepage reads the live count from Postgres on
every request and lets you record a visit with a plain `<form>` (works with no
client JS). Then, in another terminal, apply load:

```sh
# 5000 requests, 100 concurrent, against POOL_SIZE=10
CONCURRENCY=100 REQUESTS=5000 deno task load
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

- **Shrink the pool.** Set `POOL_SIZE=2` in `.env`, restart, and re-run the load.
  Throughput drops and p99 latency climbs (more queueing) — but it should still
  reach `5000/5000 ok`. That is the pool doing its job: bounding connections, not
  dropping work.
- **Turn up concurrency.** `CONCURRENCY=500`. The pool still caps Postgres
  connections at `POOL_SIZE`; the extra 490 virtual users wait in `pool.connect()`.
- **Add a denext concurrency ceiling.** Pair this with `maxConcurrency` on the prod
  server (see `examples/concurrency` and DEPLOYMENT.md) to add HTTP-level
  backpressure in front of the pool.

## How it's built

| File                   | Role                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `lib/db.ts`            | The Postgres **pool singleton** + `withClient` (borrow → run → release). |
| `app/page.tsx`         | A `force-dynamic` Server Component that reads the DB every request.      |
| `app/actions.ts`       | A `"use server"` write, wired to the homepage form (no-JS friendly).     |
| `app/api/hit/route.ts` | The write+count endpoint the load harness targets.                       |
| `load.ts`              | The **reusable** concurrent load harness (worker pool + percentiles).    |

`load.ts` is deliberately generic — a task is just `(i) => Promise<boolean>` — so
its throughput/percentile logic is unit-tested in denext's CI
(`tests/postgres-load.test.ts`) against in-process tasks, with **no database
required**. The Postgres integration is what you run here, with a real database.

## Notes

- The driver (`jsr:@db/postgres`) is standard Deno usage; swap in `npm:postgres`,
  `npm:mysql2`, or any other by editing `lib/db.ts`. Keep the pool a module
  singleton.
- `deno task db:down` stops Postgres and deletes its volume.
- This is the multi-instance counterpart to [`examples/notes`](../notes) (which uses
  zero-npm `node:sqlite` for the single-process case). See
  [DATABASE.md](../../DATABASE.md) for the full decision guide.
