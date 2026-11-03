// `denext migrate` — the Prisma auto-wiring path.
//
// A Prisma app can't run on denext with its default native client (Rust query engine), so
// migrate rewrites it to Prisma 7's ESM/Deno client (Rust-free query compiler) over the
// better-sqlite3 driver adapter: schema generator, the datasource URL into `prisma.config.ts`,
// `@prisma/client` imports, the adapter at each construction site, the deno.json
// links/imports/task, the patch package + setup script, and package.json cleanup. A Prisma 6
// app and a Prisma 7 app (URL already in its config, its own adapter) both come out on 7. These tests drive a minimal Prisma app through migrateProject and
// assert the whole transform, the seed and test tooling included (they move to the Deno client
// with the app, the seed run by a `prisma:seed` task).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { appRuntimeReadsColumns, migrateProject } from "../src/build/migrate.ts";
import { readDatasource, wiredProvider } from "../src/build/prisma-migrate.ts";

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

Deno.test("prisma migrate: schema generator → Rust-free Deno client, URL → prisma.config.ts", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const schema = await read(dir, "prisma/schema.prisma");
  assertStringIncludes(schema, `provider     = "prisma-client"`);
  assertStringIncludes(schema, `output       = "../generated/client"`);
  assertStringIncludes(schema, `runtime      = "deno"`);
  // Prisma 7 runs the query compiler through a driver adapter by default: no preview features.
  assert(!schema.includes("previewFeatures"), schema);
  // Prisma 7 rejects a schema `url`: the datasource keeps its provider only.
  assertStringIncludes(schema, `datasource db {\n  provider = "sqlite"\n}`);
  assert(!schema.includes("DATABASE_URL"), schema);
  // The URL moved to prisma.config.ts, read from the same variable, the Prisma 6
  // (schema-relative) SQLite path rebased as the app's adapter rebases it.
  const config = await read(dir, "prisma.config.ts");
  assertStringIncludes(config, `import { defineConfig } from "prisma/config";`);
  assertStringIncludes(config, `schema: "prisma/schema.prisma",`);
  assertStringIncludes(config, `migrations: { seed: "deno run -A prisma/seed.ts" },`);
  assertStringIncludes(
    config,
    `datasource: { url: denextSqliteUrl(process.env.DATABASE_URL ?? "file:./data.db") },`,
  );
  assertStringIncludes(config, `const denextSqliteUrl = (url: string): string => {`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: the config's SQLite helper rebases like the runtime's", async () => {
  // The CLI (prisma.config.ts) and the app (the injected adapter) must open the same file.
  const dir = await scaffoldPrismaApp(`provider = "sqlite"\n  url      = "file:./dev.db"`);
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const config = await read(dir, "prisma.config.ts");
  // A literal Prisma 6 URL becomes the fallback of both.
  assertStringIncludes(config, `process.env.DATABASE_URL ?? "file:./dev.db"`);
  assertStringIncludes(await read(dir, "app/db.server.ts"), `?? "file:./dev.db"`);
  const helper = /const denextSqliteUrl = (\(url: string\): string => \{[\s\S]*?\n\});/
    .exec(config)?.[1];
  assert(helper, config);
  const rebase = new Function(`return ${helper.replace(": string): string", ")")};`)() as (
    url: string,
  ) => string;
  assertEquals(rebase("file:./dev.db"), "file:./prisma/dev.db");
  assertEquals(rebase("file:dev.db?mode=rwc"), "file:./prisma/dev.db");
  assertEquals(rebase("file:./prisma/dev.db"), "file:./prisma/dev.db");
  assertEquals(rebase("file:/var/data/app.db"), "file:/var/data/app.db");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: db module repointed + adapter injected exactly once", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const db = await read(dir, "app/db.server.ts");
  // Import repointed at the generated client, adapter imported + factory defined.
  assertStringIncludes(db, `from "../generated/client/client.ts"`);
  assertStringIncludes(
    db,
    `import { PrismaBetterSqlite3 as __PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";`,
  );
  assertStringIncludes(db, "new __PrismaBetterSqlite3({ url: __denextDbUrl })");
  assert(!db.includes("PrismaBetterSQLite3"), "Prisma 7 renamed the class");
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
  const config = await read(dir, "prisma.config.ts");
  assertStringIncludes(config, `seed: "deno run -A prisma/seed.ts"`);
  // The app's own config (a Prisma 6 one, with no datasource) gets the schema's URL added.
  assertStringIncludes(
    config,
    `export default {\n  datasource: { url: denextSqliteUrl(process.env.DATABASE_URL ?? "file:./data.db") },`,
  );
  assert(config.indexOf("const denextSqliteUrl") < config.indexOf("export default"), config);
  // A second migrate leaves the seed and the config stable (one adapter, the same command).
  const seed1 = await read(dir, "prisma/seed.ts");
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(await read(dir, "prisma/seed.ts"), seed1);
  assertEquals(await read(dir, "prisma.config.ts"), config);
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
  assertEquals(deno.imports?.["@prisma/client"], "npm:@prisma/client@7.10.1");
  assertEquals(
    deno.imports?.["@prisma/adapter-better-sqlite3"],
    "npm:@prisma/adapter-better-sqlite3@7.10.1",
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
    version?: string;
    main?: string;
  };
  assertEquals(patch.name, "better-sqlite3");
  // Within the 7.x @prisma/adapter-better-sqlite3's `^12.6.0`.
  assertEquals(patch.version, "12.6.2");
  assertEquals(patch.main, "index.mjs");
  const setup = await read(dir, "scripts/denext-prisma-setup.ts");
  assertStringIncludes(setup, `const PRISMA = "npm:prisma@7.10.1";`);
  assertStringIncludes(setup, "--no-config"); // resolves the CLI from the global cache
  // Prisma 7's `db push` neither generates nor takes `--skip-generate`: generate runs first.
  assert(
    setup.indexOf(`prisma("generate")`) < setup.indexOf(`prisma("db", "push")`),
    "generate before db push",
  );
  assertStringIncludes(setup, `prisma("migrate", "deploy")`, "SQL migrations are applied");
  assert(!setup.includes("--skip-generate"), "Prisma 7 removed --skip-generate");
  assert(!setup.includes("--accept-data-loss"), "a destructive change stops at Prisma's warning");
  // Prisma 7's CLI loads no .env itself.
  assertStringIncludes(setup, `["--env-file=.env"]`);
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
  const config1 = await read(dir, "prisma.config.ts");
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const schema2 = await read(dir, "prisma/schema.prisma");
  const db2 = await read(dir, "app/db.server.ts");
  assertEquals(schema1, schema2, "a second migrate must not re-rewrite the generator");
  assertEquals(db1, db2, "a second migrate must not re-inject the adapter (commit-parity)");
  assertEquals(await read(dir, "prisma.config.ts"), config1, "the config is written once");
  // Belt and suspenders: exactly one adapter injection survives the re-run.
  assertEquals(db2.match(/adapter: __denextPrismaAdapter\(\)/g)?.length, 1);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: an app migrated for Prisma 6 re-migrates to 7", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  // What an earlier migrate left: Prisma 6's class name, the URL still in the schema, no config.
  const db7 = await read(dir, "app/db.server.ts");
  await Deno.writeTextFile(
    join(dir, "app/db.server.ts"),
    db7.replaceAll("PrismaBetterSqlite3", "PrismaBetterSQLite3"),
  );
  await Deno.writeTextFile(
    join(dir, "prisma/schema.prisma"),
    (await read(dir, "prisma/schema.prisma")).replace(
      `provider = "sqlite"\n`,
      `provider = "sqlite"\n  url      = env("DATABASE_URL")\n`,
    ),
  );
  await Deno.remove(join(dir, "prisma.config.ts"));
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(
    await read(dir, "app/db.server.ts"),
    db7,
    "the class is renamed, nothing re-injected",
  );
  assert(!(await read(dir, "prisma/schema.prisma")).includes("url"));
  assertStringIncludes(await read(dir, "prisma.config.ts"), "process.env.DATABASE_URL");
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
  assertEquals(deno.imports?.["@prisma/adapter-pg"], "npm:@prisma/adapter-pg@7.10.1");
  assert(!("@prisma/adapter-better-sqlite3" in (deno.imports ?? {})));
  // No compat bundle: neither the patch package nor its bundle step.
  assert(!(await exists(join(dir, "patch/better-sqlite3/package.json"))));
  const setup = await read(dir, "scripts/denext-prisma-setup.ts");
  assert(!setup.includes("bundle the better-sqlite3 compat"));
  // The CLI migrates through directUrl (the Prisma 7 upgrade guide moves it to the config's
  // `url`), so that is the variable setup checks; the app keeps the pooled one.
  assertStringIncludes(setup, `const URL_VAR = "POSTGRES_URL_NON_POOLING";`);
  assertStringIncludes(setup, "migrate", "SQL migrations are applied with `migrate deploy`");
  const schema = await read(dir, "prisma/schema.prisma");
  assert(!/url\s*=|directUrl/.test(schema), schema);
  assertStringIncludes(schema, `runtime      = "deno"`);
  const config = await read(dir, "prisma.config.ts");
  assertStringIncludes(config, "datasource: { url: process.env.POSTGRES_URL_NON_POOLING },");
  assert(!config.includes("denextSqliteUrl"), "no SQLite rebasing for a server database");
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
  delete env.POSTGRES_URL_NON_POOLING;
  const ran = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-config", script],
    cwd: dir,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(!ran.success, "setup must refuse to run without the datasource URL");
  assertStringIncludes(new TextDecoder().decode(ran.stderr), "set POSTGRES_URL_NON_POOLING");
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
  assertEquals(deno.imports?.["@prisma/adapter-pg"], "npm:@prisma/adapter-pg@7.10.1");
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
  assertEquals(deno.imports?.["@prisma/adapter-mariadb"], "npm:@prisma/adapter-mariadb@7.10.1");
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
  assertEquals(deno.imports?.["@prisma/adapter-mssql"], "npm:@prisma/adapter-mssql@7.10.1");
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
    { provider: "postgresql", envVar: "PG_URL", urlIn: "schema" },
  );
  assertEquals(
    readDatasource(`datasource db {\n  provider = "sqlite"\n  url = "file:./dev.db"\n}`),
    { provider: "sqlite", envVar: null, urlIn: "schema" },
  );
  assertEquals(readDatasource("model A { id Int @id }"), {
    provider: null,
    envVar: null,
    urlIn: null,
  });
  assertEquals(wiredProvider(null), "sqlite");
  assertEquals(wiredProvider("postgres"), "postgresql");
  assertEquals(wiredProvider("mysql"), "mysql");
  assertEquals(wiredProvider("sqlserver"), "sqlserver");
  assertEquals(wiredProvider("mongodb"), null);
  assertEquals(wiredProvider("cockroachdb"), "postgresql");
});

