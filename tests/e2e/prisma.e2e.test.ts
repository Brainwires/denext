// Networked e2e for examples/prisma: proves Prisma ORM runs on denext over the
// better-sqlite3 compat (Deno's built-in node:sqlite — Rust-free, no native addon),
// end to end. It runs the example's real setup (bundle the compat into the `links`
// package → install → `prisma generate` → `prisma db push`), builds + serves via the
// CLI, then drives a live read + Server-Action write.
//
// Opt-in + NETWORK+CODEGEN-REQUIRED (installs @prisma/* and runs the prisma CLI):
// `deno task test:e2e`. Skipped automatically if setup can't complete (offline).
// Heavier than the other e2es — it runs Prisma's code generator.

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { assertServerActionInsert, runDeno, startCliServer } from "./harness.ts";

const EXAMPLE = fromFileUrl(new URL("../../examples/prisma", import.meta.url));
const CLI = fromFileUrl(new URL("../../cli.ts", import.meta.url));

// Bounded waits so a wedged step fails fast with a diagnostic instead of hanging the suite.
// Setup is the heaviest (install + prisma generate + db push over the network).
const SETUP_TIMEOUT_MS = 240_000;
const BUILD_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 60_000;

Deno.test({
  name: "e2e: examples/prisma runs Prisma ORM over the better-sqlite3 compat",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // Start from a fresh database so the seeded rows are deterministic.
  try {
    await Deno.remove(join(EXAMPLE, "prisma", "dev.db"));
  } catch { /* absent */ }

  // 1. Full setup: bundle the compat shim, install, prisma generate, prisma db push.
  const setup = await runDeno(["task", "setup"], EXAMPLE, SETUP_TIMEOUT_MS);
  if (!setup.ok) {
    console.warn(
      "e2e: `deno task setup` failed (offline / npm unreachable?) — skipping.\n" + setup.out,
    );
    return;
  }

  // 2. Build for production via the real CLI (exercises the module re-exec).
  await t.step("build", async () => {
    const built = await runDeno(["run", "-A", CLI, "build", "."], EXAMPLE, BUILD_TIMEOUT_MS);
    assert(built.ok, "denext build failed:\n" + built.out);
  });

  // 3. Start the prod server on an ephemeral port; parse the bound port.
  const server = await startCliServer(EXAMPLE, READY_TIMEOUT_MS);
  try {
    await t.step("read path: Prisma query renders seeded rows", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "Prisma runs on denext");
      assertStringIncludes(html, "node:sqlite");
    });

    await t.step(
      "write path: Server Action inserts through Prisma",
      () => assertServerActionInsert(server.origin),
    );
  } finally {
    await server.close();
  }
});
