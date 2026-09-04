// SPA mode integration (src/build/spa.ts): boot the SPA dev server (both the
// unbundled per-module loop AND the bundled fallback) and the production server
// in-process on an ephemeral port and drive them over `fetch` — no browser. Also
// unit-covers the pure `classifySpaChange` / `generateSpaEntry` dev-branch helpers.
//
// The full browser round-trip lives in tests/e2e/spa*.e2e.test.ts (opt-in).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildSpa,
  classifySpaChange,
  generateSpaEntry,
  startSpaProdServer,
} from "../src/build/spa.ts";
import { resolveProject } from "../src/build/paths.ts";
import { startSpaDevOnDir } from "./e2e/harness.ts";

const SPA = new URL("../examples/spa", import.meta.url).pathname;

/** Read the first SSE chunk from an endpoint, then cancel (the stream never ends). */
async function firstSseChunk(url: string): Promise<string> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

/** A navigation `HEAD` is a 200 with an empty body. */
async function headNavigationNoBody(origin: string): Promise<void> {
  const res = await fetch(origin + "/", { method: "HEAD" });
  assertEquals(res.status, 200);
  assertEquals((await res.text()).length, 0);
}

/** `path` is a 404 (body discarded). */
async function expect404(origin: string, path: string): Promise<void> {
  const res = await fetch(origin + path);
  assertEquals(res.status, 404);
  await res.body?.cancel();
}

/** A deep client-router URL (history fallback) returns the shell. */
async function expectShellAt(origin: string, path: string): Promise<void> {
  const res = await fetch(origin + path, { headers: { accept: "text/html" } });
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), '<div id="root"></div>');
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

Deno.test("classifySpaChange: entry / public edits force a full reload, else refresh", () => {
  const entry = "/proj/src/main.tsx";
  const pub = "/proj/public";
  // A component-source edit → Fast Refresh.
  assertEquals(classifySpaChange(["/proj/src/app.tsx"], entry, pub), "refresh");
  // The entry module itself → full reload (its mount may have changed).
  assertEquals(classifySpaChange(["/proj/src/app.tsx", entry], entry, pub), "reload");
  // A public/ asset → full reload (not part of the module graph).
  assertEquals(classifySpaChange([join(pub, "logo.svg")], entry, pub), "reload");
  // The public dir itself → reload.
  assertEquals(classifySpaChange([pub], entry, pub), "reload");
  // Empty batch → refresh (nothing forces a reload).
  assertEquals(classifySpaChange([], entry, pub), "refresh");
});

Deno.test("generateSpaEntry: prod is a bare import; dev installs Fast Refresh first", () => {
  const prod = generateSpaEntry("file:///app/src/main.tsx");
  assertStringIncludes(prod, 'import "file:///app/src/main.tsx";');
  assert(!prod.includes("enableFastRefresh"), "prod entry ships no refresh runtime");

  const dev = generateSpaEntry("file:///app/src/main.tsx", true);
  assertStringIncludes(dev, "enableFastRefresh()");
  // The user entry is pulled in dynamically AFTER refresh is enabled.
  assertStringIncludes(dev, 'await import("file:///app/src/main.tsx");');
});

// ── Dev server: bundled fallback (DENEXT_DEV_UNBUNDLED=0) ─────────────────────

async function stepBundledShell(origin: string): Promise<void> {
  const res = await fetch(origin + "/");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const shellHtml = await res.text();
  assertStringIncludes(shellHtml, '<div id="root"></div>');
  // Bundled path links the whole-bundle entry + the dev-reload module.
  assertStringIncludes(shellHtml, "/_denext/client/index.js");
  assertStringIncludes(shellHtml, "/_denext/dev-reload.js");
  assert(!shellHtml.includes("Hello from a denext SPA"), "no SSR content");
}

async function stepBundledEntryJs(origin: string): Promise<void> {
  const res = await fetch(origin + "/_denext/client/index.js");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
  assertEquals(res.headers.get("cache-control"), "no-store");
  const js = await res.text();
  assert(js.length > 0, "bundle is non-empty");
}

async function stepBundledDevReloadJs(origin: string): Promise<void> {
  const res = await fetch(origin + "/_denext/dev-reload.js");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
  assertStringIncludes(await res.text(), "EventSource");
}

async function stepBundledReloadSse(origin: string): Promise<void> {
  const chunk = await firstSseChunk(origin + "/_denext/reload");
  assertStringIncludes(chunk, "retry:");
}

