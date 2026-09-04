// Real-browser end-to-end test for the UNBUNDLED dev loop on a FLIGHT route (islands).
//
// A `"use client"` island route hydrates through the app-wide Flight entry. Under the
// unbundled dev loop that entry imports each island by its own `@fs` URL, so editing
// an island hot-swaps ONLY that module — the island's `count` state is preserved and
// there is NO full page reload. This proves per-module HMR now covers the Flight path,
// not just native isomorphic routes.
//
// Opt-in: run with `deno task test:e2e`. Excluded from `deno task test`/`check`.

import { assert, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import {
  collectConsoleErrors,
  editAndAssertHotSwap,
  hydrateAndClick,
  launchBrowser,
  type RunningServer,
  startDevOnDir,
} from "./harness.ts";

const FIXTURE = new URL("./fixtures/hmr-flight", import.meta.url).pathname;
const FRAMEWORK_ROOT = new URL("../../", import.meta.url).pathname;

/** Rewrite the copied app's deno.json `denext*` imports to absolute framework URLs. */
async function patchImports(dir: string): Promise<void> {
  const p = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(p)) as { imports?: Record<string, string> };
  const abs = (rel: string) => toFileUrl(join(FRAMEWORK_ROOT, rel)).href;
  cfg.imports = {
    "denext": abs("mod.ts"),
    "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
    "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
    "denext/server": abs("src/server/mod.ts"),
    "denext/client": abs("src/client/mod.ts"),
    "denext/live": abs("src/live.ts"),
    "denext/lazy": abs("src/lazy.ts"),
  };
  await Deno.writeTextFile(p, JSON.stringify(cfg, null, 2));
}

const ISLAND_EDIT = {
  from: "ISLAND_V1",
  to: "ISLAND_V2",
  watch: "island",
  counter: "island",
  count: "count: 2",
  reloadMessage: "an island edit must NOT trigger a full page reload",
};

async function stepFlightEntry(server: RunningServer): Promise<void> {
  const entry = await (await fetch(server.origin + "/_denext/flight.js")).text();
  assertStringIncludes(entry, "/_denext/@fs"); // island served on its own URL
  assertStringIncludes(entry, "/_denext/@dep/"); // denext pre-bundled once
}

Deno.test({
  name: "e2e: unbundled dev loop — Flight island single-module HMR preserves state",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "denext_hmr_flight_" });
  await copy(FIXTURE, dir, { overwrite: true });
  await patchImports(dir);

  // Default-on (no env var) — proves the Flight path uses the unbundled loop too.
  const server = await startDevOnDir(dir, {});
  const browser = await launchBrowser();
  const islandFile = join(dir, "app/counter.tsx");

  try {
    await t.step(
      "the app-wide Flight entry imports the island unbundled (@fs)",
      () => stepFlightEntry(server),
    );

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors = collectConsoleErrors(page);

    await t.step(
      "island hydrates and is interactive",
      () => hydrateAndClick(page, "island", 2, "count: 2", "island button exists"),
    );
    await t.step(
      "editing the island hot-swaps it, preserves state, no reload",
      () => editAndAssertHotSwap(page, { file: islandFile, ...ISLAND_EDIT }),
    );
    await t.step("no console errors during hydration + HMR", () => {
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
    });
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
