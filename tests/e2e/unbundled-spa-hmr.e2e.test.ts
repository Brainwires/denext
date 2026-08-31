// Real-browser end-to-end test for the UNBUNDLED dev loop on a SPA (`mode: "spa"`).
//
// A denext-native SPA (createRoot + client-owned state, no App Router). Under the
// unbundled dev loop the SPA's own entry + module graph are served per-module, so
// editing a component hot-swaps ONLY that module with its useState preserved and NO
// full reload — instead of re-bundling the whole SPA (`deno bundle`) on each save.
//
// Opt-in: run with `deno task test:e2e`. Excluded from `deno task test`/`check`.

import { assert, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import { launchBrowser, startSpaDevOnDir } from "./harness.ts";

const FIXTURE = new URL("./fixtures/spa", import.meta.url).pathname;
const FRAMEWORK_ROOT = new URL("../../", import.meta.url).pathname;

/** Give the copied SPA a deno.json mapping `denext*` to absolute framework URLs. */
async function writeImports(dir: string): Promise<void> {
  const abs = (rel: string) => toFileUrl(join(FRAMEWORK_ROOT, rel)).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
}

Deno.test({
  name: "e2e: unbundled dev loop — SPA per-module HMR preserves state, no reload",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_hmr_" });
  await copy(FIXTURE, dir, { overwrite: true });
  await writeImports(dir);
  await Deno.remove(join(dir, ".denext"), { recursive: true }).catch(() => {});

  const server = await startSpaDevOnDir(dir, {});
  const browser = await launchBrowser();
  const appFile = join(dir, "src/app.tsx");

  try {
    await t.step("the shell points at the unbundled SPA entry", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(html, "/_denext/@entry");
    });

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const d = (e as any).detail;
      if (d?.type === "error") consoleErrors.push(String(d.text ?? ""));
    });

    await t.step("SPA mounts (createRoot) and is interactive", async () => {
      await page.waitForFunction("!!document.querySelector('[data-testid=\"counter\"]')");
      await page.evaluate("window.__noReload = true");
      const btn = await page.$('[data-testid="counter"]');
      assert(btn, "counter exists");
      await btn.click();
      await btn.click();
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"counter\"]').textContent.includes('count 2')",
      );
    });

    await t.step("editing App hot-swaps it in place, preserves count state", async () => {
      const src = await Deno.readTextFile(appFile);
      await Deno.writeTextFile(appFile, src.replace("Home view", "Home view V2"));
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"view\"]').textContent.includes('Home view V2')",
      );
      const counter = await page.evaluate(
        "document.querySelector('[data-testid=\"counter\"]').textContent",
      );
      assertStringIncludes(String(counter), "count 2");
      const noReload = await page.evaluate("window.__noReload === true");
      assert(noReload, "a component edit must NOT trigger a full page reload");
    });

    await t.step("no console errors during mount + HMR", () => {
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(" | ")}`);
    });
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
