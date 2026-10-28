// Networked e2e for `denext migrate` on a Prisma app whose datasource is a database SERVER
// (Postgres, CockroachDB, MySQL): migrate a Node-shaped Next + Prisma app (tests/fixtures/prisma-server-db),
// run the `prisma:setup` task it writes (install → `prisma generate` → `prisma migrate deploy`
// of a real SQL migration), drive the migrated client against the live database (CRUD over
// JSON / Decimal / BigInt / Bytes / DateTime, relations, interactive + batch transactions,
// P2002, raw queries), then build and serve the app: a Server Component page reads through
// Prisma and a route handler writes through it.
//
// Opt-in: each database runs only when its URL is set, and the test OWNS that database (it
// drops the `users`, `posts` and `_prisma_migrations` tables first), so point it at a
// throwaway one:
//   DENEXT_E2E_POSTGRES_URL=postgres://u:p@host:5432/db
//   DENEXT_E2E_COCKROACH_URL=postgresql://root@host:26257/db?sslmode=disable
//   DENEXT_E2E_MYSQL_URL=mysql://u:p@host:3306/db
// (a throwaway CockroachDB: `docker run -d --rm -p 26257:26257 cockroachdb/cockroach:v25.2.4
// start-single-node --insecure`, then `CREATE DATABASE db`).
// NETWORK + CODEGEN-REQUIRED (npm installs and the Prisma CLI): `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import { startCliServer } from "./harness.ts";

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const CLI = join(REPO, "cli.ts");
const FIXTURE = join(REPO, "tests/fixtures/prisma-server-db");
const PRISMA = "npm:prisma@6.19.3";

const SETUP_TIMEOUT_MS = 300_000;
const STEP_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 120_000;

/** Run a command in `cwd` with `env` merged in; bounded (the harness's `runDeno` takes no env). */
async function run(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<{ ok: boolean; out: string; stdout: string }> {
  try {
    const { success, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args,
      cwd,
      env,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    const dec = new TextDecoder();
    const text = dec.decode(stdout);
    return { ok: success, out: text + dec.decode(stderr), stdout: text };
  } catch (e) {
    return { ok: false, out: `\`deno ${args.join(" ")}\` did not finish: ${e}`, stdout: "" };
  }
}

/** Copy the fixture, set its provider and write the initial SQL migration Prisma generates. */
async function prepareApp(provider: string, env: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: `denext-prisma-${provider}-` });
  await copy(FIXTURE, dir, { overwrite: true });
  const schemaPath = join(dir, "prisma/schema.prisma");
  let schema = (await Deno.readTextFile(schemaPath)).replace("__PROVIDER__", provider);
  // CockroachDB's autoincrement() is a 64-bit unique_rowid(), which Prisma allows on BigInt
  // only; an Int id takes a sequence there.
  if (provider === "cockroachdb") {
    schema = schema.replaceAll("@default(autoincrement())", "@default(sequence())");
  }
  await Deno.writeTextFile(schemaPath, schema);
  const diff = await run(
    ["run", "-A", "--no-config", PRISMA, "migrate", "diff", "--from-empty"]
      .concat(["--to-schema-datamodel", "prisma/schema.prisma", "--script"]),
    dir,
    env,
  );
  assert(diff.ok, "prisma migrate diff failed:\n" + diff.out);
  const migrationDir = join(dir, "prisma/migrations/0_init");
  await Deno.mkdir(migrationDir, { recursive: true });
  await Deno.writeTextFile(join(migrationDir, "migration.sql"), diff.stdout);
  await Deno.writeTextFile(
    join(dir, "prisma/migrations/migration_lock.toml"),
    `provider = "${provider}"\n`,
  );
  // Start from an empty database, so `migrate deploy` applies the migration.
  await Deno.writeTextFile(
    join(dir, "reset.sql"),
    "DROP TABLE IF EXISTS posts, users, _prisma_migrations;\n",
  );
  const reset = await run(
    ["run", "-A", "--no-config", PRISMA, "db", "execute", "--file", "reset.sql"]
      .concat(["--schema", "prisma/schema.prisma"]),
    dir,
    env,
  );
  assert(reset.ok, "resetting the database failed:\n" + reset.out);
  await Deno.remove(join(dir, "reset.sql"));
  return dir;
}

for (
  const [provider, urlVar, adapter] of [
    ["postgresql", "DENEXT_E2E_POSTGRES_URL", "@prisma/adapter-pg"],
    ["cockroachdb", "DENEXT_E2E_COCKROACH_URL", "@prisma/adapter-pg"],
    ["mysql", "DENEXT_E2E_MYSQL_URL", "@prisma/adapter-mariadb"],
  ] as const
) {
  const url = Deno.env.get(urlVar);
  Deno.test({
    name: `e2e: a migrated Prisma app runs on ${provider} through ${adapter}`,
    ignore: !url,
  }, async (t) => {
    const env = { DATABASE_URL: url!, PRISMA_PROVIDER: provider };
    const dir = await prepareApp(provider, env);
    try {
      await t.step("denext migrate wires the adapter", async () => {
        const migrated = await run(
          ["run", "-A", CLI, "migrate", ".", "--denext-local-path", REPO],
          dir,
          env,
        );
        assert(migrated.ok, "denext migrate failed:\n" + migrated.out);
        const db = await Deno.readTextFile(join(dir, "lib/db.ts"));
        assertStringIncludes(db, `from "${adapter}"`);
        assertStringIncludes(db, "new PrismaClient({ adapter: __denextPrismaAdapter() })");
      });

      await t.step("prisma:setup installs, generates and runs `migrate deploy`", async () => {
        const setup = await run(["task", "prisma:setup"], dir, env, SETUP_TIMEOUT_MS);
        assert(setup.ok, "prisma:setup failed:\n" + setup.out);
        assertStringIncludes(setup.out, "prisma migrate deploy");
        assertStringIncludes(setup.out, "0_init");
      });

      await t.step("CRUD, relations, transactions and raw queries", async () => {
        const checked = await run(["run", "-A", "scripts/check.ts"], dir, env);
        assert(checked.ok, "scripts/check.ts failed:\n" + checked.out);
        assertStringIncludes(checked.out, "PRISMA CHECK OK");
      });

      await t.step("build, serve, read through a page and write through a route", async () => {
        const built = await run(["run", "-A", CLI, "build", "."], dir, env, SETUP_TIMEOUT_MS);
        assert(built.ok, "denext build failed:\n" + built.out);
        Deno.env.set("DATABASE_URL", url!);
        const server = await startCliServer(dir, READY_TIMEOUT_MS);
        try {
          const html = await (await fetch(server.origin + "/")).text();
          assertStringIncludes(html, "Prisma on a database server");
          const posted = await fetch(server.origin + "/api/posts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "inserted-by-e2e" }),
          });
          assertEquals(posted.status, 201, await posted.text());
          const listed = await (await fetch(server.origin + "/api/posts")).json();
          assertEquals(listed, [{ title: "inserted-by-e2e", author: "Web" }]);
          const after = await (await fetch(server.origin + "/")).text();
          assertStringIncludes(after, "inserted-by-e2e");
        } finally {
          await server.close();
        }
      });
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
}
