// Real-browser E2E for the compact isomorphic soft-nav payload + per-route CSS
// swap. Two interactive (non-Flight) routes each own a per-route stylesheet that
// sets the SAME `.probe` selector to a DIFFERENT color, so a soft nav between them
// is only observable via getComputedStyle if the per-route <link> is actually
// swapped — the behavior the unit tests assert structurally but not visually. The
// test also pins the server contract: a soft nav to an isomorphic route answers
// with the compact `x-denext-iso` JSON (title/data/entry/styles), not full HTML.
//
// Why the stylesheets are written as build artifacts instead of `.css` imports:
// Deno cannot `import()` a `.css` module at runtime (cli.ts re-execs with a
// generated `--config` to resolve them), and the in-process E2E harness does not
// do that re-exec — so a `.css` import would break SSR here. `styleHrefsFor`
// (which drives both the marked <link>s and the iso payload's `styles`) only stats
// `<routeId>.css` in the client dir, so writing those two files after `build()` —
// exactly what the CSS pipeline produces — sets up the identical server state
// without a `.css` import. The extraction step itself is covered by the CSS unit
// tests; this test covers the client swap + the browser applying it.
//
// Opt-in: run with `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { Page } from "@astral/astral";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";
import type { IsoNavPayload } from "../../src/server/document.ts";
import {
  assertNoConsoleErrors,
  collectConsoleErrors,
  launchBrowser,
  type RunningServer,
} from "./harness.ts";

const FIXTURE = new URL("./fixtures/iso-css", import.meta.url).pathname;

/**
 * Build, then write the two per-route stylesheet artifacts the CSS pipeline would
 * otherwise emit (see the header note), then serve — mirroring harness.buildAndServe.
 */
async function buildAndServeWithRouteCss(): Promise<RunningServer> {
  const { outDir } = await build(FIXTURE);
  const clientDir = join(outDir, "client");
  await Deno.writeTextFile(join(clientDir, "index.css"), ".probe{color:rgb(255,0,0)}");
  await Deno.writeTextFile(join(clientDir, "about.css"), ".probe{color:rgb(0,128,0)}");

  const controller = new AbortController();
  const listening = Promise.withResolvers<{ hostname: string; port: number }>();
  const prod = await startProdServer({
    projectDir: FIXTURE,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: (info) => listening.resolve(info),
  });
  const { hostname, port } = await listening.promise;
  const origin = `http://${hostname}:${port}`;
  return {
    origin,
    close: async () => {
      controller.abort();
      await prod.finished;
    },
  };
}

/** The hrefs of the per-route stylesheet <link>s currently in the document. */
function routeCssLinks(page: Page): Promise<string[]> {
  return page.evaluate(
    "Array.from(document.querySelectorAll('link[data-dnx-css]')).map((l) => l.href)",
  ) as Promise<string[]>;
}

async function stepIsoPayload(server: RunningServer): Promise<void> {
  const res = await fetch(server.origin + "/about", { headers: { "x-denext-nav": "1" } });
  assertEquals(res.headers.get("x-denext-iso"), "1");
  assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
  const payload = await res.json() as IsoNavPayload;
  assert(!JSON.stringify(payload).includes("<!DOCTYPE"), "iso payload must not be HTML");
  assertEquals(payload.data.pathname, "/about");
  assert(
    (payload.styles ?? []).some((h) => h.includes("about.css")),
    `iso payload should carry the route's stylesheet; got ${JSON.stringify(payload.styles)}`,
  );
}

async function stepHomeStyles(page: Page): Promise<void> {
  await page.waitForFunction("!!document.querySelector('[data-testid=\"counter\"]')");
  await page.waitForFunction(
    "getComputedStyle(document.querySelector('.probe')).color === 'rgb(255, 0, 0)'",
  );
  const css = await routeCssLinks(page);
  assertEquals(css.length, 1, "one per-route stylesheet on the home route");
  assertStringIncludes(css[0], "index.css");
}

async function stepSoftNavAbout(page: Page): Promise<void> {
  // A full reload would wipe this flag; a soft nav preserves it.
  await page.evaluate("window.__noReload = true");
  await page.evaluate(
    "document.querySelector('[data-testid=\"to-about\"]').click()",
  );
  await page.waitForFunction("location.pathname === '/about'");
  // The new route rendered (its own text) and its swapped-in stylesheet applied.
  await page.waitForFunction(
    "document.querySelector('.probe') && document.querySelector('.probe').textContent === 'about'",
  );
  await page.waitForFunction(
    "getComputedStyle(document.querySelector('.probe')).color === 'rgb(0, 128, 0)'",
  );
  const survived = await page.evaluate("window.__noReload === true");
  assert(survived, "soft nav must not trigger a full page reload");
  // The previous route's stylesheet was removed; only about's remains.
  const css = await routeCssLinks(page);
  assertEquals(css.length, 1, "the previous route's stylesheet was removed");
  assertStringIncludes(css[0], "about.css");
}

async function stepSoftNavHome(page: Page): Promise<void> {
  await page.evaluate("document.querySelector('[data-testid=\"to-home\"]').click()");
  await page.waitForFunction("location.pathname === '/'");
  await page.waitForFunction(
    "getComputedStyle(document.querySelector('.probe')).color === 'rgb(255, 0, 0)'",
  );
  const css = await routeCssLinks(page);
  assertEquals(css.length, 1);
  assertStringIncludes(css[0], "index.css");
}

Deno.test({
  name: "e2e: isomorphic soft nav sends the compact iso payload and swaps per-route CSS",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await buildAndServeWithRouteCss();
  const browser = await launchBrowser();

  try {
    await t.step(
      "server answers a soft nav with the compact iso JSON, not HTML",
      () => stepIsoPayload(server),
    );

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors = collectConsoleErrors(page);

    await t.step(
      "home route: its stylesheet is linked and applied (probe is red)",
      () => stepHomeStyles(page),
    );
    await t.step(
      "soft nav to /about swaps the stylesheet (probe turns green, no reload)",
      () => stepSoftNavAbout(page),
    );
    await t.step(
      "soft nav back home swaps the stylesheet back (probe red again)",
      () => stepSoftNavHome(page),
    );
    await t.step(
      "no console errors during hydration and the CSS-swapping navs",
      () => assertNoConsoleErrors(consoleErrors),
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
