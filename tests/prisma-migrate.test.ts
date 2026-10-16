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
import { migrateProject } from "../src/build/migrate.ts";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));

/** Write a minimal App-Router + Prisma app into a fresh temp dir; return its path. */
async function scaffoldPrismaApp(): Promise<string> {
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
    `datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n\n` +
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
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
  const note = await read(dir, "app/models/note.server.ts");
  assertStringIncludes(note, `from "../../generated/client/client.ts"`);
  assert(!note.includes("__denextPrismaAdapter"), "a type-only module needs no adapter");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: the seed and test tooling move to the Deno client", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
  const deno = JSON.parse(await read(dir, "deno.json")) as { tasks?: Record<string, string> };
  assertEquals(deno.tasks?.["prisma:seed"], "deno run -A prisma/seed.ts");
  const pkg = JSON.parse(await read(dir, "package.json")) as { prisma?: { seed?: string } };
  assertEquals(pkg.prisma?.seed, "deno run -A prisma/seed.ts", "`prisma db seed` runs it on Deno");
  assertStringIncludes(await read(dir, "prisma.config.ts"), `seed: "deno run -A prisma/seed.ts"`);
  // A second migrate leaves the seed stable (one adapter, the same command).
  const seed1 = await read(dir, "prisma/seed.ts");
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  const r = await migrateProject(dir, { denextLocalPath: REPO_ROOT });
  assert(r.prisma?.toolingRewritten.includes("other-seed.mts"));
  const deno = JSON.parse(await read(dir, "deno.json")) as { tasks?: Record<string, string> };
  assertEquals(deno.tasks?.["prisma:seed"], "deno run -A other-seed.mts");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("prisma migrate: deno.json wiring (manual + links + pins + task) and no better-sqlite3 alias", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
  const schema1 = await read(dir, "prisma/schema.prisma");
  const db1 = await read(dir, "app/db.server.ts");
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
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
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
  const deno = JSON.parse(await read(dir, "deno.json")) as { tasks?: Record<string, string> };
  // `start` re-execs (CSS shim map + manual-node_modules module config), which spawns a
  // child deno — a scoped perm set crashes on the re-exec, so migrate emits `-A`.
  assertStringIncludes(deno.tasks?.start ?? "", "-A");
  await Deno.remove(dir, { recursive: true });
});
