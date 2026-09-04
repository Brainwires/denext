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
import {
  collectConsoleErrors,
  editAndAssertHotSwap,
  hydrateAndClick,
  launchBrowser,
  type RunningServer,
  startDevOnDir,
} from "./harness.ts";

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

/** Copy the fixture to a fresh temp dir (so the test can edit its source) and patch it. */
async function prepareApp(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  await copy(FIXTURE, dir, { overwrite: true });
  await patchImports(dir);
  return dir;
}

const LEAF_EDIT = {
  from: "WIDGET_V1",
  to: "WIDGET_V2",
  watch: "widget",
  counter: "counter",
  count: "count: 3",
  reloadMessage: "a leaf-module edit must NOT trigger a full page reload",
};

const PAGE_EDIT = {
  from: "TITLE_V1",
  to: "TITLE_V2",
  watch: "title",
  counter: "counter",
  count: "count: 3",
  reloadMessage: "a page-module edit must NOT trigger a full page reload",
};

const LAYOUT_EDIT = {
  from: "LAYOUT_V1",
  to: "LAYOUT_V2",
  watch: "layout-tag",
  counter: "item-counter",
  count: "n: 2",
  reloadMessage: "a nested-layout edit must NOT trigger a full page reload",
};

async function stepShell(server: RunningServer): Promise<void> {
  const html = await (await fetch(server.origin + "/")).text();
  assertStringIncludes(html, "/_denext/@entry?p=");
  assertStringIncludes(html, "TITLE_V1"); // SSR rendered
}

async function stepDynamicRouteShell(server: RunningServer): Promise<void> {
  const html = await (await fetch(server.origin + "/items/42")).text();
  assertStringIncludes(html, "/_denext/@entry?p=");
  assertStringIncludes(html, "id: 42"); // SSR rendered the param
  assertStringIncludes(html, "LAYOUT_V1"); // nested layout rendered
}

Deno.test({
  name: "e2e: unbundled dev loop — single-module HMR preserves state, no reload",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await prepareApp("denext_hmr_");

  const server = await startDevOnDir(dir, { DENEXT_DEV_UNBUNDLED: "1" });
  const browser = await launchBrowser();
  const pageFile = join(dir, "app/page.tsx");
  const widgetFile = join(dir, "app/widget.tsx");

  try {
    await t.step("shell serves the unbundled entry module", () => stepShell(server));

    const page = await browser.newPage(server.origin + "/");
    const consoleErrors = collectConsoleErrors(page);

    await t.step(
      "hydrates through the unbundled graph and is interactive",
      () => hydrateAndClick(page, "counter", 3, "count: 3", "counter button exists"),
    );
    await t.step(
      "editing a LEAF module hot-swaps it, preserves state, no reload",
      () => editAndAssertHotSwap(page, { file: widgetFile, ...LEAF_EDIT }),
    );
    await t.step(
      "editing the PAGE module hot-swaps it, preserves counter state",
      () => editAndAssertHotSwap(page, { file: pageFile, ...PAGE_EDIT }),
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

// Default-on (no DENEXT_DEV_UNBUNDLED env): the unbundled loop is the native App
// Router default. Exercises the broader surface — a DYNAMIC `[id]` route, a NESTED
// layout chain, and a nested-layout edit that hot-swaps while the child route's
// state is preserved.
Deno.test({
  name: "e2e: unbundled dev loop is default-on — dynamic route + nested-layout HMR",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await prepareApp("denext_hmr_def_");

  // No env var — proves the unbundled loop is the default for the native App Router.
  const server = await startDevOnDir(dir, {});
  const browser = await launchBrowser();
  const layoutFile = join(dir, "app/items/layout.tsx");

  try {
    await t.step(
      "dynamic route hydrates via the unbundled entry (default-on)",
      () => stepDynamicRouteShell(server),
    );

    const page = await browser.newPage(server.origin + "/items/42");
    const consoleErrors = collectConsoleErrors(page);

    await t.step(
      "param route is interactive after hydration",
      () => hydrateAndClick(page, "item-counter", 2, "n: 2", "item counter exists"),
    );
    await t.step(
      "editing a NESTED LAYOUT hot-swaps it, preserves child state",
      () => editAndAssertHotSwap(page, { file: layoutFile, ...LAYOUT_EDIT }),
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
