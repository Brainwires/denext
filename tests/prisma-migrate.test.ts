// `denext migrate` — the Prisma auto-wiring path.
//
// A Prisma app can't run on denext with its default native client (Rust query engine), so
// migrate rewrites it to Prisma 6's ESM/Deno client (Rust-free query compiler) over the
// better-sqlite3 driver adapter: schema generator, `@prisma/client` imports, the adapter at
// each construction site, the deno.json links/imports/task, the patch package + setup script,
// and package.json cleanup. These tests drive a minimal Prisma app through migrateProject and
// assert the whole transform, the seed and test tooling included (they move to the Deno client
// with the app, the seed run by a `prisma:seed` task).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { migrateProject } from "../packages/migrate/src/migrate.ts";
import { readDatasource, wiredProvider } from "../packages/migrate/src/prisma-migrate.ts";
import { denoSqlHasColumns } from "../src/server/prisma-adapter/client.ts";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));

/** Write a minimal App-Router + Prisma app into a fresh temp dir; return its path. */
async function scaffoldPrismaApp(
  datasource = `provider = "sqlite"\n  url      = env("DATABASE_URL")`,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-prisma-" });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "prisma-app",
      dependencies: { "react": "^18.0.0", "react-dom": "^18.0.0", "@prisma/client": "^5.22.0" },
      devDependencies: { "prisma": "^5.22.0" },
      prisma: { seed: "tsx prisma/seed.ts" },
    }),
  );
  await Deno.mkdir(join(dir, "prisma"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "prisma", "schema.prisma"),
    `datasource db {\n  ${datasource}\n}\n\n` +
      `generator client {\n  provider = "prisma-client-js"\n}\n\n` +
      `model Note {\n  id Int @id @default(autoincrement())\n  title String\n}\n`,
  );
  // A runtime module that CONSTRUCTS the client (gets the adapter) …
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app", "db.server.ts"),
    `import { PrismaClient } from "@prisma/client";\nexport const prisma = new PrismaClient();\n`,
  );
  // … and a runtime module that only imports TYPES (import repointed, no adapter).
  await Deno.mkdir(join(dir, "app", "models"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app", "models", "note.server.ts"),
    `import type { Note } from "@prisma/client";\nexport type { Note };\n`,
  );
  // The seed and the test tooling — moved to the Deno client with the app.
  await Deno.writeTextFile(
    join(dir, "prisma", "seed.ts"),
    `import { PrismaClient } from "@prisma/client";\nnew PrismaClient();\n`,
  );
  await Deno.mkdir(join(dir, "tests", "setup"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "tests", "db-utils.ts"),
    `import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient({ log: [] });\n`,
  );
  await Deno.writeTextFile(
    join(dir, "tests", "setup", "fixtures.ts"),
    `import type { Note } from "@prisma/client";\nexport const note: Partial<Note> = {};\n`,
  );
  await Deno.writeTextFile(
    join(dir, "vitest.setup.ts"),
    `import { PrismaClient } from "@prisma/client";\nawait new PrismaClient().$connect();\n`,
  );
  // Tooling without Prisma is left alone.
  await Deno.writeTextFile(join(dir, "tests", "plain.test.ts"), `export const x = 1;\n`);
  return dir;
}

async function read(dir: string, rel: string): Promise<string> {
  return await Deno.readTextFile(join(dir, rel));
}