Deno.test("prisma migrate: readDatasource reads Prisma 7's prisma.config.ts first", () => {
  // Prisma 7: the schema names the provider only, the config the URL.
  const schema7 = `datasource db {\n  provider = "postgresql"\n}\n`;
  const config = (url: string) =>
    `import { defineConfig, env } from "prisma/config";\n` +
    `export default defineConfig({\n  schema: "prisma/schema.prisma",\n  datasource: {\n    url: ${url},\n  },\n});\n`;
  for (
    const [url, envVar] of [
      [`env("DATABASE_URL")`, "DATABASE_URL"],
      [`env<Env>('PG_URL')`, null], // a generic call is not read: no variable named
      [`process.env.PG_URL`, "PG_URL"],
      [`process.env["PG-URL"]`, "PG-URL"],
      [`process.env.PG_URL ?? "postgres://localhost/app"`, "PG_URL"],
      [`Deno.env.get("PG_URL")!`, "PG_URL"],
      [`"postgres://localhost/app"`, null],
    ] as const
  ) {
    assertEquals(readDatasource(schema7, config(url)), {
      provider: "postgresql",
      envVar,
      urlIn: "config",
    }, url);
  }
  // A one-line config.
  assertEquals(
    readDatasource(
      schema7,
      `export default defineConfig({ schema: "s", datasource: { url: env("ONE_LINE") } });`,
    ),
    { provider: "postgresql", envVar: "ONE_LINE", urlIn: "config" },
  );
  // A config with no datasource (a Prisma 6 app's, for its seed) leaves the schema's URL in charge.
  const schema6 = `datasource db {\n  provider = "sqlite"\n  url = env("SQLITE_URL")\n}\n`;
  assertEquals(
    readDatasource(schema6, `export default { migrations: { seed: "tsx prisma/seed.ts" } };\n`),
    { provider: "sqlite", envVar: "SQLITE_URL", urlIn: "schema" },
  );
  // Neither names a URL: the caller falls back to DATABASE_URL.
  assertEquals(readDatasource(schema7, `export default defineConfig({});`), {
    provider: "postgresql",
    envVar: null,
    urlIn: null,
  });
});

