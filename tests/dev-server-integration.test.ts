// In-process integration tests for the DEV HTTP server (src/build/dev-server.ts)
// and the unbundled per-module dev pipeline (src/build/dev-unbundled.ts). No
// browser: the real dev server is booted on an ephemeral port via the e2e harness
// and driven with `fetch`. One server boot is reused across every `t.step` — a boot
// is expensive (esbuild dep prebundle, route scan), so we assert the whole endpoint
// surface against a single running instance.
//
// Target app: examples/hello (native App Router; the unbundled loop is default-on).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startDevOnDir } from "./e2e/harness.ts";

const HELLO = new URL("../examples/hello", import.meta.url).pathname;

/** Drain + discard a response body so no reader leaks (SSE especially). */
async function drop(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch { /* already consumed */ }
}

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

Deno.test({
  name: "dev server (unbundled default-on) serves the full dev + app surface",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  // DENEXT_EDITOR=true → the open-in-editor endpoint spawns the harmless `true`
  // binary instead of launching the developer's real editor. DEV_TYPECHECK=0 keeps
  // the async `deno check` off the loop.
  // Unbundled mode is requested per-server (not via the process-global DENEXT_DEV_UNBUNDLED),
  // so a parallel test flipping that env var can't knock this server into bundled mode.
  const server = await startDevOnDir(HELLO, {
    DENEXT_EDITOR: "true",
    DENEXT_DEV_TYPECHECK: "0",
  }, { unbundled: true });

  try {
    await t.step("GET / renders SSR HTML with the external dev-reload script", async () => {
      const res = await fetch(server.origin + "/");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
      const html = await res.text();
      assertStringIncludes(html, "Hello from denext");
      // The dev server injects the reload runtime as an EXTERNAL same-origin module.
      assertStringIncludes(html, "/_denext/dev-reload.js");
      // Unbundled loop is default-on → the shell hydrates from the @entry module.
      assertStringIncludes(html, "/_denext/@entry?p=");
    });

    await t.step("GET /_denext/dev-reload.js serves the reload runtime as JS", async () => {
      const res = await fetch(server.origin + "/_denext/dev-reload.js");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      const js = await res.text();
      assertStringIncludes(js, "__denextDev");
      assertStringIncludes(js, "EventSource");
    });

    await t.step("GET /_denext/health is a plain-text liveness probe", async () => {
      const res = await fetch(server.origin + "/_denext/health");
      assertEquals(res.status, 200);
      assertEquals((await res.text()).trim(), "ok");
    });

    await t.step(
      "dev black box: a browser log POST is recorded and read back via dev-state",
      async () => {
        const post = await fetch(server.origin + "/_denext/dev-log", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            level: "warn",
            message: "hydration mismatch on <div>",
            url: "/x",
          }),
        });
        assertEquals(post.status, 204);
        await drop(post);

        const state = await (await fetch(server.origin + "/_denext/dev-state")).json();
        const found = state.events.find((e: { message: string }) =>
          e.message.includes("hydration mismatch")
        );
        assert(found, "the browser log should be in the dev state");
        assertEquals(found.kind, "console");
        assertEquals(found.source, "browser");
      },
    );

    await t.step("dev black box: dev-state honors a kind filter", async () => {
      const state = await (await fetch(server.origin + "/_denext/dev-state?kind=console")).json();
      assert(
        state.events.every((e: { kind: string }) => e.kind === "console"),
        "only console events",
      );
    });

    await t.step("dev black box: a cross-origin reader is refused (403)", async () => {
      const res = await fetch(server.origin + "/_denext/dev-state", {
        headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      });
      assertEquals(res.status, 403);
      await drop(res);
    });

    await t.step(
      "dev black box: a completed app request is recorded as a request event",
      async () => {
        await drop(await fetch(server.origin + "/about"));
        const state = await (await fetch(server.origin + "/_denext/dev-state?kind=request")).json();
        assert(state.events.length > 0, "at least one request event recorded");
        assert(
          state.events.every((e: { kind: string }) => e.kind === "request"),
          "kind=request filter applied",
        );
        const about = state.events.find((e: { url: string }) => e.url === "/about");
        assert(about, "the /about request was recorded");
        assertEquals(about.status, 200);
        assertEquals(typeof about.durationMs, "number");
      },
    );

    await t.step("GET /_denext/reload opens an SSE stream (same-origin allowed)", async () => {
      const res = await fetch(server.origin + "/_denext/reload");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/event-stream");
      // First frame is the reconnect hint.
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      assertStringIncludes(new TextDecoder().decode(value), "retry:");
      await reader.cancel();
    });

    await t.step("cross-origin subscriber to /_denext/reload is refused (403)", async () => {
      const res = await fetch(server.origin + "/_denext/reload", {
        headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      });
      assertEquals(res.status, 403);
      await drop(res);
    });

    await t.step("open-in-editor: cross-site request is refused", async () => {
      const res = await fetch(server.origin + "/_denext/open-in-editor?file=x&line=1", {
        headers: { "sec-fetch-site": "cross-site" },
      });
      assertEquals(res.status, 403);
      await drop(res);
    });

    await t.step("open-in-editor: an out-of-project file is rejected (400)", async () => {
      const res = await fetch(
        server.origin + "/_denext/open-in-editor?file=" + encodeURIComponent("/etc/passwd"),
      );
      assertEquals(res.status, 400);
      await drop(res);
    });

    await t.step("open-in-editor: an in-project file launches the (stub) editor", async () => {
      const file = join(HELLO, "app/page.tsx");
      const res = await fetch(
        server.origin + "/_denext/open-in-editor?file=" + encodeURIComponent(file) +
          "&line=3&column=2",
      );
      // `true` spawns cleanly → 200 "ok". If a platform can't spawn it, 501 "no editor".
      assert(res.status === 200 || res.status === 501, `unexpected status ${res.status}`);
      await drop(res);
    });

    await t.step("GET /_denext/image with no url param is a 400", async () => {
      const res = await fetch(server.origin + "/_denext/image");
      assertEquals(res.status, 400);
      await drop(res);
    });

    await t.step("GET /_denext/@empty.js is the stylesheet-import shim", async () => {
      const res = await fetch(server.origin + "/_denext/@empty.js");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      assertStringIncludes(await res.text(), "export default");
    });

    await t.step("GET /_denext/@entry?p=/ serves the unbundled route client entry", async () => {
      const res = await okFetch(server.origin + "/_denext/@entry?p=" + encodeURIComponent("/"));
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      const js = await res.text();
      // The entry's imports were rewritten to same-origin dev URLs.
      assertStringIncludes(js, "/_denext/@");
    });

    await t.step("GET /_denext/@entry?p=/nope is a JS 404 stub", async () => {
      const res = await fetch(server.origin + "/_denext/@entry?p=" + encodeURIComponent("/nope"));
      assertEquals(res.status, 404);
      assertStringIncludes(await res.text(), "route not found");
    });

    await t.step("GET /_denext/@fs<page> transforms a first-party module", async () => {
      const file = join(HELLO, "app/page.tsx");
      const res = await okFetch(server.origin + "/_denext/@fs" + file);
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      const js = await res.text();
      // esbuild lowered the JSX; the denext runtime import points at a dev @dep URL.
      assertStringIncludes(js, "/_denext/@dep/");
    });

    await t.step("GET /_denext/@dep/denext.js prebundles the framework dep", async () => {
      const res = await okFetch(server.origin + "/_denext/@dep/denext.js");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      assert((await res.text()).length > 0, "dep bundle is non-empty");
    });

    await t.step("GET /_denext/@dep/missing.js is a JS 404", async () => {
      const res = await fetch(server.origin + "/_denext/@dep/does-not-exist.js");
      assertEquals(res.status, 404);
      assertStringIncludes(await res.text(), "dep not found");
    });

    await t.step("GET /_denext/route.css?p=/ serves the route's extracted CSS", async () => {
      const res = await okFetch(server.origin + "/_denext/route.css?p=" + encodeURIComponent("/"));
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/css");
      await res.text();
    });

    await t.step("GET /_denext/flight.js serves the app-wide flight client entry", async () => {
      const res = await okFetch(server.origin + "/_denext/flight.js");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
      await res.text();
    });

    await t.step("GET /_denext/route.js?p=/nope (bundled path) is a 404", async () => {
      const res = await fetch(server.origin + "/_denext/route.js?p=" + encodeURIComponent("/nope"));
      assertEquals(res.status, 404);
      assertStringIncludes(await res.text(), "route not found");
    });

    await t.step("app route: GET /about renders", async () => {
      const res = await fetch(server.origin + "/about");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
      await res.text();
    });

    await t.step("app route: dynamic /blog/[slug] renders the slug", async () => {
      const res = await fetch(server.origin + "/blog/deno-rocks");
      assertEquals(res.status, 200);
      assertStringIncludes(await res.text(), "deno-rocks");
    });

    await t.step("api route: GET /api/hello?name=Ada returns JSON", async () => {
      const res = await fetch(server.origin + "/api/hello?name=Ada");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
      const body = await res.json();
      assertEquals(body.message, "Hello, Ada!");
    });

    await t.step("api route: POST /api/hello echoes the body with 201", async () => {
      const res = await fetch(server.origin + "/api/hello", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      assertEquals(res.status, 201);
      const body = await res.json();
      assertEquals(body.youSent.a, 1);
    });

    await t.step("public asset: GET /styles.css is served from public/", async () => {
      const res = await fetch(server.origin + "/styles.css");
      assertEquals(res.status, 200);
      assertStringIncludes(res.headers.get("content-type") ?? "", "css");
      await res.text();
    });

    await t.step("unknown route: GET /definitely/not/here is a 404", async () => {
      const res = await fetch(server.origin + "/definitely/not/here");
      assertEquals(res.status, 404);
      await drop(res);
    });
  } finally {
    await server.close();
  }
});