Deno.test("prisma migrate: detects Prisma and reports the wiring", async () => {
  const dir = await scaffoldPrismaApp();
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assert(r.prisma, "expected a prisma report");
  assertEquals(r.prisma.clientModules, ["app/db.server.ts"]);
  assertEquals(r.prisma.refsRewritten.sort(), ["app/db.server.ts", "app/models/note.server.ts"]);
  assert(r.prisma.packageJsonEdited, "package.json prisma deps should be dropped");
  assertEquals(r.prisma.setupTask, "prisma:setup");
  assertEquals(r.prisma.seedTask, "prisma:seed");
  assertEquals(r.prisma.toolingRewritten, [
    "prisma/seed.ts",
    "tests/db-utils.ts",
    "tests/setup/fixtures.ts",
    "vitest.setup.ts",
  ]);
  assertEquals(r.prisma.warnings, []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: schema generator → Rust-free Deno client", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const schema = await read(dir, "prisma/schema.prisma");
  assertStringIncludes(schema, `provider        = "prisma-client"`);
  assertStringIncludes(schema, `runtime         = "deno"`);
  assertStringIncludes(schema, `previewFeatures = ["queryCompiler", "driverAdapters"]`);
  // Datasource block preserved.
  assertStringIncludes(schema, `env("DATABASE_URL")`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: db module repointed + adapter injected exactly once", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const db = await read(dir, "app/db.server.ts");
  // Import repointed at the generated client, adapter imported + factory defined.
  assertStringIncludes(db, `from "../generated/client/client.ts"`);
  assertStringIncludes(db, `@prisma/adapter-better-sqlite3`);
  assert(!db.includes(`"@prisma/client"`), "the raw @prisma/client specifier should be gone");
  // The adapter is threaded in — exactly once (no double `adapter:`).
  assertStringIncludes(db, `new PrismaClient({ adapter: __denextPrismaAdapter() })`);
  assertEquals(db.match(/adapter: __denextPrismaAdapter\(\)/g)?.length, 1);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: type-only import repointed, no adapter injected", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const note = await read(dir, "app/models/note.server.ts");
  assertStringIncludes(note, `from "../../generated/client/client.ts"`);
  assert(!note.includes("__denextPrismaAdapter"), "a type-only module needs no adapter");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: the seed and test tooling move to the Deno client", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const seed = await read(dir, "prisma/seed.ts");
  assertStringIncludes(seed, `from "../generated/client/client.ts"`);
  assertStringIncludes(seed, "new PrismaClient({ adapter: __denextPrismaAdapter() })");
  const utils = await read(dir, "tests/db-utils.ts");
  assertStringIncludes(utils, `from "../generated/client/client.ts"`);
  // An options object keeps its fields, with the adapter merged in.
  assertStringIncludes(utils, "new PrismaClient({ adapter: __denextPrismaAdapter(), log: [] })");
  const fixtures = await read(dir, "tests/setup/fixtures.ts");
  assertStringIncludes(fixtures, `from "../../generated/client/client.ts"`);
  assert(!fixtures.includes("__denextPrismaAdapter"), "a type-only module needs no adapter");
  assertStringIncludes(await read(dir, "vitest.setup.ts"), `from "./generated/client/client.ts"`);
  assertEquals(await read(dir, "tests/plain.test.ts"), "export const x = 1;\n");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: the seed runs on Deno (task, package.json, prisma.config.ts)", async () => {
  const dir = await scaffoldPrismaApp();
  await Deno.writeTextFile(
    join(dir, "prisma.config.ts"),
    `export default { migrations: { seed: "tsx prisma/seed.ts" } };\n`,
  );
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const deno = JSON.parse(await read(dir, "deno.json")) as { tasks?: Record<string, string> };
  assertEquals(deno.tasks?.["prisma:seed"], "deno run -A prisma/seed.ts");
  const pkg = JSON.parse(await read(dir, "package.json")) as { prisma?: { seed?: string } };
  assertEquals(pkg.prisma?.seed, "deno run -A prisma/seed.ts", "`prisma db seed` runs it on Deno");
  assertStringIncludes(await read(dir, "prisma.config.ts"), `seed: "deno run -A prisma/seed.ts"`);
  // A second migrate leaves the seed stable (one adapter, the same command).
  const seed1 = await read(dir, "prisma/seed.ts");
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(await read(dir, "prisma/seed.ts"), seed1);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: a seed named only by its command is found", async () => {
  const dir = await scaffoldPrismaApp();
  await Deno.remove(join(dir, "prisma", "seed.ts"));
  await Deno.writeTextFile(
    join(dir, "other-seed.mts"),
    `import { PrismaClient } from "@prisma/client";\nnew PrismaClient();\n`,
  );
  const pkg = JSON.parse(await read(dir, "package.json"));
  pkg.prisma.seed = "node --loader ts-node/esm ./other-seed.mts";
  await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(pkg));
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assert(r.prisma?.toolingRewritten.includes("other-seed.mts"));
  const deno = JSON.parse(await read(dir, "deno.json")) as { tasks?: Record<string, string> };
  assertEquals(deno.tasks?.["prisma:seed"], "deno run -A other-seed.mts");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: deno.json wiring (manual + links + pins + task) and no better-sqlite3 alias", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const deno = JSON.parse(await read(dir, "deno.json")) as {
    nodeModulesDir?: string;
    links?: string[];
    tasks?: Record<string, string>;
    imports?: Record<string, string>;
  };
  assertEquals(deno.nodeModulesDir, "manual");
  assertEquals(deno.links, ["./patch/better-sqlite3"]);
  assert(deno.tasks?.["prisma:setup"], "a prisma:setup task should exist");
  assertStringIncludes(deno.imports?.["@prisma/client"] ?? "", "npm:@prisma/client@6");
  assertStringIncludes(
    deno.imports?.["@prisma/adapter-better-sqlite3"] ?? "",
    "npm:@prisma/adapter-better-sqlite3@6",
  );
  // The `better-sqlite3` alias is removed — it resolves via `links`, not the compat `.ts`.
  assert(!("better-sqlite3" in (deno.imports ?? {})), "better-sqlite3 alias must be dropped");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: emits the links patch package + setup script", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const patch = JSON.parse(await read(dir, "patch/better-sqlite3/package.json")) as {
    name?: string;
    main?: string;
  };
  assertEquals(patch.name, "better-sqlite3");
  assertEquals(patch.main, "index.mjs");
  const setup = await read(dir, "scripts/denext-prisma-setup.ts");
  assertStringIncludes(setup, "prisma generate");
  assertStringIncludes(setup, "db"); // db push
  assertStringIncludes(setup, "migrate", "SQL migrations are applied when the app has them");
  assertStringIncludes(setup, "6.19.3", "the Prisma line with a working query compiler");
  assertStringIncludes(setup, "--no-config"); // resolves the CLI from the global cache
  // package.json prisma deps removed.
  const pkg = JSON.parse(await read(dir, "package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert(!("@prisma/client" in (pkg.dependencies ?? {})));
  assert(!("prisma" in (pkg.devDependencies ?? {})));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: the emitted setup script type-checks on its own", async () => {
  // The script runs as `deno task prisma:setup` in the APP, with no denext module in scope: a
  // reference to a denext-internal helper (the migrate fs seam `mfs`) is a ReferenceError there.
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const script = join(dir, "scripts/denext-prisma-setup.ts");
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--no-config", "--quiet", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(out.stderr);
  assert(out.success, `deno check failed on the emitted setup script:\n${err}`);
  assert(!(await read(dir, "scripts/denext-prisma-setup.ts")).includes("mfs."));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: idempotent re-run leaves schema + db module stable", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const schema1 = await read(dir, "prisma/schema.prisma");
  const db1 = await read(dir, "app/db.server.ts");
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const schema2 = await read(dir, "prisma/schema.prisma");
  const db2 = await read(dir, "app/db.server.ts");
  assertEquals(schema1, schema2, "a second migrate must not re-rewrite the generator");
  assertEquals(db1, db2, "a second migrate must not re-inject the adapter (commit-parity)");
  // Belt and suspenders: exactly one adapter injection survives the re-run.
  assertEquals(db2.match(/adapter: __denextPrismaAdapter\(\)/g)?.length, 1);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: generated start task uses -A (it re-execs a child deno)", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const deno = JSON.parse(await read(dir, "deno.json")) as { tasks?: Record<string, string> };
  // `start` re-execs (CSS shim map + manual-node_modules module config), which spawns a
  // child deno — a scoped perm set crashes on the re-exec, so migrate emits `-A`.
  assertStringIncludes(deno.tasks?.start ?? "", "-A");
  await Deno.remove(dir, { recursive: true });
});

// ── Postgres / MySQL datasources: the database's own driver adapter, no `links` shim ──

const PG_DATASOURCE = `provider  = "postgresql"\n  url       = env("POSTGRES_PRISMA_URL")\n` +
  `  directUrl = env("POSTGRES_URL_NON_POOLING")`;

Deno.test("prisma migrate: a postgresql datasource gets @prisma/adapter-pg, no links shim", async () => {
  const dir = await scaffoldPrismaApp(PG_DATASOURCE);
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.provider, "postgresql");
  assertEquals(r.prisma?.adapter, "@prisma/adapter-pg");
  assertEquals(r.prisma?.clientModules, ["app/db.server.ts"]);
  assertEquals(r.prisma?.warnings, []);
  const db = await read(dir, "app/db.server.ts");
  assertStringIncludes(db, `import { PrismaPg as __PrismaPg } from "@prisma/adapter-pg";`);
  // The URL comes from the variable the datasource names, not a hard-coded DATABASE_URL.
  assertStringIncludes(db, `connectionString: Deno.env.get("POSTGRES_PRISMA_URL")`);
  assertStringIncludes(db, "new PrismaClient({ adapter: __denextPrismaAdapter() })");
  assert(!db.includes("better-sqlite3"), "no SQLite adapter for a Postgres datasource");
  assertStringIncludes(
    await read(dir, "tests/db-utils.ts"),
    "new PrismaClient({ adapter: __denextPrismaAdapter(), log: [] })",
  );
  const deno = JSON.parse(await read(dir, "deno.json")) as {
    nodeModulesDir?: string;
    links?: string[];
    imports?: Record<string, string>;
  };
  assertEquals(deno.nodeModulesDir, "manual");
  assertEquals(deno.links, undefined, "pg is pure JS: no `links` substitution");
  assertEquals(deno.imports?.["@prisma/adapter-pg"], "npm:@prisma/adapter-pg@6.19.3");
  assert(!("@prisma/adapter-better-sqlite3" in (deno.imports ?? {})));
  // No compat bundle: neither the patch package nor its bundle step.
  assert(!(await exists(join(dir, "patch/better-sqlite3/package.json"))));
  const setup = await read(dir, "scripts/denext-prisma-setup.ts");
  assert(!setup.includes("bundle the better-sqlite3 compat"));
  assertStringIncludes(setup, `const URL_VAR = "POSTGRES_PRISMA_URL";`);
  assertStringIncludes(setup, "migrate", "SQL migrations are applied with `migrate deploy`");
  // The schema's datasource (directUrl included) is left for the Prisma CLI.
  const schema = await read(dir, "prisma/schema.prisma");
  assertStringIncludes(schema, `directUrl = env("POSTGRES_URL_NON_POOLING")`);
  assertStringIncludes(schema, `runtime         = "deno"`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: the postgres setup script type-checks and stops without a URL", async () => {
  const dir = await scaffoldPrismaApp(PG_DATASOURCE);
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const script = join(dir, "scripts/denext-prisma-setup.ts");
  const checked = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--no-config", "--quiet", script],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(checked.success, new TextDecoder().decode(checked.stderr));
  const env = { ...Deno.env.toObject() };
  delete env.POSTGRES_PRISMA_URL;
  const ran = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-config", script],
    cwd: dir,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(!ran.success, "setup must refuse to run without the datasource URL");
  assertStringIncludes(new TextDecoder().decode(ran.stderr), "set POSTGRES_PRISMA_URL");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: `postgres` (Prisma's alias) wires the pg adapter too", async () => {
  const dir = await scaffoldPrismaApp(`provider = "postgres"\n  url = env("DATABASE_URL")`);
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.adapter, "@prisma/adapter-pg");
  assertStringIncludes(await read(dir, "app/db.server.ts"), `Deno.env.get("DATABASE_URL")`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: a cockroachdb datasource goes through the Postgres adapter path", async () => {
  const dir = await scaffoldPrismaApp(`provider = "cockroachdb"\n  url      = env("CRDB_URL")`);
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.provider, "cockroachdb");
  assertEquals(r.prisma?.adapter, "@prisma/adapter-pg");
  assertEquals(r.prisma?.warnings, []);
  const db = await read(dir, "app/db.server.ts");
  assertStringIncludes(db, `import { PrismaPg as __PrismaPg } from "@prisma/adapter-pg";`);
  assertStringIncludes(db, `connectionString: Deno.env.get("CRDB_URL")`);
  assertStringIncludes(db, "new PrismaClient({ adapter: __denextPrismaAdapter() })");
  const deno = JSON.parse(await read(dir, "deno.json")) as {
    links?: string[];
    imports?: Record<string, string>;
  };
  assertEquals(deno.links, undefined, "pg is pure JS: no `links` substitution");
  assertEquals(deno.imports?.["@prisma/adapter-pg"], "npm:@prisma/adapter-pg@6.19.3");
  assertStringIncludes(
    await read(dir, "scripts/denext-prisma-setup.ts"),
    `const URL_VAR = "CRDB_URL";`,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: a mysql datasource gets @prisma/adapter-mariadb", async () => {
  const dir = await scaffoldPrismaApp(`provider = "mysql"\n  url      = env("DATABASE_URL")`);
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.provider, "mysql");
  assertEquals(r.prisma?.adapter, "@prisma/adapter-mariadb");
  const db = await read(dir, "app/db.server.ts");
  assertStringIncludes(
    db,
    `import { PrismaMariaDb as __PrismaMariaDb } from "@prisma/adapter-mariadb";`,
  );
  assertStringIncludes(db, `new __PrismaMariaDb(Deno.env.get("DATABASE_URL") ?? "")`);
  const deno = JSON.parse(await read(dir, "deno.json")) as {
    links?: string[];
    imports?: Record<string, string>;
  };
  assertEquals(deno.links, undefined);
  assertEquals(deno.imports?.["@prisma/adapter-mariadb"], "npm:@prisma/adapter-mariadb@6.19.3");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: a sqlserver datasource gets @prisma/adapter-mssql", async () => {
  const dir = await scaffoldPrismaApp(`provider = "sqlserver"\n  url = env("MSSQL_URL")`);
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.provider, "sqlserver");
  assertEquals(r.prisma?.adapter, "@prisma/adapter-mssql");
  assertEquals(r.prisma?.clientModules, ["app/db.server.ts"]);
  assert(!r.prisma?.warnings.some((w) => w.includes("has no driver adapter")));
  const db = await read(dir, "app/db.server.ts");
  assertStringIncludes(db, `import { PrismaMssql as __PrismaMssql } from "@prisma/adapter-mssql";`);
  assertStringIncludes(db, `new __PrismaMssql(Deno.env.get("MSSQL_URL") ?? "")`);
  assertStringIncludes(db, "new PrismaClient({ adapter: __denextPrismaAdapter() })");
  const deno = await denoJson(dir);
  assertEquals((deno as { links?: string[] }).links, undefined);
  assertEquals(deno.imports?.["@prisma/adapter-mssql"], "npm:@prisma/adapter-mssql@6.19.3");
  assertStringIncludes(
    await read(dir, "scripts/denext-prisma-setup.ts"),
    `const URL_VAR = "MSSQL_URL";`,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate (deno-sql): SQL Server keeps its npm adapter", async () => {
  const dir = await scaffoldPrismaApp(`provider = "sqlserver"\n  url = env("DATABASE_URL")`);
  const r = await migrateProject(dir, DENO_SQL);
  assertEquals(r.prisma?.adapter, "@prisma/adapter-mssql");
  assert(!("denext/prisma-adapter" in ((await denoJson(dir)).imports ?? {})));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: an unwired provider keeps its constructions and says why", async () => {
  const dir = await scaffoldPrismaApp(`provider = "mongodb"\n  url = env("DATABASE_URL")`);
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.adapter, null);
  assertEquals(r.prisma?.clientModules, []);
  assert(r.prisma?.warnings.some((w) => w.includes(`"mongodb" has no driver adapter`)));
  const db = await read(dir, "app/db.server.ts");
  assertStringIncludes(db, "new PrismaClient()", "no SQLite adapter forced onto MongoDB");
  assert(!db.includes("__denextPrismaAdapter"));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: readDatasource / wiredProvider", () => {
  assertEquals(
    readDatasource(`datasource db {\n  provider = "postgresql"\n  url = env("PG_URL")\n}\n`),
    { provider: "postgresql", envVar: "PG_URL" },
  );
  assertEquals(
    readDatasource(`datasource db {\n  provider = "sqlite"\n  url = "file:./dev.db"\n}`),
    { provider: "sqlite", envVar: null },
  );
  assertEquals(readDatasource("model A { id Int @id }"), { provider: null, envVar: null });
  assertEquals(wiredProvider(null), "sqlite");
  assertEquals(wiredProvider("postgres"), "postgresql");
  assertEquals(wiredProvider("mysql"), "mysql");
  assertEquals(wiredProvider("sqlserver"), "sqlserver");
  assertEquals(wiredProvider("mongodb"), null);
  assertEquals(wiredProvider("cockroachdb"), "postgresql");
});

