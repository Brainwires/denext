// Real-browser e2e for React 19.3's Fragment refs (tests/e2e/fixtures/fragment-refs): the server
// renders a `<Fragment ref>` (ignoring the ref), hydration attaches it on the server's nodes, the
// FragmentInstance's DOM methods (focus, blur, events, rects, document position, scrolling,
// observers) pass React's own cases in headless Chromium, and the runtime arrives as its own
// on-demand `fragment-instance-*` chunk that a page without a Fragment ref never fetches.
//
// Opt-in: `deno task test:e2e` (astral downloads Chromium on first run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { buildAndServe, launchBrowser, pollFor } from "./harness.ts";

const FIXTURE = fromFileUrl(new URL("./fixtures/fragment-refs", import.meta.url));

/** The emitted on-demand Fragment-ref chunk's file name. */
async function fragmentChunk(clientDir: string): Promise<string> {
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && /^fragment-instance-.*\.js$/.test(e.name)) return e.name;
  }
  throw new Error("no fragment-instance-*.js chunk was emitted");
}

/** The client files the page fetched. */
async function loadedResources(page: { evaluate(expr: string): Promise<unknown> }) {
  return String(
    await page.evaluate(`performance.getEntriesByType("resource").map((e) => e.name).join("\\n")`),
  );
}

Deno.test({
  name: "e2e: Fragment refs hydrate, pass React's DOM cases, and load on demand",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();
  const clientDir = join(FIXTURE, ".denext", "client");
  try {
    const chunk = await fragmentChunk(clientDir);

    await t.step("the server ignores the ref", async () => {
      const html = await (await fetch(server.origin + "/")).text();
      assertStringIncludes(
        html,
        '<section id="hydrated"><span id="h-a">a</span><span id="h-b">b</span></section>',
      );
    });

    await t.step(
      "hydration attaches the ref on the server's nodes, and the cases pass",
      async () => {
        const page = await browser.newPage(server.origin + "/");
        await pollFor(page, "window.__fragSuite && window.__fragSuite.done");
        const hydrated = await page.evaluate("window.__hydrated") as Record<string, unknown>;
        assertEquals(hydrated, { attached: true, handle: true, serverNodes: 1 });
        const suite = await page.evaluate("window.__fragSuite") as {
          passed: string[];
          failures: string[];
        };
        assertEquals(suite.failures, [], suite.failures.join("\n\n"));
        assert(suite.passed.length >= 20, `ran ${suite.passed.length} cases`);
        // A ResizeObserver attached through the fragment reports the child added after it.
        await pollFor(page, "window.__roSeen && window.__roSeen.has('ro-b')");
        assert(await page.evaluate("window.__roSeen.has('ro-a')"), "and the original child");
        await page.evaluate("window.__roCleanup()");
        assertStringIncludes(await loadedResources(page), chunk, "the page fetched the runtime");
        await page.close();
      },
    );

    await t.step("a page without a Fragment ref never fetches the runtime", async () => {
      const page = await browser.newPage(server.origin + "/plain");
      await page.waitForFunction("!!document.querySelector('[data-testid=plain-count]')");
      const btn = await page.$("[data-testid=plain-count]");
      assert(btn);
      await btn.click();
      await pollFor(
        page,
        "document.querySelector('[data-testid=plain-count]').textContent === 'plain:1'",
      );
      assertEquals((await loadedResources(page)).includes(chunk), false);
      await page.close();
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
