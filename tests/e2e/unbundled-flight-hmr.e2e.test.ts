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
import { launchBrowser, startDevOnDir } from "./harness.ts";

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
    await t.step("the app-wide Flight entry imports the island unbundled (@fs)", async () => {
      const entry = await (await fetch(server.origin + "/_denext/flight.js")).text();
      assertStringIncludes(entry, "/_denext/@fs"); // island served on its own URL
      assertStringIncludes(entry, "/_denext/@dep/"); // denext pre-bundled once
    });

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const d = (e as any).detail;
      if (d?.type === "error") consoleErrors.push(String(d.text ?? ""));
    });

    await t.step("island hydrates and is interactive", async () => {
      await page.waitForFunction("!!document.querySelector('[data-testid=\"island\"]')");
      await page.evaluate("window.__noReload = true");
      const btn = await page.$('[data-testid="island"]');
      assert(btn, "island button exists");
      await btn.click();
      await btn.click();
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"island\"]').textContent.includes('count: 2')",
      );
    });

    await t.step("editing the island hot-swaps it, preserves state, no reload", async () => {
      const src = await Deno.readTextFile(islandFile);
      await Deno.writeTextFile(islandFile, src.replace("ISLAND_V1", "ISLAND_V2"));
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"island\"]').textContent.includes('ISLAND_V2')",
      );
      // The island's own count state survived (single-module swap, not a remount).
      const island = await page.evaluate(
        "document.querySelector('[data-testid=\"island\"]').textContent",
      );
      assertStringIncludes(String(island), "count: 2");
      const noReload = await page.evaluate("window.__noReload === true");
      assert(noReload, "an island edit must NOT trigger a full page reload");
    });

    await t.step("no console errors during hydration + HMR", () => {
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
    });
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
