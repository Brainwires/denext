// What realtime costs the write path: committed single-row INSERT transactions per second with
// no realtime, with the notify source (a trigger per row + pg_notify, a listener consuming), and
// with the logical source (no trigger; a pgoutput slot read concurrently, as each server
// instance reads its own). The NOTIFY queue is one lock taken at commit, so the notify source
// serializes committing transactions; the logical source only adds WAL decoding off the write path.
//
//   DENEXT_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5432/postgres \
//     deno run -A bench/realtime-source.ts [--seconds 10] [--writers 1,8,32] [--async-commit]
//
// Needs denext's Deno toolchain (Deno.SQL) and a server with wal_level = logical. Writes a
// throwaway database and role (dropped at the end). Prints a Markdown table.

import { postgresEnvironment } from "../tests/helpers/postgres-env.ts";
import { realtimeMigrations } from "../packages/backend/src/realtime-sql.ts";
import { migratePostgres } from "../src/server/postgres-migrate.ts";
import type { SqlClient } from "../src/server/postgres.ts";

/** `--name value` from the command line. */
function flag(name: string, fallback: string): string {
  const at = Deno.args.indexOf(`--${name}`);
  return at >= 0 && Deno.args[at + 1] ? Deno.args[at + 1] : fallback;
}
const args = {
  seconds: flag("seconds", "10"),
  writers: flag("writers", "1,8,32"),
  "async-commit": Deno.args.includes("--async-commit"),
};
const SECONDS = Number(args.seconds);
const WRITERS = String(args.writers).split(",").map(Number);
const SQL = (Deno as unknown as {
  SQL: new (url: string, options?: unknown) => SqlClient;
}).SQL;
const admin = Deno.env.get("DENEXT_TEST_POSTGRES_URL");
if (!admin || !SQL) {
  throw new Error(
    "set DENEXT_TEST_POSTGRES_URL; run on denext's Deno (Deno.SQL)",
  );
}

type Mode = "none" | "notify" | "logical";

async function setup(
  env: Awaited<ReturnType<typeof postgresEnvironment>>,
  mode: Mode,
) {
  await env.app.unsafe(
    "drop table if exists bench; create table bench (id bigserial primary key, n int)",
  )
    .simple!();
  if (mode === "notify") {
    // The trigger function and the table's trigger, exactly as backend({ realtime }) installs them.
    await migratePostgres(env.app, {
      migrations: realtimeMigrations({
        tables: { bench: {} },
        publication: false,
      }).filter((m) =>
        [
          "backend_realtime_0001",
          "backend_realtime_0002",
          "backend_realtime_0003",
        ].includes(m.name) ||
        m.name.startsWith("backend_realtime_t_")
      ),
      table: "backend_migrations",
    });
  }
  if (mode === "logical") {
    await env.app.unsafe(
      "drop publication if exists bench_pub; create publication bench_pub for table bench",
    )
      .simple!();
  }
}

/** Run writers for SECONDS; the commits/s, with the consumer `mode` needs running alongside. */
async function run(
  url: string,
  mode: Mode,
  writers: number,
  asyncCommit: boolean,
): Promise<number> {
  const sql = new SQL(url, { max: writers + 2 });
  let stop = false;
  let consumed = 0;
  const consumers: Promise<unknown>[] = [];
  let unlisten: (() => Promise<void>) | undefined;
  if (mode === "notify") {
    const listener = await sql.listen!(
      "denext_realtime",
      () => void consumed++,
    );
    unlisten = () => listener.unlisten();
  }
  if (mode === "logical") {
    const conn = await sql.reserve!() as SqlClient & { release(): void };
    await conn.unsafe(
      "select pg_create_logical_replication_slot('bench_slot', 'pgoutput', true)",
    );
    consumers.push((async () => {
      while (!stop) {
        const rows = await conn.unsafe(
          "select data from pg_logical_slot_get_binary_changes('bench_slot', NULL, 10000, " +
            "'proto_version', '1', 'publication_names', 'bench_pub')",
        );
        consumed += rows.length;
        if (rows.length < 10000) await new Promise((r) => setTimeout(r, 50));
      }
      await conn.unsafe("select pg_drop_replication_slot('bench_slot')");
      conn.release();
    })());
  }
  let commits = 0;
  const started = performance.now();
  const deadline = started + SECONDS * 1000;
  await Promise.all(
    Array.from({ length: writers }, async () => {
      const conn = await sql.reserve!() as SqlClient & { release(): void };
      if (asyncCommit) await conn.unsafe("set synchronous_commit = off");
      while (performance.now() < deadline) {
        await conn.unsafe("insert into bench (n) values (1)");
        commits++;
      }
      conn.release();
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  stop = true;
  await Promise.all(consumers);
  await unlisten?.();
  await sql.close();
  return commits / elapsed;
}

const env = await postgresEnvironment(true, SQL as never, admin);
try {
  await env.admin.unsafe(`alter role ${new URL(env.url).username} replication`);
  const [{ wal_level }] = await env.admin.unsafe<{ wal_level: string }>(
    "show wal_level",
  );
  const [{ version }] = await env.admin.unsafe<{ version: string }>(
    "select version()",
  );
  const results: Record<string, Record<number, number>> = {};
  for (const mode of ["none", "notify", "logical"] as Mode[]) {
    if (mode === "logical" && wal_level !== "logical") continue;
    await setup(env, mode);
    results[mode] = {};
    for (const writers of WRITERS) {
      results[mode][writers] = await run(
        env.url,
        mode,
        writers,
        args["async-commit"],
      );
      await env.app.unsafe("truncate bench");
    }
  }
  console.log(
    `\n${version.split(",")[0]}, wal_level=${wal_level}, ${SECONDS}s per cell, ` +
      `synchronous_commit=${args["async-commit"] ? "off" : "on"}\n`,
  );
  console.log(
    `| source | ${WRITERS.map((w) => `${w} writer${w > 1 ? "s" : ""}`).join(" | ")} |`,
  );
  console.log(`| --- | ${WRITERS.map(() => "---:").join(" | ")} |`);
  for (const [mode, row] of Object.entries(results)) {
    const base = results.none;
    console.log(
      `| ${mode} | ${
        WRITERS.map((w) =>
          `${Math.round(row[w])}/s${
            mode === "none" ? "" : ` (${Math.round((row[w] / base[w]) * 100)}%)`
          }`
        ).join(" | ")
      } |`,
    );
  }
} finally {
  await env.drop();
}
