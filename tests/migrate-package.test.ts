// `@denext/migrate` is loaded on first use by a literal dynamic import pinned to denext's own
// version (src/cli/migrate-package.ts): from the workspace member in a checkout, from JSR (or
// Deno's cache) elsewhere. A load that cannot reach JSR stops `denext migrate` with what to do,
// not Deno's loader error; no verb but `migrate` loads the migrators.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  loadMigratePackage,
  MIGRATE_PACKAGE,
  migrateUnavailableMessage,
} from "../src/cli/migrate-package.ts";
import { VERSION } from "../src/version.ts";

Deno.test("migrate package: the workspace member loads, once per process", async () => {
  const first = loadMigratePackage("denext migrate");
  assert(first === loadMigratePackage("denext migrate"), "one load per process");
  const m = await first;
  assertEquals(typeof m.migrateProject, "function");
  assertEquals(typeof m.checkMigration, "function");
  assertEquals(typeof m.runCapacitorSteps, "function");
});

Deno.test("migrate package: a failed fetch names the package, the version and the way out", async () => {
  const fetchFailed = new TypeError(
    "Import 'https://jsr.io/@denext/migrate/meta.json' failed.\n    0: error sending request",
  );
  const err = await assertRejects(
    () => loadMigratePackage("denext migrate", () => Promise.reject(fetchFailed)),
    Error,
  );
  assert(err.message.startsWith("denext: "), "printed without a stack trace (cli.ts)");
  assertStringIncludes(err.message, `denext migrate needs ${MIGRATE_PACKAGE}@${VERSION}`);
  assertStringIncludes(err.message, "failed. 0: error sending request"); // on one line
  assertStringIncludes(err.message, `deno cache jsr:${MIGRATE_PACKAGE}@${VERSION}`);
  assertEquals(err.cause, fetchFailed);
  assertStringIncludes(migrateUnavailableMessage("denext migrate", "offline"), "(offline)");
});

Deno.test("migrate package: an error from the migrators' own code propagates unchanged", async () => {
  const bug = new RangeError("the migrator threw while loading");
  const err = await assertRejects(() =>
    loadMigratePackage("denext migrate", () => Promise.reject(bug))
  );
  assert(err === bug, "propagated unchanged");
});

Deno.test("migrate package: offline, a real Deno load stops with the message", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const loader = toFileUrl(join(Deno.cwd(), "src/cli/migrate-package.ts")).href;
    await Deno.writeTextFile(
      join(dir, "main.ts"),
      `import { loadMigratePackage } from ${JSON.stringify(loader)};\n` +
        `try {\n` +
        `  await loadMigratePackage("denext migrate", () => import("jsr:@denext/migrate@${VERSION}"));\n` +
        `} catch (error) {\n` +
        `  console.error((error as Error).message);\n` +
        `  Deno.exit(3);\n` +
        `}\n`,
    );
    // A port nothing listens on: the connection is refused, as with no network.
    const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--no-lock", "--allow-read", "--allow-net", "main.ts"],
      cwd: dir,
      env: { JSR_URL: `http://127.0.0.1:${port}/`, DENO_DIR: join(dir, "deno-dir"), NO_COLOR: "1" },
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 3, stderr);
    assertStringIncludes(stderr, `denext: denext migrate needs ${MIGRATE_PACKAGE}@${VERSION}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** The relative `import` / `export … from` specifiers in module text. */
function relativeImports(text: string): string[] {
  return [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*"(\.[^"]+)"/gm)].map((m) => m[1]);
}

Deno.test("migrate package: the CLI reaches the migrators only through the lazy loader", async () => {
  // Before the split, src/cli/commands/migrate.ts imported src/build/migrate.ts statically, so the
  // migrators shipped in @denext/denext. Now no denext module imports them: only the package does.
  const verb = await Deno.readTextFile("src/cli/commands/migrate.ts");
  for (const spec of relativeImports(verb)) {
    assert(!/\/build\/(migrate|remix-migrate|expo-migrate|prisma-migrate)\b/.test(spec), spec);
  }
  assertStringIncludes(verb, 'loadMigratePackage("denext migrate")');
  for (
    const moved of ["migrate.ts", "migrate-check.ts", "migrate-capacitor.ts", "remix-migrate.ts"]
  ) {
    const gone = await Deno.stat(join("src/build", moved)).then(() => false, () => true);
    assert(gone, `src/build/${moved} lives in packages/migrate/src now`);
  }
});