// ── A Prisma 7 source app: URL in prisma.config.ts, its own adapter and generator output ──

/** A Prisma 7 app as `prisma init` + the upgrade guide shape it, on SQLite. */
async function scaffoldPrisma7App(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-prisma7-" });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "prisma7-app",
      type: "module",
      dependencies: {
        "react": "^19.0.0",
        "react-dom": "^19.0.0",
        "@prisma/client": "^7.0.0",
        "@prisma/adapter-better-sqlite3": "^7.0.0",
      },
      devDependencies: { "prisma": "^7.0.0" },
    }),
  );
  await Deno.mkdir(join(dir, "prisma"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "prisma", "schema.prisma"),
    `generator client {\n  provider = "prisma-client"\n  output   = "../generated/prisma"\n}\n\n` +
      `datasource db {\n  provider = "sqlite"\n}\n\n` +
      `model Note {\n  id Int @id @default(autoincrement())\n  title String\n}\n`,
  );
  await Deno.writeTextFile(join(dir, "prisma.config.ts"), PRISMA7_CONFIG);
  await Deno.mkdir(join(dir, "lib"), { recursive: true });
  await Deno.writeTextFile(join(dir, "lib", "db.ts"), PRISMA7_DB);
  return dir;
}

const PRISMA7_CONFIG = `import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: env("DATABASE_URL") },
});
`;

