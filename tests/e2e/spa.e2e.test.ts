// Real-browser E2E for SPA mode ("React but not Next", `mode: "spa"`). The fixture
// has NO app/ directory — denext bundles src/main.tsx, wraps it in an HTML shell,
// and serves that shell for every navigation (history-API fallback). This proves:
//   1. the server sends a shell with an EMPTY #root (no SSR markup);
//   2. denext's own createRoot mounts the client-only app and it becomes interactive;
//   3. a deep URL (client-router route) still returns the shell (history fallback).
//
// Opt-in: run with `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildAndServe } from "./harness.ts";
import { launchBrowser } from "./harness.ts";

const FIXTURE = new URL("./fixtures/spa", import.meta.url).pathname;

Deno.test({
  name: "e2e: SPA mode boots a client-only app on denext's createRoot (no SSR markup)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServe(FIXTURE);
  const browser = await launchBrowser();

  try {
    await t.step("server sends an HTML shell with an empty #root (no SSR)", async () => {
      const res = await fetch(server.origin + "/");
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
      const html = await res.text();
      assertStringIncludes(html, '<div id="root"></div>');
      assertStringIncludes(html, "/_denext/client/index.js");
      // No server-rendered app content — the SPA fills #root on the client.
      assert(!html.includes("Home view"), "shell must not contain client-rendered content");
    });

    await t.step(
      "a deep client-router URL still returns the shell (history fallback)",
      async () => {
        const res = await fetch(server.origin + "/some/deep/route", {
          headers: { accept: "text/html" },
        });
        assertEquals(res.status, 200);
        assertStringIncludes(await res.text(), '<div id="root"></div>');
      },
    );

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const detail = (e as any).detail;
      if (detail?.type === "error") consoleErrors.push(String(detail.text ?? ""));
    });

    await t.step("the app mounts and renders on the client", async () => {
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"view\"]') && " +
          "document.querySelector('[data-testid=\"view\"]').textContent === 'Home view'",
      );
    });

    await t.step("client interactivity works (state updates via denext hooks)", async () => {
      await page.evaluate("document.querySelector('[data-testid=\"counter\"]').click()");
      await page.evaluate("document.querySelector('[data-testid=\"counter\"]').click()");
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"counter\"]').textContent === 'count 2'",
      );
    });

    await t.step("client-owned view switching works", async () => {
      await page.evaluate("document.querySelector('[data-testid=\"to-about\"]').click()");
      await page.waitForFunction(
        "document.querySelector('[data-testid=\"view\"]').textContent === 'About view'",
      );
    });

    await t.step("no console errors during mount + interaction", () => {
      assert(
        consoleErrors.length === 0,
        `unexpected console errors:\n${consoleErrors.join("\n")}`,
      );
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
