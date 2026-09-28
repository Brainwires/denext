// Real-browser E2E of the desktop capability bridge: the REAL runtime handler + bridge
// (tests/helpers/desktop-bridge-server.ts) serving a shell whose script is the REAL page-side
// client (src/desktop/client.ts + a `denext/mobile` function) bundled for the browser, loaded in
// headless Chromium. Proves that:
//   1. the top-level document reads the injected `__denext` (desktop + token + os) and completes
//      `echo.ping`, receives `pong` over the event stream, and a disabled cap falls back to web;
//   2. a FOREIGN-origin page in the same browser cannot call the RPC or open the event stream,
//      even knowing the port and the token (the preflight is refused), and an iframe of the app
//      gets no token;
//   3. the event stream sends `: ping` heartbeats (15 s).
//
// Opt-in: `deno task test:e2e`. The wire contract without a browser: tests/desktop-bridge-wire.test.ts.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { echoCapability } from "../../src/desktop/caps/echo.ts";
import type { DesktopCapability } from "../../src/desktop/extension.ts";
import { injectedGlobal, startBridgeServer, until } from "../helpers/desktop-bridge-server.ts";
import { launchBrowser } from "./harness.ts";

const ROOT = new URL("../../", import.meta.url);

/** Bundle the page-side client (+ readClipboard) into one browser IIFE exposing `__bridge`. */
async function bundleClient(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-bridge-bundle-" });
  try {
    const entry = join(dir, "entry.ts");
    const src = (p: string) => new URL(p, ROOT).href;
    await Deno.writeTextFile(
      entry,
      `import { desktopExtension, isDesktopBridgeError, onDesktopEvent } from "${
        src("src/desktop/client.ts")
      }";\n` +
        `import { readClipboard } from "${src("src/mobile/clipboard.ts")}";\n` +
        "(globalThis as Record<string, unknown>).__bridge = " +
        "{ desktopExtension, isDesktopBridgeError, onDesktopEvent, readClipboard };\n",
    );
    const out = join(dir, "client.js");
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["bundle", "--platform=browser", "--format=iife", "-o", out, entry],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(code, 0, new TextDecoder().decode(stderr));
    return await Deno.readTextFile(out);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** The desktop page: ping, pong, a disabled-cap fallback; results on `window.__result`. */
const PAGE_SCRIPT = `
(async () => {
  const r = { global: globalThis.__denext ?? null };
  try {
    const echo = __bridge.desktopExtension("echo");
    r.ping = await echo.ping({ hi: 1 });
    r.pong = await new Promise((resolve) => {
      const stop = __bridge.onDesktopEvent("echo", "pong", (d) => { stop(); resolve(d); });
      echo.emitPong({ n: 7 });
    });
    try { await __bridge.desktopExtension("scanner").list({}); r.disabled = "resolved?!"; }
    catch (e) { r.disabled = __bridge.isDesktopBridgeError(e) ? e.code : String(e); }
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      readText: () => Promise.resolve("from-web"), writeText: () => Promise.resolve() } });
    r.clipboard = await __bridge.readClipboard();
  } catch (e) { r.error = String(e && e.stack || e); }
  window.__result = r;
})();`;

/** The foreign page's probe, given the bridge origin and (worst case) the leaked token. */
const foreignScript = (bridge: string, token: string) => `
(async () => {
  const r = {};
  const attempt = async (name, fn) => {
    try { const res = await fn(); r[name] = "status " + res.status + " " + res.type; }
    catch (e) { r[name] = "blocked: " + e.name; }
  };
  const body = JSON.stringify({ cap: "probe", method: "hit", args: null });
  await attempt("rpcCors", () => fetch("${bridge}/_denext/desktop/rpc", { method: "POST",
    headers: { "content-type": "application/json", "x-denext-desktop-token": "${token}" }, body }));
  await attempt("eventsCors", () => fetch("${bridge}/_denext/desktop/events",
    { headers: { "x-denext-desktop-token": "${token}" } }));
  await attempt("rpcNoCors", () => fetch("${bridge}/_denext/desktop/rpc",
    { method: "POST", mode: "no-cors", body }));
  await attempt("eventsNoCors", () => fetch("${bridge}/_denext/desktop/events", { mode: "no-cors" }));
  await new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.onload = resolve; f.onerror = resolve; f.src = "${bridge}/";
    document.body.appendChild(f);
  });
  window.__result = r;
})();`;

Deno.test({
  name: "e2e: desktop bridge in Chromium — the app page calls the bridge, a foreign page cannot",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  let hits = 0;
  const probe: DesktopCapability = {
    name: "probe",
    methods: { hit: { handler: () => ++hits } },
  };
  const clientJs = await bundleClient();
  const server = await startBridgeServer([echoCapability, probe], {
    indexHtml: "<!doctype html><html><head><title>desktop</title></head><body>" +
      '<script src="/client.js"></script><script src="/page.js"></script></body></html>',
    files: { "client.js": clientJs, "page.js": PAGE_SCRIPT },
  });
  // A second, foreign origin (another loopback port) serving the attacker page.
  const foreignAbort = new AbortController();
  const { promise: fport, resolve } = Promise.withResolvers<number>();
  const foreign = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    signal: foreignAbort.signal,
    onListen: ({ port }) => resolve(port),
  }, () =>
    new Response(
      `<!doctype html><html><body><script>${
        foreignScript(server.origin, server.token)
      }</script></body></html>`,
      { headers: { "content-type": "text/html" } },
    ));
  const foreignOrigin = `http://localhost:${await fport}`;
  const browser = await launchBrowser();
  try {
    await t.step("the app's top-level page reads __denext and completes ping + pong", async () => {
      const page = await browser.newPage(server.origin + "/");
      await page.waitForFunction("window.__result !== undefined");
      const r = await page.evaluate("window.__result") as Record<string, unknown>;
      assertEquals(r.error, undefined);
      assertEquals(r.global, { desktop: true, token: server.token, os: Deno.build.os });
      const ping = r.ping as { echo: unknown; os: string; at: number };
      assertEquals(ping.echo, { hi: 1 });
      assertEquals(ping.os, Deno.build.os);
      assertEquals(r.pong, { n: 7 });
      assertEquals(r.disabled, "unavailable");
      assertEquals(r.clipboard, "from-web", "readClipboard fell back to navigator.clipboard");
      const doc = server.log.find((x) => x.path === "/")!;
      assertEquals(doc.headers.get("sec-fetch-dest"), "document");
      const rpc = server.log.find((x) => x.path === "/_denext/desktop/rpc")!;
      assertEquals(rpc.headers.get("origin"), server.origin, "Chromium sends Origin on the POST");
      await page.close();
    });

    await t.step("a foreign-origin page cannot reach the rpc or the events", async () => {
      const before = server.log.length;
      const page = await browser.newPage(foreignOrigin + "/");
      await page.waitForFunction("window.__result !== undefined");
      const r = await page.evaluate("window.__result") as Record<string, string>;
      assertEquals(r.rpcCors, "blocked: TypeError");
      assertEquals(r.eventsCors, "blocked: TypeError");
      // no-cors can send a "simple" request, but it carries no token and a text/plain type.
      assertEquals(r.rpcNoCors, "status 0 opaque");
      assertEquals(hits, 0, "the probe capability never ran");
      const seen = server.log.slice(before);
      for (const req of seen.filter((x) => x.path.startsWith("/_denext/desktop/"))) {
        assert(
          req.status === 403 || req.status === 415,
          `${req.method} ${req.path} → ${req.status}`,
        );
      }
      // The iframe of the app got the shell WITHOUT the token.
      const frame = seen.find((x) => x.path === "/");
      assert(frame, "the iframe loaded the app");
      assertEquals(frame.headers.get("sec-fetch-dest"), "iframe");
      const sub = injectedGlobal(
        await (await fetch(server.origin + "/", { headers: { "sec-fetch-dest": "iframe" } }))
          .text(),
      );
      assertEquals(sub?.token, undefined);
      await page.close();
    });

    await t.step("the event stream sends `: ping` heartbeats", async () => {
      const res = await fetch(server.origin + "/_denext/desktop/events", {
        headers: { "x-denext-desktop-token": server.token },
      });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      const deadline = Date.now() + 20_000;
      while (!text.includes(": ping\n\n") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      await reader.cancel();
      assert(text.includes(": ping\n\n"), `no heartbeat in: ${JSON.stringify(text)}`);
      await until(() => server.openEventStreams() === 0);
    });
  } finally {
    await browser.close();
    foreignAbort.abort();
    await foreign.finished;
    await server.close();
  }
});
