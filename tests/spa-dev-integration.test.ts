// In-process integration for SPA-mode DEV serving (src/build/spa.ts startSpaDevServer)
// and the unbundled SPA client entry (src/build/dev-unbundled.ts serveSpaEntry /
// spaEntryUrl). No browser: the real SPA dev server is booted on an ephemeral port and
// driven with `fetch`. The SPA has NO app/ directory — every navigation gets the HTML
// shell (history-API fallback) and the client graph is served unbundled.
//
// Target app: examples/spa.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { startSpaDevOnDir } from "./e2e/harness.ts";
import { generateSpaEntry } from "../src/build/spa/shared.ts";
import { fsUrlPath } from "../src/build/dev-unbundled/state.ts";

const SPA = fromFileUrl(new URL("../examples/spa", import.meta.url));

/** Fetch, retrying a transient 500 from a cold esbuild build (first-run dep prebundle). */
async function okFetch(url: string, init?: RequestInit): Promise<Response> {
  let res = await fetch(url, init);
  for (let i = 0; i < 4 && res.status === 500; i++) {
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 400));
    res = await fetch(url, init);
  }
  return res;
}

type Ctx = { origin: string };

async function stepShell({ origin }: Ctx): Promise<void> {
  const res = await fetch(origin + "/");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, 'id="root"');
  // Unbundled loop is default-on → the single SPA entry is served per-module.
  assertStringIncludes(html, "/_denext/@entry");
  assertStringIncludes(html, "/_denext/dev-reload.js");
}

async function stepEntry({ origin }: Ctx): Promise<void> {
  const res = await okFetch(origin + "/_denext/@entry");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
  const js = await res.text();
  // The entry enables per-module refresh and imports the app graph via dev URLs.
  assertStringIncludes(js, "/_denext/@");
  // B10: the panel only mounts when `__denextDev` is already set — nothing else in SPA
  // dev sets it, and the shell's dev script runs after this module. (esbuild hoists the
  // import declarations above the flag, as ESM does anyway; what matters is that the
  // `installDevtools()` CALL comes after it.)
  const flag = js.indexOf("__denextDev");
  assert(flag >= 0, "the served SPA dev entry sets __denextDev");
  assert(
    flag < js.indexOf("installDevtools()"),
    "__denextDev is set before installDevtools() runs in the unbundled SPA dev entry",
  );
}

async function stepFsMain({ origin }: Ctx): Promise<void> {
  const res = await okFetch(origin + fsUrlPath(join(SPA, "src/main.tsx")));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
  await res.text();
}

async function stepDevReloadJs({ origin }: Ctx): Promise<void> {
  const res = await fetch(origin + "/_denext/dev-reload.js");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
  assert((await res.text()).length > 0);
}

async function stepReloadSse({ origin }: Ctx): Promise<void> {
  const res = await fetch(origin + "/_denext/reload");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/event-stream");
  await res.body?.cancel();
}

async function stepDeepRouteFallback({ origin }: Ctx): Promise<void> {
  const res = await fetch(origin + "/some/deep/route", {
    headers: { accept: "text/html" },
  });
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), 'id="root"');
}

async function stepMissingAsset404({ origin }: Ctx): Promise<void> {
  const res = await fetch(origin + "/nope.png");
  assertEquals(res.status, 404);
  await res.body?.cancel();
}

async function stepDevLog({ origin }: Ctx): Promise<void> {
  const post = await fetch(origin + "/_denext/dev-log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      { level: "error", message: "[resource] failed to load module script /x.js", url: "/" },
      { level: "log", message: "hello from the page", url: "/" },
    ]),
  });
  assertEquals(post.status, 204);
  await post.body?.cancel();
  const res = await fetch(origin + "/_denext/dev-state?kind=console&limit=10");
  assertEquals(res.status, 200);
  const state = await res.json();
  const messages = state.events.map((e: { message: string }) => e.message);
  assert(messages.includes("[resource] failed to load module script /x.js"), messages.join("|"));
  assert(messages.includes("hello from the page"), messages.join("|"));
  assertEquals(state.projectDir, SPA);
}

async function stepDevJson({ origin }: Ctx): Promise<void> {
  const info = JSON.parse(await Deno.readTextFile(join(SPA, ".denext", "dev.json")));
  assertEquals(info.origin, origin);
  assertEquals(info.pid, Deno.pid);
}

Deno.test({
  name: "SPA dev server serves the shell + unbundled client entry",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await startSpaDevOnDir(SPA, { DENEXT_DEV_TYPECHECK: "0" });
  const ctx: Ctx = { origin: server.origin };

  try {
    await t.step(
      "GET / returns the HTML shell pointing at the unbundled entry",
      () => stepShell(ctx),
    );
    await t.step("GET /_denext/@entry serves the generated SPA client entry", () => stepEntry(ctx));
    await t.step(
      "GET /_denext/@fs<main.tsx> transforms the SPA entry module",
      () => stepFsMain(ctx),
    );
    await t.step(
      "GET /_denext/dev-reload.js serves the SPA reload runtime",
      () => stepDevReloadJs(ctx),
    );
    await t.step("GET /_denext/reload opens the SSE live-reload stream", () => stepReloadSse(ctx));
    await t.step(
      "a deep client-router URL falls back to the shell",
      () => stepDeepRouteFallback(ctx),
    );
    await t.step("a missing file-extension asset is a genuine 404", () => stepMissingAsset404(ctx));
    await t.step(
      "the page's console reaches the dev log (denext_dev_logs) via dev-log / dev-state",
      () => stepDevLog(ctx),
    );
    await t.step("SPA dev publishes .denext/dev.json for the MCP tools", () => stepDevJson(ctx));
  } finally {
    await server.close();
  }
});

Deno.test("the bundled SPA dev entry sets __denextDev before installing DevTools", () => {
  const entry = "file:///app/src/main.tsx";
  const dev = generateSpaEntry(entry, true);
  const flag = dev.indexOf("globalThis.__denextDev = true;");
  assert(flag >= 0, "the dev entry sets __denextDev");
  assert(dev.indexOf("installDevtools()") > flag, "it is set before installDevtools() runs");
  assert(dev.indexOf('from "denext/devtools"') > flag, "and before the devtools import");
  assertStringIncludes(dev, 'import { installDevtools } from "denext/devtools";');

  // …and a production entry carries neither (it must tree-shake to the bare import).
  const prod = generateSpaEntry(entry, false);
  assertEquals(prod.includes("__denextDev"), false, prod);
  assertEquals(prod.includes("installDevtools"), false, prod);
  assertEquals(prod.includes("denext/devtools"), false, prod);
});
