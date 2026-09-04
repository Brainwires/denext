// In-process integration for the SPA reverse proxy (src/build/dev-proxy.ts). The proxy
// is wired by the SPA PRODUCTION server (startSpaProdServer) when `spa.proxy` is set, so
// we build a temp SPA whose config proxies `/api` + `/ws` to a tiny loopback backend we
// run in-process, then drive it with `fetch` (HTTP) and a `WebSocket` (upgrade bridge) —
// no browser. Asserts: HTTP relaying, the Set-Cookie Domain/Secure rewrite, prefix
// matching (a non-proxied path is NOT forwarded), and the WebSocket bridge round-trip.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import { buildAndServe } from "./e2e/harness.ts";

const SPA = new URL("../examples/spa", import.meta.url).pathname;
const FRAMEWORK_ROOT = new URL("../", import.meta.url).pathname;

/** A minimal loopback backend the proxy forwards to (HTTP echo + WS echo + a cookie). */
async function startBackend(): Promise<{ port: number; close: () => Promise<void> }> {
  const ac = new AbortController();
  let boundPort = 0;
  const { promise, resolve } = Promise.withResolvers<void>();
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    signal: ac.signal,
    onListen: ({ port }) => {
      boundPort = port;
      resolve();
    },
  }, (req) => {
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (e) => socket.send(`echo:${e.data}`);
      return response;
    }
    if (url.pathname === "/api/echo") {
      return new Response(
        JSON.stringify({ ok: true, q: url.searchParams.get("q"), path: url.pathname }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            // Domain + Secure are set for the backend's own host; the proxy must strip
            // both so the cookie binds to the proxy origin over http.
            "set-cookie": "sid=abc123; Path=/; Domain=127.0.0.1; Secure; HttpOnly",
          },
        },
      );
    }
    return new Response("backend 404", { status: 404 });
  });
  await promise; // resolved by onListen once the ephemeral port is bound
  return {
    port: boundPort,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/** Copy examples/spa to a temp dir, wire a proxy to `backendPort`, patch framework imports. */
async function makeProxySpa(backendPort: number): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_proxy_" });
  await copy(SPA, dir, { overwrite: true });
  await Deno.remove(join(dir, ".denext"), { recursive: true }).catch(() => {});

  const abs = (rel: string) => toFileUrl(join(FRAMEWORK_ROOT, rel)).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(
      {
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": abs("mod.ts"),
          "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
          "denext/server": abs("src/server/mod.ts"),
          "denext/client": abs("src/client/mod.ts"),
          "@std/path": "jsr:@std/path@^1.0.0",
        },
      },
      null,
      2,
    ),
  );
  // No type import → the config needs no `denext` runtime resolution at load time.
  await Deno.writeTextFile(
    join(dir, "denext.config.ts"),
    `export default {\n` +
      `  mode: "spa",\n` +
      `  spa: {\n` +
      `    entry: "./src/main.tsx",\n` +
      `    title: "denext SPA proxy example",\n` +
      `    proxy: { prefixes: ["/api", "/ws"], target: "http://127.0.0.1:${backendPort}" },\n` +
      `  },\n` +
      `};\n`,
  );
  return dir;
}

type Ctx = { origin: string };

async function stepApiRelayed({ origin }: Ctx): Promise<void> {
  const res = await fetch(origin + "/api/echo?q=hi");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.q, "hi");
  assertEquals(body.path, "/api/echo");
}

async function stepSetCookieRewritten({ origin }: Ctx): Promise<void> {
  const res = await fetch(origin + "/api/echo");
  const cookies = res.headers.getSetCookie();
  await res.body?.cancel();
  assert(cookies.length > 0, "a Set-Cookie was forwarded");
  const sid = cookies.find((c) => c.startsWith("sid="))!;
  assert(sid, "sid cookie present");
  assert(!/Domain=/i.test(sid), `Domain must be stripped: ${sid}`);
  assert(!/;\s*Secure\b/i.test(sid), `Secure must be stripped: ${sid}`);
  // HttpOnly is preserved (only Domain/Secure are rewritten).
  assertStringIncludes(sid, "HttpOnly");
}

async function stepNonProxiedServedLocally({ origin }: Ctx): Promise<void> {
  const res = await fetch(origin + "/", { headers: { accept: "text/html" } });
  assertEquals(res.status, 200);
  const html = await res.text();
  // The SPA shell, not the backend's "backend 404".
  assertStringIncludes(html, 'id="root"');
  assert(!html.includes("backend 404"));
}

async function stepWsBridged({ origin }: Ctx): Promise<void> {
  const wsUrl = origin.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl);
  const got = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws timeout")), 8000);
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(String(e.data));
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ws error"));
    };
  });
  assertEquals(got, "echo:ping");
  await new Promise<void>((r) => {
    ws.onclose = () => r();
    ws.close();
  });
}

Deno.test({
  name: "SPA proxy forwards matched prefixes (HTTP + WS) and rewrites Set-Cookie",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const backend = await startBackend();
  const dir = await makeProxySpa(backend.port);
  const server = await buildAndServe(dir);
  const ctx: Ctx = { origin: server.origin };

  try {
    await t.step("an /api request is relayed to the backend", () => stepApiRelayed(ctx));
    await t.step(
      "the relayed Set-Cookie has Domain + Secure stripped",
      () => stepSetCookieRewritten(ctx),
    );
    await t.step(
      "a non-proxied path is served locally (shell), not forwarded",
      () => stepNonProxiedServedLocally(ctx),
    );
    await t.step("a /ws upgrade is bridged to the backend and echoes", () => stepWsBridged(ctx));
  } finally {
    await server.close();
    await backend.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
