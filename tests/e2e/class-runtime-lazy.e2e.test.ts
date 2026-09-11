// Real-browser e2e for the on-demand class-component runtime — the case that used to crash
// production silently: an app whose only class components live in a DEPENDENCY the build's
// source scan never reads (here a `node_modules` package, materialized at test time from the
// sibling `fixtures/class-dep-vendor/` template — node_modules is git-ignored, and the template
// must live OUTSIDE the project dir or the scan would read it and choose eager mode). The build must emit the lazy entry, the server
// must stamp `#__denext_classes` on the class page, the browser must load the class-runtime
// chunk before hydrating (so `setState` and a class error boundary both work), and the
// function-only page must hydrate without ever fetching that chunk.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join } from "@std/path";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = new URL("./fixtures/class-dep", import.meta.url).pathname;
const VENDOR = new URL("./fixtures/class-dep-vendor", import.meta.url).pathname;
const DEP_DIR = join(FIXTURE, "node_modules", "@acme", "ui");

/** The client file that carries the reconciler half of the class runtime, or null. */
async function findClassChunk(clientDir: string): Promise<string | null> {
  for await (const e of Deno.readDir(clientDir)) {
    if (!e.isFile || !e.name.endsWith(".js")) continue;
    const src = await Deno.readTextFile(join(clientDir, e.name));
    if (src.includes("componentWillUnmount")) return e.name;
  }
  return null;
}

Deno.test({
  name: "e2e: a class component hidden in a dependency hydrates via the lazily loaded runtime",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await Deno.mkdir(DEP_DIR, { recursive: true });
  await copy(join(VENDOR, "acme-ui", "mod.tsx"), join(DEP_DIR, "mod.tsx"), { overwrite: true });
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  const clientDir = join(FIXTURE, ".denext", "client");

  try {
    let classChunk = "";
    await t.step("the build emits a lazy entry and a separate class-runtime chunk", async () => {
      const chunk = await findClassChunk(clientDir);
      assert(chunk, "the class runtime is emitted as a client file");
      classChunk = chunk;
      const entry = await Deno.readTextFile(join(clientDir, "flight.js"));
      assertStringIncludes(entry, "__denext_classes", "the entry probes the marker");
      assert(
        !entry.includes("componentWillUnmount"),
        "the class runtime is NOT in the entry (the scan saw no class in the app's own sources)",
      );
      assert(chunk !== "flight.js");
    });

    await t.step(
      "the server stamps the marker only on the page that rendered a class",
      async () => {
        const withClass = await (await fetch(server.origin + "/")).text();
        assertStringIncludes(withClass, 'id="__denext_classes"');
        assertStringIncludes(withClass, "count:0", "the class rendered server-side");
        const plain = await (await fetch(server.origin + "/plain")).text();
        assert(!plain.includes("__denext_classes"), "a function-only page carries no marker");
      },
    );

    await t.step(
      "the class page hydrates: setState works and the class boundary catches",
      async () => {
        const page = await browser.newPage(server.origin + "/");
        await page.waitForFunction("!!document.querySelector('[data-testid=count]')");
        const count = await page.$("[data-testid=count]");
        assert(count);
        await count.click();
        await pollFor(
          page,
          "document.querySelector('[data-testid=count]').textContent === 'count:1'",
        );
        // The runtime chunk was fetched before hydration.
        const loaded = await page.evaluate(
          `performance.getEntriesByType("resource").map((e) => e.name).join("\\n")`,
        );
        assertStringIncludes(String(loaded), classChunk, "the class-runtime chunk was loaded");
        // A render throw inside the dependency's class boundary is caught by it.
        const boom = await page.$("[data-testid=boom]");
        assert(boom);
        await boom.click();
        await pollFor(page, "!!document.querySelector('[data-testid=fallback]')");
        assert(
          await page.evaluate("!!document.querySelector('[data-testid=shell]')"),
          "the layout shell survived",
        );
        await page.close();
      },
    );

    await t.step("the function-only page hydrates without fetching the class chunk", async () => {
      const page = await browser.newPage(server.origin + "/plain");
      await page.waitForFunction("!!document.querySelector('[data-testid=plain-count]')");
      const btn = await page.$("[data-testid=plain-count]");
      assert(btn);
      await btn.click();
      await pollFor(
        page,
        "document.querySelector('[data-testid=plain-count]').textContent === 'plain:1'",
      );
      const loaded = await page.evaluate(
        `performance.getEntriesByType("resource").map((e) => e.name).join("\\n")`,
      );
      assertEquals(
        String(loaded).includes(classChunk),
        false,
        "a function-only page never downloads the class runtime",
      );
      await page.close();
    });
  } finally {
    await browser.close();
    await server.close();
    await Deno.remove(join(FIXTURE, "node_modules"), { recursive: true }).catch(() => {});
  }
});