const PRISMA7_DB = `import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! });
export const prisma = new PrismaClient({ adapter });
`;

Deno.test("prisma migrate: a Prisma 7 app keeps its config, generator output and adapter", async () => {
  const dir = await scaffoldPrisma7App();
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.provider, "sqlite");
  // Its own construction already passes an adapter: nothing is injected (no duplicate key).
  assertEquals(r.prisma?.clientModules, []);
  assertEquals(r.prisma?.warnings, []);
  assertEquals(await read(dir, "lib/db.ts"), PRISMA7_DB);
  // The datasource stays where Prisma 7 reads it.
  assertEquals(await read(dir, "prisma.config.ts"), PRISMA7_CONFIG);
  // The Deno client generates where the app's imports already point.
  const schema = await read(dir, "prisma/schema.prisma");
  assertStringIncludes(schema, `output       = "../generated/prisma"`);
  assertStringIncludes(schema, `runtime      = "deno"`);
  assert(!schema.includes("previewFeatures"));
  assertStringIncludes(await read(dir, ".gitignore"), "generated/prisma/");
  // Pinned to 7.10.1, with its adapter's better-sqlite3 swapped for the compat (12.x link).
  const deno = await denoJson(dir);
  assertEquals(deno.imports?.["@prisma/client"], "npm:@prisma/client@7.10.1");
  assertEquals(deno.links, ["./patch/better-sqlite3"]);
  assertStringIncludes(await read(dir, "patch/better-sqlite3/package.json"), `"12.6.2"`);
  const pkg = JSON.parse(await read(dir, "package.json"));
  assertEquals(pkg.dependencies["@prisma/adapter-better-sqlite3"], "7.10.1");
  assert(!("prisma" in pkg.devDependencies) && !("@prisma/client" in pkg.dependencies));
  const setup = await read(dir, "scripts/denext-prisma-setup.ts");
  assertStringIncludes(setup, "npm:prisma@7.10.1");
  assertStringIncludes(setup, "bundle the better-sqlite3 compat");
  // A second run changes nothing.
  const schema1 = schema;
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(await read(dir, "prisma/schema.prisma"), schema1);
  assertEquals(await read(dir, "lib/db.ts"), PRISMA7_DB);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: a Prisma 7 app's construction without an adapter gets one", async () => {
  const dir = await scaffoldPrisma7App();
  await Deno.writeTextFile(
    join(dir, "lib", "other.ts"),
    `import { PrismaClient } from "../generated/prisma/client";\n` +
      `export const a = new PrismaClient({ adapter: x });\nexport const b = new PrismaClient({ log: [] });\n`,
  );
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.clientModules, ["lib/other.ts"]);
  const other = await read(dir, "lib/other.ts");
  assertStringIncludes(other, "new PrismaClient({ adapter: x })");
  assertStringIncludes(other, "new PrismaClient({ adapter: __denextPrismaAdapter(), log: [] })");
  // The URL comes from the variable the config reads, resolved as Prisma 7 does (no rebasing).
  assertStringIncludes(
    other,
    `const __denextDbUrl = Deno.env.get("DATABASE_URL") ?? "file:./data.db";`,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: a schema migrated for Prisma 6 moves to 7, other preview features kept", async () => {
  const dir = await scaffoldPrismaApp();
  // What an earlier denext migrate wrote (plus a preview feature of the app's own).
  await Deno.writeTextFile(
    join(dir, "prisma", "schema.prisma"),
    `generator client {\n  provider        = "prisma-client"\n  output          = "../generated/client"\n` +
      `  runtime         = "deno"\n  moduleFormat    = "esm"\n` +
      `  previewFeatures = ["queryCompiler", "driverAdapters", "relationJoins"]\n}\n\n` +
      `datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n` +
      `  shadowDatabaseUrl = env("SHADOW_URL")\n}\n`,
  );
  await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  const schema = await read(dir, "prisma/schema.prisma");
  assertStringIncludes(schema, `previewFeatures = ["relationJoins"]`);
  assert(!/queryCompiler|driverAdapters|url\s*=|shadowDatabaseUrl/.test(schema), schema);
  assertStringIncludes(
    await read(dir, "prisma.config.ts"),
    "datasource: { url: process.env.DATABASE_URL, shadowDatabaseUrl: process.env.SHADOW_URL },",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: an existing prisma.config.ts gets the seed and URL it lacks", async () => {
  const dir = await scaffoldPrismaApp(`provider = "postgresql"\n  url = env("DATABASE_URL")`);
  await Deno.writeTextFile(
    join(dir, "prisma.config.ts"),
    `import { defineConfig } from "prisma/config";\n` +
      `export default defineConfig({ migrations: { path: "prisma/migrations" } });\n`,
  );
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(r.prisma?.warnings, []);
  assertEquals(
    await read(dir, "prisma.config.ts"),
    `import { defineConfig } from "prisma/config";\n` +
      `export default defineConfig({\n  datasource: { url: process.env.DATABASE_URL },` +
      ` migrations: { seed: "deno run -A prisma/seed.ts", path: "prisma/migrations" } });\n`,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: a prisma.config.ts it can't amend is reported", async () => {
  const dir = await scaffoldPrismaApp(`provider = "postgresql"\n  url = env("DATABASE_URL")`);
  const config = `const config = { schema: "prisma/schema.prisma" };\nexport default config;\n`;
  await Deno.writeTextFile(join(dir, "prisma.config.ts"), config);
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
  assertEquals(await read(dir, "prisma.config.ts"), config);
  assert(
    r.prisma?.warnings.some((w) =>
      w.startsWith("prisma.config.ts: no `defineConfig({ … })`") &&
      w.includes("datasource: { url: process.env.DATABASE_URL }")
    ),
    JSON.stringify(r.prisma?.warnings),
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: a prisma-client output outside the app falls back to generated/client", async () => {
  for (const output of ["../../shared/client", "/abs/client", "../"]) {
    const dir = await scaffoldPrismaApp();
    const schemaPath = join(dir, "prisma", "schema.prisma");
    await Deno.writeTextFile(
      schemaPath,
      (await Deno.readTextFile(schemaPath)).replace(
        `provider = "prisma-client-js"`,
        `provider = "prisma-client"\n  output   = "${output}"`,
      ),
    );
    await migrateProject(dir, { denextLocalPath: REPO_ROOT, prismaAdapter: "npm" });
    assertStringIncludes(
      await read(dir, "prisma/schema.prisma"),
      `output       = "../generated/client"`,
    );
    assertStringIncludes(
      await read(dir, "app/db.server.ts"),
      `from "../generated/client/client.ts"`,
    );
    await Deno.remove(dir, { recursive: true });
  }
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
  assertStringIncludes(deno.imports?.["@prisma/client"] ?? "", "npm:@prisma/client@7.10.1");
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
    `const URL_VAR = "POSTGRES_URL_NON_POOLING";`,
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

Deno.test("prisma migrate (auto): the adapter follows the app runtime's Deno.SQL", async () => {
  const dir = await scaffoldPrismaApp();
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT });
  const expected = (await appRuntimeReadsColumns())
    ? "denext/prisma-adapter"
    : "@prisma/adapter-better-sqlite3";
  assertEquals(r.prisma?.adapter, expected);
  await Deno.remove(dir, { recursive: true });
});

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

Deno.test("prisma migrate (auto): on a stock Deno, the toolchain denext hands the app decides", async () => {
  const env = (value?: string) => (name: string) =>
    name === "DENEXT_TOOLCHAIN_ACTIVE" ? value : undefined;
  const stock = () => Promise.resolve(false);
  // migrate itself on a stock Deno: the app's dev / build / start re-run on the toolchain.
  assertEquals(await appRuntimeReadsColumns(env("3.0.0-rc.5"), stock), true);
  assertEquals(await appRuntimeReadsColumns(env("3.0.0-rc.1"), stock), true);
  // The fork's releases after its last release candidate: newer than every rc.N, not below it
  // as plain semver would order them.
  assertEquals(await appRuntimeReadsColumns(env("3.0.0-denext.1"), stock), true);
  assertEquals(await appRuntimeReadsColumns(env("3.0.0-denext.12"), stock), true);
  // A toolchain from before `Deno.SQL` reported columns, an unverified binary, or none at all
  // (`DENEXT_DENO=stock`): Prisma's npm adapters.
  assertEquals(await appRuntimeReadsColumns(env("2.9.7-denext.21"), stock), false);
  assertEquals(await appRuntimeReadsColumns(env("path"), stock), false);
  assertEquals(await appRuntimeReadsColumns(env(undefined), stock), false);
  // This process's own Deno.SQL answers first.
  assertEquals(await appRuntimeReadsColumns(env(undefined), () => Promise.resolve(true)), true);
});

Deno.test("prisma migrate (deno-sql): an app's own better-sqlite3 keeps the links shim", async () => {
  // The Epic Stack keeps a cache database on better-sqlite3 beside Prisma: Prisma goes over
  // Deno.SQL, and the app's own import still needs the native addon swapped for the compat.
  const dir = await scaffoldPrismaApp();
  const pkg = JSON.parse(await read(dir, "package.json"));
  pkg.dependencies["better-sqlite3"] = "^11.0.0";
  await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(pkg));
  const r = await migrateProject(dir, DENO_SQL);
  assertEquals(r.prisma?.adapter, "denext/prisma-adapter");
  const deno = await denoJson(dir);
  assertEquals(deno.links, ["./patch/better-sqlite3"]);
  assert(!("better-sqlite3" in (deno.imports ?? {})), "better-sqlite3 resolves through the link");
  assertStringIncludes(await read(dir, "patch/better-sqlite3/package.json"), `"better-sqlite3"`);
  // Deno takes the link only for a range its version satisfies: the app's own `^11` would
  // otherwise install the native package (whose addon the server bundle cannot load).
  const link = JSON.parse(await read(dir, "patch/better-sqlite3/package.json")).version;
  assertEquals(JSON.parse(await read(dir, "package.json")).dependencies["better-sqlite3"], link);
  assertStringIncludes(
    await read(dir, "scripts/denext-prisma-setup.ts"),
    "bundle the better-sqlite3 compat",
  );
  assertStringIncludes(await read(dir, "app/db.server.ts"), "new __PrismaDenoSql(");
  await Deno.remove(dir, { recursive: true });
});