// ── denext/prisma-adapter (Deno.SQL): no npm driver, no links shim ──────────────────────

const DENO_SQL = { denextLocalPath: REPO_ROOT, prismaAdapter: "deno-sql" } as const;

/** The generated deno.json's import map, links and node_modules mode. */
async function denoJson(dir: string) {
  return JSON.parse(await read(dir, "deno.json")) as {
    nodeModulesDir?: string;
    links?: string[];
    imports?: Record<string, string>;
  };
}

Deno.test("prisma migrate (deno-sql): a SQLite app gets denext/prisma-adapter, no shim", async () => {
  const dir = await scaffoldPrismaApp();
  const r = await migrateProject(dir, DENO_SQL);
  assertEquals([r.prisma?.provider, r.prisma?.adapter], ["sqlite", "denext/prisma-adapter"]);
  assertEquals(r.prisma?.clientModules, ["app/db.server.ts"]);
  const db = await read(dir, "app/db.server.ts");
  assertStringIncludes(
    db,
    `import { PrismaDenoSql as __PrismaDenoSql } from "denext/prisma-adapter";`,
  );
  assertStringIncludes(
    db,
    "const __denextPrismaAdapter = () => new __PrismaDenoSql(__denextDbUrl);",
  );
  assertStringIncludes(db, "new PrismaClient({ adapter: __denextPrismaAdapter() })");
  assert(!db.includes("better-sqlite3"));
  const deno = await denoJson(dir);
  assertEquals(deno.nodeModulesDir, "manual");
  assertEquals(deno.links, undefined, "no better-sqlite3 links shim");
  assert(deno.imports?.["denext/prisma-adapter"]?.endsWith("/src/server/prisma-adapter/mod.ts"));
  assertStringIncludes(deno.imports?.["@prisma/client"] ?? "", "npm:@prisma/client@6.19.3");
  assert(!Object.keys(deno.imports ?? {}).some((k) => k.startsWith("@prisma/adapter-")));
  assert(!(await exists(join(dir, "patch/better-sqlite3"))));
  const setup = await read(dir, "scripts/denext-prisma-setup.ts");
  assert(!setup.includes("bundle the better-sqlite3 compat"));
  assert(!setup.includes("URL_VAR"), "SQLite needs no server URL");
  assertStringIncludes(setup, "denext/prisma-adapter (Deno.SQL)");
  assert(!(await read(dir, ".gitignore")).includes("patch/better-sqlite3"));
  // The setup script still type-checks on its own.
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--no-config", "--quiet", join(dir, "scripts/denext-prisma-setup.ts")],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  // A second run changes nothing.
  await migrateProject(dir, DENO_SQL);
  assertEquals(await read(dir, "app/db.server.ts"), db);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate (deno-sql): a Postgres app reads the datasource's own URL variable", async () => {
  const dir = await scaffoldPrismaApp(PG_DATASOURCE);
  const r = await migrateProject(dir, DENO_SQL);
  assertEquals(r.prisma?.adapter, "denext/prisma-adapter");
  const db = await read(dir, "app/db.server.ts");
  assertStringIncludes(
    db,
    `const __denextPrismaAdapter = () => new __PrismaDenoSql(Deno.env.get("POSTGRES_PRISMA_URL") ?? "");`,
  );
  const deno = await denoJson(dir);
  assert(!("@prisma/adapter-pg" in (deno.imports ?? {})));
  assertEquals(deno.links, undefined);
  assertStringIncludes(
    await read(dir, "scripts/denext-prisma-setup.ts"),
    `const URL_VAR = "POSTGRES_PRISMA_URL";`,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate (deno-sql): CockroachDB and MySQL keep their npm adapters", async () => {
  for (
    const [datasource, adapter] of [
      [`provider = "cockroachdb"\n  url = env("DATABASE_URL")`, "@prisma/adapter-pg"],
      [`provider = "mysql"\n  url = env("DATABASE_URL")`, "@prisma/adapter-mariadb"],
    ]
  ) {
    const dir = await scaffoldPrismaApp(datasource);
    const r = await migrateProject(dir, DENO_SQL);
    assertEquals(r.prisma?.adapter, adapter);
    assert(!("denext/prisma-adapter" in ((await denoJson(dir)).imports ?? {})));
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prisma migrate (auto): the adapter follows the runtime's Deno.SQL", async () => {
  const dir = await scaffoldPrismaApp();
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT });
  const expected = (await denoSqlHasColumns())
    ? "denext/prisma-adapter"
    : "@prisma/adapter-better-sqlite3";
  assertEquals(r.prisma?.adapter, expected);
  await Deno.remove(dir, { recursive: true });
});

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}