Deno.test({
  name: "SPA dev server (bundled): serves shell, entry bundle, reload SSE, history fallback",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // Per-server bundled mode (parallel-safe), not the process-global DENEXT_DEV_UNBUNDLED.
  const server = await startSpaDevOnDir(SPA, {}, { unbundled: false });
  const { origin } = server;
  try {
    await t.step(
      "GET / returns the HTML shell with an empty #root + dev-reload",
      () => stepBundledShell(origin),
    );
    await t.step("the entry bundle is served as JS (no-store)", () => stepBundledEntryJs(origin));
    await t.step("the dev-reload client module is served", () => stepBundledDevReloadJs(origin));
    await t.step(
      "the live-reload SSE endpoint opens with a retry hint",
      () => stepBundledReloadSse(origin),
    );
    await t.step(
      "a deep client-router URL returns the shell (history fallback)",
      () => expectShellAt(origin, "/deep/route"),
    );
    await t.step(
      "HEAD on a navigation returns 200 with no body",
      () => headNavigationNoBody(origin),
    );
    await t.step(
      "a missing client asset is a 404",
      () => expect404(origin, "/_denext/client/nope.js"),
    );
    await t.step(
      "a path with a file extension that isn't an asset is a 404",
      () => expect404(origin, "/missing.png"),
    );
  } finally {
    await server.close();
  }
});

// ── Dev server: unbundled per-module loop (default) ──────────────────────────

Deno.test({
  name: "SPA dev server (unbundled): shell points at the per-module entry, modules served",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const server = await startSpaDevOnDir(SPA);
  try {
    let entrySrc = "";
    await t.step("the shell links the unbundled entry under /_denext/@", async () => {
      const res = await fetch(server.origin + "/");
      assertEquals(res.status, 200);
      const html = await res.text();
      assertStringIncludes(html, '<div id="root"></div>');
      const m = html.match(/<script type="module" src="(\/_denext\/@[^"]+)"/);
      assert(m, "unbundled entry script is linked");
      entrySrc = m![1];
    });

    await t.step("the per-module entry is served as JS", async () => {
      const res = await fetch(server.origin + entrySrc);
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      const js = await res.text();
      assert(js.length > 0, "entry module is non-empty");
    });

    await t.step("the reload SSE endpoint works on the unbundled path too", async () => {
      const chunk = await firstSseChunk(server.origin + "/_denext/reload");
      assertStringIncludes(chunk, "retry:");
    });

    await t.step("a deep URL still returns the shell", async () => {
      const res = await fetch(server.origin + "/x/y/z", { headers: { accept: "text/html" } });
      assertEquals(res.status, 200);
      assertStringIncludes(await res.text(), '<div id="root"></div>');
    });
  } finally {
    await server.close();
  }
});

// ── Production server (denext build → denext start) ──────────────────────────

async function stepProdShell(origin: string): Promise<void> {
  const res = await fetch(origin + "/");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  assertEquals(res.headers.get("cache-control"), "no-cache");
  const html = await res.text();
  assertStringIncludes(html, '<div id="root"></div>');
  // Prod ships no dev-reload script.
  assert(!html.includes("dev-reload"), "prod shell has no dev-reload");
}

async function stepProdImmutableAssets(origin: string): Promise<void> {
  const res = await fetch(origin + "/_denext/client/index.js");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("cache-control") ?? "", "immutable");
  await res.body?.cancel();
}

Deno.test({
  name: "SPA production server: serves the built shell + immutable assets, history fallback",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const paths = await resolveProject(SPA);
  await buildSpa(paths);

  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = await startSpaProdServer({
    projectDir: SPA,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: (info) => resolve(info),
  });
  const { hostname, port } = await promise;
  const origin = `http://${hostname}:${port}`;

  try {
    await t.step("GET / serves the built shell (no-cache)", () => stepProdShell(origin));
    await t.step("client assets are immutable-cached", () => stepProdImmutableAssets(origin));
    await t.step(
      "a deep URL returns the shell (history fallback)",
      () => expectShellAt(origin, "/deep/link"),
    );
    await t.step(
      "HEAD on a navigation returns 200 with no body",
      () => headNavigationNoBody(origin),
    );
    await t.step(
      "a missing client asset is a 404",
      () => expect404(origin, "/_denext/client/missing.js"),
    );
    await t.step(
      "an unknown path with an extension is a 404",
      () => expect404(origin, "/nope.png"),
    );
  } finally {
    controller.abort();
    await server.finished;
    // The build wrote into examples/spa/.denext — clean it up.
    await Deno.remove(join(paths.outDir), { recursive: true }).catch(() => {});
  }
});
