// The hazard an older generated `jobs/migrate.ts` poses now that migration files carry a
// `-- migrate:down` section: it ran each SQLite file whole, so a migration would apply and at
// once undo itself. End to end on node:sqlite: the job loader's guard refuses to run that runner
// while a file holds a down script (and lets it run when none does), and `denext generate
// migration` replaces the old runner with one that applies only the up sections.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { generateArtifact } from "../src/build/generate.ts";
import { discoverJobs } from "../src/server/job-loader.ts";
import { runJob } from "../src/server/jobs.ts";
import {
  filesWithDownScripts,
  guardLegacyMigrateJob,
  isLegacyMigrateJob,
} from "../src/server/legacy-migrate-job.ts";
import { defineJob } from "../src/server/jobs.ts";

const SERVER_MOD = new URL("../src/server/mod.ts", import.meta.url).href;
const LEGACY = await Deno.readTextFile(
  new URL("./fixtures/legacy-migrate-job.ts.txt", import.meta.url),
);

/** The job's source with `denext/server` pointed at this checkout (as an app's import map does). */
const runnable = (source: string) => source.replace('"denext/server"', JSON.stringify(SERVER_MOD));

const UP_DOWN =
  "-- migrate:up\nCREATE TABLE notes (id INTEGER);\n-- migrate:down\nDROP TABLE notes;\n";

function tables(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
    ).all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
}

async function withDbPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const before = Deno.env.get("DB_PATH");
  const url = Deno.env.get("DATABASE_URL");
  Deno.env.set("DB_PATH", path);
  Deno.env.delete("DATABASE_URL");
  try {
    return await fn();
  } finally {
    before === undefined ? Deno.env.delete("DB_PATH") : Deno.env.set("DB_PATH", before);
    if (url !== undefined) Deno.env.set("DATABASE_URL", url);
  }
}

Deno.test("isLegacyMigrateJob / filesWithDownScripts", async () => {
  assert(isLegacyMigrateJob(LEGACY));
  assert(!isLegacyMigrateJob(LEGACY.replace("import {", "import { migrateSqlite,")));
  assert(!isLegacyMigrateJob("export default defineJob({ handler() {} });"), "hand-written");
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await filesWithDownScripts(join(dir, "none")), []);
    await Deno.writeTextFile(join(dir, "1_a.sql"), "CREATE TABLE a (id INTEGER);");
    await Deno.writeTextFile(join(dir, "2_b.sql"), UP_DOWN);
    await Deno.writeTextFile(join(dir, "3_c.sql"), "CREATE TABLE c (id INTEGER);");
    await Deno.writeTextFile(join(dir, "3_c.down.sql"), "DROP TABLE c;");
    assertEquals(await filesWithDownScripts(dir), ["2_b.sql", "3_c.down.sql"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the guard is skipped on the old runner's Postgres path and for other jobs", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "1_a.sql"), UP_DOWN);
    const job = defineJob({ handler: () => "ran" });
    const signal = new AbortController().signal;
    const ctx = {
      name: "migrate",
      trigger: "manual" as const,
      signal,
      attempt: 1,
      payload: undefined,
    };
    assertEquals(guardLegacyMigrateJob(job, "hand-written", dir), job);
    const guarded = guardLegacyMigrateJob(job, LEGACY, dir);
    const url = Deno.env.get("DATABASE_URL");
    Deno.env.set("DATABASE_URL", "postgres://u@h/db");
    try {
      assertEquals(await guarded.handler(ctx), "ran");
    } finally {
      url === undefined ? Deno.env.delete("DATABASE_URL") : Deno.env.set("DATABASE_URL", url);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "an old generated jobs/migrate.ts refuses down scripts; generate migration replaces it",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "dnx-legacy-migrate-" });
  const db = join(dir, "app.db");
  try {
    await Deno.mkdir(join(dir, "jobs"));
    await Deno.mkdir(join(dir, "migrations"));
    await Deno.writeTextFile(join(dir, "jobs", "migrate.ts"), runnable(LEGACY));
    await Deno.writeTextFile(
      join(dir, "migrations", "20260101000000_plain.sql"),
      "CREATE TABLE plain (id INTEGER);",
    );
    await withDbPath(db, async () => {
      // No down scripts yet: the old runner is allowed to run.
      assertEquals(await discoverJobs(join(dir, "jobs")), ["migrate"]);
      assertEquals(await runJob("migrate"), "applied 20260101000000_plain.sql");
      // A migration with a down section: the old runner would CREATE then DROP. Refused.
      await Deno.writeTextFile(join(dir, "migrations", "20260102000000_notes.sql"), UP_DOWN);
      await discoverJobs(join(dir, "jobs"));
      const error = await assertRejects(() => runJob("migrate"), Error, "Refusing");
      assertStringIncludes(error.message, "20260102000000_notes.sql");
      assertStringIncludes(error.message, "denext generate migration");
      assertEquals(tables(db), ["plain"], "nothing ran");
    });
    // `denext generate migration` replaces the old runner (no --force needed).
    const result = await generateArtifact(dir, "migration", "more");
    assert(result.written.includes(join(dir, "jobs", "migrate.ts")), result.written.join("\n"));
    const fresh = await Deno.readTextFile(join(dir, "jobs", "migrate.ts"));
    assert(!isLegacyMigrateJob(fresh));
    await Deno.writeTextFile(join(dir, "jobs", "migrate.ts"), runnable(fresh));
    // A current runner, and a hand-written one, are left alone.
    const runner = join(dir, "jobs", "migrate.ts");
    assert(!(await generateArtifact(dir, "migration", "again")).written.includes(runner));
    const custom = join(dir, "custom");
    await Deno.mkdir(join(custom, "jobs"), { recursive: true });
    await Deno.writeTextFile(join(custom, "jobs", "migrate.ts"), "// my own runner\n");
    assert(
      !(await generateArtifact(custom, "migration", "x")).written.includes(
        join(custom, "jobs", "migrate.ts"),
      ),
    );
    // A fresh module URL (this process already imported the old runner from jobs/migrate.ts).
    const next = join(dir, "next");
    await Deno.mkdir(join(next, "jobs"), { recursive: true });
    await Deno.rename(join(dir, "migrations"), join(next, "migrations"));
    await Deno.rename(join(dir, "jobs", "migrate.ts"), join(next, "jobs", "migrate.ts"));
    await withDbPath(db, async () => {
      await discoverJobs(join(next, "jobs"));
      const applied = String(await runJob("migrate"));
      assertStringIncludes(applied, "20260102000000_notes.sql");
      // The up sections ran, the down sections did not: notes is there.
      assertEquals(tables(db), ["example", "notes", "plain"]);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

void toFileUrl;
