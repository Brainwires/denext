// `denext migrate` — the Prisma auto-wiring path.
//
// A Prisma app can't run on denext with its default native client (Rust query engine), so
// migrate rewrites it to Prisma 6's ESM/Deno client (Rust-free query compiler) over the
// better-sqlite3 driver adapter: schema generator, `@prisma/client` imports, the adapter at
// each construction site, the deno.json links/imports/task, the patch package + setup script,
// and package.json cleanup. These tests drive a minimal Prisma app through migrateProject and
// assert the whole transform, plus that non-runtime tooling (the seed script) is left alone.

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
  // A NON-runtime tooling file (the seed) — must be left untouched (Node-only, native client).
  await Deno.writeTextFile(
    join(dir, "prisma", "seed.ts"),
    `import { PrismaClient } from "@prisma/client";\nnew PrismaClient();\n`,
  );
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

Deno.test("prisma migrate: non-runtime tooling (seed) is left untouched", async () => {
  const dir = await scaffoldPrismaApp();
  await migrateProject(dir, { denextLocalPath: REPO_ROOT });
  const seed = await read(dir, "prisma/seed.ts");
  assertStringIncludes(seed, `from "@prisma/client"`); // NOT rewritten
  assert(!seed.includes("__denextPrismaAdapter"), "seed must not get the Deno adapter");
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
