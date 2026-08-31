// Real-browser end-to-end test for the UNBUNDLED dev loop (Vite-class per-module HMR).
//
// Copies a tiny App Router fixture to a temp dir (so the test can edit its source),
// starts the DEV server with DENEXT_DEV_UNBUNDLED=1, and drives a headless Chromium:
//   1. the page hydrates through the unbundled entry (`/_denext/@entry`) and is interactive;
//   2. editing a LEAF component module hot-swaps ONLY that module, with NO full reload and
//      the parent page's hook state preserved (the true single-module HMR guarantee);
//   3. editing the page module itself hot-swaps in place, again preserving state.
//
// Opt-in: run with `deno task test:e2e`. Excluded from `deno task test`/`check`.

import { assert, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import { launchBrowser, startDevOnDir } from "./harness.ts";

const FIXTURE = new URL("./fixtures/hmr", import.meta.url).pathname;
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
  };
  await Deno.writeTextFile(p, JSON.stringify(cfg, null, 2));
}

Deno.test({
  name: "e2e: unbundled dev loop — single-module HMR preserves state, no reload",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "denext_hmr_" });
  await copy(FIXTURE, dir, { overwrite: true });
  await patchImports(dir);

  const server = await startDevOnDir(dir, { DENEXT_DEV_UNBUNDLED: "1" });
  const browser = await launchBrowser();
  const pageFile = join(dir, "app/page.tsx");
  const widgetFile = join(dir, "app/widget.tsx");

  try {
    await t.step("shell serves the unbundled entry module", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "/_denext/@entry?p=");
      assertStringIncludes(html, "TITLE_V1"); // SSR rendered
    });

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const d = (e as any).detail;
      if (d?.type === "error") consoleErrors.push(String(d.text ?? ""));
    });

    await t.step("hydrates through the unbundled graph and is interactive", async () => {
      await page.waitForFunction("!!document.querySelector('[data-testid=\"counter\"]')");
      // A full page reload would clear this flag — we assert its survival across HMR below.
      await page.evaluate("window.__noReload = true");
      const btn = await page.$('[data-testid="counter"]');
      assert(btn, "counter button exists");
      await btn.click();
      await btn.click();
      await btn.click();
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"counter\"]').textContent.includes('count: 3')",
      );
    });

    await t.step("editing a LEAF module hot-swaps it, preserves state, no reload", async () => {
      const src = await Deno.readTextFile(widgetFile);
      await Deno.writeTextFile(widgetFile, src.replace("WIDGET_V1", "WIDGET_V2"));
      // Wait for the widget text to update via HMR.
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"widget\"]').textContent.includes('WIDGET_V2')",
      );
      // The parent page's counter state survived (single-module swap, not a remount).
      const counter = await page.evaluate(
        "document.querySelector('[data-testid=\"counter\"]').textContent",
      );
      assertStringIncludes(String(counter), "count: 3");
      // No full page reload happened.
      const noReload = await page.evaluate("window.__noReload === true");
      assert(noReload, "a leaf-module edit must NOT trigger a full page reload");
    });

    await t.step("editing the PAGE module hot-swaps it, preserves counter state", async () => {
      const src = await Deno.readTextFile(pageFile);
      await Deno.writeTextFile(pageFile, src.replace("TITLE_V1", "TITLE_V2"));
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"title\"]').textContent.includes('TITLE_V2')",
      );
      const counter = await page.evaluate(
        "document.querySelector('[data-testid=\"counter\"]').textContent",
      );
      assertStringIncludes(String(counter), "count: 3");
      const noReload = await page.evaluate("window.__noReload === true");
      assert(noReload, "a page-module edit must NOT trigger a full page reload");
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
