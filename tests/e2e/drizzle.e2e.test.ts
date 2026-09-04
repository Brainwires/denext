// Networked e2e for examples/drizzle: proves Drizzle ORM runs on denext over the
// better-sqlite3 compat (Deno's built-in node:sqlite, no native addon), end to end
// through the real CLI — `deno install` → `denext build` → `denext start` — then a
// live read + Server-Action write against the served app.
//
// This drives the CLI as a subprocess ON PURPOSE: a server-side npm dep (drizzle)
// only resolves once the CLI re-execs with the merged framework+app config (see
// `maybeReexecForModules` in cli.ts). The in-process build harness runs under the
// framework's own config, where a bare `import "drizzle-orm"` can't resolve — so
// this can't use buildAndServe().
//
// Opt-in + NETWORK-REQUIRED (`deno install` fetches drizzle-orm from npm):
// `deno task test:e2e`. Skipped automatically if the install can't reach npm.

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { assertServerActionInsert, runDeno, startCliServer } from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/drizzle", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

// Bounded waits so a wedged step fails fast with a diagnostic instead of hanging the whole
// suite for 30+ minutes (e.g. a stale drizzle server holding the SQLite file, an npm fetch
// that stalls, or a re-exec that never binds a port). `deno install` can be slow (network),
// so it gets the longest bound; the server must print its listen URL well within a minute.
const INSTALL_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 60_000;

Deno.test({
  name: "e2e: examples/drizzle runs Drizzle ORM over the better-sqlite3 compat",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // 1. Install deps (drizzle-orm from npm + the local better-sqlite3 shim).
  const install = await runDeno(["install"], EXAMPLE, INSTALL_TIMEOUT_MS);
  if (!install.ok) {
    console.warn(
      "e2e: `deno install` failed (npm unreachable / offline?) — skipping.\n" + install.out,
    );
    return;
  }

  // 2. Build for production via the real CLI (exercises the module re-exec).
  await t.step("build", async () => {
    const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, BUILD_TIMEOUT_MS);
    assert(built.ok, "denext build failed:\n" + built.out);
  });

  // 3. Start the prod server on an ephemeral port; parse the bound port from its
  //    startup line ("denext start ▸ http://127.0.0.1:PORT").
  const server = await startCliServer(EXAMPLE, READY_TIMEOUT_MS);
  try {
    await t.step("read path: Drizzle query renders seeded rows", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "Drizzle runs on denext");
      assertStringIncludes(html, "node:sqlite");
    });

    await t.step(
      "write path: Server Action inserts through Drizzle",
      () => assertServerActionInsert(server.origin),
    );
  } finally {
    await server.close();
  }
});
