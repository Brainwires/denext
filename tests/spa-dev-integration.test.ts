// In-process integration for SPA-mode DEV serving (src/build/spa.ts startSpaDevServer)
// and the unbundled SPA client entry (src/build/dev-unbundled.ts serveSpaEntry /
// spaEntryUrl). No browser: the real SPA dev server is booted on an ephemeral port and
// driven with `fetch`. The SPA has NO app/ directory — every navigation gets the HTML
// shell (history-API fallback) and the client graph is served unbundled.
//
// Target app: examples/spa.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startSpaDevOnDir } from "./e2e/harness.ts";

const SPA = new URL("../examples/spa", import.meta.url).pathname;

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
}

async function stepFsMain({ origin }: Ctx): Promise<void> {
  const res = await okFetch(origin + "/_denext/@fs" + join(SPA, "src/main.tsx"));
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
  } finally {
    await server.close();
  }
});
