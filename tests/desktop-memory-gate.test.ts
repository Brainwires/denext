// The desktop gates in the MEMORY world (the denext-pinned runtime: the page at a stable custom
// origin, every request over the in-process memory transport) — adversarially: a foreign Origin,
// a non-memory request with and without an Origin, an `http+memory` URL that the serve info says
// came over TCP, a REAL TCP request carrying a spoofed Host / absolute-form `http+memory:` target,
// a WebSocket upgrade with a foreign or missing Origin, and the per-launch token never reaching an
// iframe or a non-memory response. The loopback world's rules are covered by the existing
// desktop-bridge / desktop-runtime / desktop-auth-session suites, which run unchanged.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createDesktopBridge } from "../src/desktop/bridge.ts";
import { echoCapability } from "../src/desktop/caps/echo.ts";
import {
  handleDesktopAuthSession,
  resetDesktopAuthSessionForTesting,
} from "../src/desktop/auth-session-runtime.ts";
import {
  createDesktopHandler,
  installWindowCloseHandler,
  shouldInjectDesktopToken,
} from "../src/build/desktop.ts";
import {
  DESKTOP_CROSS_ORIGIN_HEADER,
  DESKTOP_RELAY_HEADER,
  type DesktopServeInfo,
  type DesktopTrust,
  isCrossOriginMarked,
  isRelayConnection,
  memoryGate,
} from "../src/desktop/transport.ts";
import type { DesktopCapability } from "../src/desktop/extension.ts";

const APP = "t3code://app";
const TOKEN = "memory-world-token-0123";
const MEMORY: DesktopTrust = { kind: "memory", origin: APP };
const MEM_INFO: DesktopServeInfo = { remoteAddr: { transport: "memory" } };
const TCP_INFO: DesktopServeInfo = { remoteAddr: { transport: "tcp" } };
/** The base URL a page request has in the memory world (Host = the origin's host). */
const MEM = "http+memory://app";
/** A loopback TCP URL (what a request from another local process looks like). */
const TCP = "http://127.0.0.1:8000";

interface Req {
  base?: string;
  origin?: string | null;
  token?: string | null;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Build a request; `null` omits a header. */
function req(path: string, o: Req = {}): Request {
  const headers = new Headers(o.headers);
  const token = o.token === undefined ? TOKEN : o.token;
  if (token !== null) headers.set("x-denext-desktop-token", token);
  if (o.origin !== undefined && o.origin !== null) headers.set("origin", o.origin);
  const method = o.method ?? "POST";
  if (method === "POST") headers.set("content-type", "application/json");
  return new Request(`${o.base ?? MEM}${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(o.body ?? null) : undefined,
  });
}

const rpcBody = { cap: "echo", method: "ping", args: "hi" };

async function rpc(
  trust: DesktopTrust,
  o: Req,
  info?: DesktopServeInfo,
): Promise<{ status: number; body: { ok: boolean; error?: { message: string } } }> {
  const bridge = createDesktopBridge([echoCapability], { trust });
  const request = req("/_denext/desktop/rpc", { body: rpcBody, ...o });
  const res = await bridge.handle(request, new URL(request.url), TOKEN, info);
  assert(res);
  return { status: res.status, body: await res.json() };
}

Deno.test("memory gate / rpc: same-origin over the memory transport is served", async () => {
  // No Origin (what the runtime documents for a same-origin request) and an exact Origin.
  for (const origin of [null, APP]) {
    const r = await rpc(MEMORY, { origin }, MEM_INFO);
    assertEquals(r.status, 200, String(origin));
    assertEquals(r.body.ok, true);
  }
  // Without serve info the http+memory: URL alone is NOT proof (spoofable over TCP): refused.
  assertEquals((await rpc(MEMORY, { origin: APP })).status, 403);
});

Deno.test("memory gate / rpc: a foreign Origin is refused, even with the token", async () => {
  for (
    const origin of [
      "https://evil.example",
      "null",
      "t3code://evil",
      "t3code://app/",
      "T3CODE://APP",
    ]
  ) {
    const r = await rpc(MEMORY, { origin }, MEM_INFO);
    assertEquals(r.status, 403, origin);
    assertEquals(r.body.error?.message, "bad origin", origin);
  }
});

Deno.test("memory gate / rpc: a non-memory request is refused with or without an Origin", async () => {
  for (const origin of [null, APP, TCP]) {
    const r = await rpc(MEMORY, { base: TCP, origin }, TCP_INFO);
    assertEquals(r.status, 403, String(origin));
    assertEquals(r.body.error?.message, "bad transport");
  }
  // An http+memory URL whose serve info says TCP (a forged URL) is not trusted either.
  const forged = await rpc(MEMORY, { origin: APP }, TCP_INFO);
  assertEquals(forged.status, 403);
  assertEquals(forged.body.error?.message, "bad transport");
});

Deno.test("memory gate / rpc: the token is still required, and checked first", async () => {
  const r = await rpc(MEMORY, { token: "wrong" }, MEM_INFO);
  assertEquals(r.status, 403);
  assertEquals(r.body.error?.message, "bad token");
});

Deno.test("refuse world / loopback world: a memory-transport request is not served", async () => {
  const refused = await rpc({ kind: "refuse", reason: "bad env" }, { origin: APP }, MEM_INFO);
  assertEquals(refused.status, 403);
  // The stock loopback rules see Host `app`: not loopback, so the DNS-rebinding refusal applies.
  const loop = await rpc({ kind: "loopback" }, { origin: APP }, MEM_INFO);
  assertEquals(loop.status, 403);
  assertEquals(loop.body.error?.message, "bad host");
});

Deno.test("memory gate / events: memory + absent-or-exact Origin only", async () => {
  const bridge = createDesktopBridge([], { trust: MEMORY });
  const open = async (o: Req, info: DesktopServeInfo) => {
    const request = req("/_denext/desktop/events", { method: "GET", ...o });
    const res = await bridge.handle(request, new URL(request.url), TOKEN, info);
    assert(res);
    await res.body?.cancel();
    return res.status;
  };
  assertEquals(await open({}, MEM_INFO), 200);
  assertEquals(await open({ origin: APP }, MEM_INFO), 200);
  assertEquals(await open({ origin: "https://evil.example" }, MEM_INFO), 403);
  assertEquals(await open({ base: TCP }, TCP_INFO), 403);
  assertEquals(await open({ base: TCP, origin: APP }, TCP_INFO), 403);
  assertEquals(await open({ token: "wrong" }, MEM_INFO), 403);
});

Deno.test("memory gate / auth-session: foreign Origin and non-memory are refused", async () => {
  resetDesktopAuthSessionForTesting();
  const access = (info: DesktopServeInfo) => ({ trust: MEMORY, info });
  const call = async (o: Req, info: DesktopServeInfo) => {
    const res = await handleDesktopAuthSession(
      req("/_denext/desktop/auth-session", { body: { authUrl: "not a url" }, ...o }),
      TOKEN,
      () => {},
      access(info),
    );
    return { status: res.status, body: await res.json() };
  };
  const foreign = await call({ origin: "https://evil.example" }, MEM_INFO);
  assertEquals([foreign.status, foreign.body.message], [403, "bad origin"]);
  const tcp = await call({ base: TCP, origin: APP }, TCP_INFO);
  assertEquals([tcp.status, tcp.body.message], [403, "bad transport"]);
  const tcpNoOrigin = await call({ base: TCP }, TCP_INFO);
  assertEquals(tcpNoOrigin.status, 403);
  // Through the gate (memory, no Origin): the body is what fails — proof the headers passed.
  const through = await call({}, MEM_INFO);
  assertEquals([through.status, through.body.code], [400, "invalid"]);
  const exact = await call({ origin: APP }, MEM_INFO);
  assertEquals(exact.status, 400);
});

/** A throwaway export dir with an index.html shell. */
async function exportDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext-memory-gate-" });
  await Deno.writeTextFile(
    join(dir, "index.html"),
    "<!doctype html><html><head><title>t</title></head><body></body></html>",
  );
  return dir;
}

/** A memory-world handler with a bridge + a quit spy. */
function memoryHandler(dir: string, onQuit: () => void = () => {}) {
  const bridge = createDesktopBridge([echoCapability], { trust: MEMORY });
  return createDesktopHandler(
    {},
    dir,
    undefined,
    TOKEN,
    undefined,
    undefined,
    false,
    bridge,
    onQuit,
    MEMORY,
  );
}

Deno.test("memory world: the token goes only into a top-level document over the memory transport", async () => {
  const dir = await exportDir();
  try {
    const handle = memoryHandler(dir);
    const shell = async (o: Req, info: DesktopServeInfo) => {
      const request = req("/", { method: "GET", token: null, ...o });
      const res = await handle(request, new URL(request.url), info);
      assertEquals(res.status, 200);
      return await res.text();
    };
    const top = await shell({ headers: { "sec-fetch-dest": "document" } }, MEM_INFO);
    assertStringIncludes(top, TOKEN);
    // Absent Sec-Fetch-Dest is a document too (WebKit without fetch metadata).
    assertStringIncludes(await shell({}, MEM_INFO), TOKEN);
    // An iframe of the app's own origin gets the desktop global, NOT the token.
    const frame = await shell({ headers: { "sec-fetch-dest": "iframe" } }, MEM_INFO);
    assertStringIncludes(frame, '"desktop":true');
    assert(!frame.includes(TOKEN), "iframe must not receive the token");
    // A non-memory response never carries it, whatever the request claims.
    const tcp = await shell({ base: TCP, origin: APP }, TCP_INFO);
    assert(!tcp.includes(TOKEN), "a TCP-served document must not receive the token");
    const forged = await shell({}, TCP_INFO);
    assert(!forged.includes(TOKEN), "a forged http+memory URL over TCP must not get the token");
    // A document fetched with a foreign Origin does not either.
    const foreign = await shell({ origin: "https://evil.example" }, MEM_INFO);
    assert(!foreign.includes(TOKEN));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("shouldInjectDesktopToken: per world", () => {
  const doc = (url: string) => new Request(url);
  assert(shouldInjectDesktopToken(doc(`${MEM}/`), new URL(`${MEM}/`), MEMORY, MEM_INFO));
  assert(!shouldInjectDesktopToken(doc(`${TCP}/`), new URL(`${TCP}/`), MEMORY, TCP_INFO));
  assert(shouldInjectDesktopToken(doc(`${TCP}/`), new URL(`${TCP}/`), { kind: "loopback" }));
  assert(
    !shouldInjectDesktopToken(doc(`${MEM}/`), new URL(`${MEM}/`), { kind: "loopback" }, MEM_INFO),
  );
  assert(
    !shouldInjectDesktopToken(
      doc(`${MEM}/`),
      new URL(`${MEM}/`),
      { kind: "refuse", reason: "x" },
      MEM_INFO,
    ),
  );
});

Deno.test("memory world: quit is refused over TCP even with the token", async () => {
  const dir = await exportDir();
  try {
    let quit = 0;
    const handle = memoryHandler(dir, () => quit++);
    const post = async (o: Req, info: DesktopServeInfo) => {
      const request = req("/_denext/desktop/quit", o);
      return (await handle(request, new URL(request.url), info)).status;
    };
    assertEquals(await post({ base: TCP, origin: APP }, TCP_INFO), 403);
    assertEquals(await post({ origin: "https://evil.example" }, MEM_INFO), 403);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(quit, 0);
    assertEquals(await post({}, MEM_INFO), 204);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(quit, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("memory world: a WebSocket upgrade needs the exact app Origin (app-side check)", async () => {
  const dir = await exportDir();
  try {
    let reached = 0;
    const bridge = createDesktopBridge([], { trust: MEMORY });
    const handle = createDesktopHandler(
      {
        onRequest: () => {
          reached++;
          return new Response("app ws handler");
        },
      },
      dir,
      undefined,
      TOKEN,
      undefined,
      undefined,
      false,
      bridge,
      undefined,
      MEMORY,
    );
    const upgrade = async (origin: string | null, base = "http+memory://127.0.0.1:5555") => {
      const headers: Record<string, string> = { upgrade: "websocket", connection: "Upgrade" };
      if (origin !== null) headers.origin = origin;
      const request = new Request(`${base}/ws`, { headers });
      return (await handle(
        request,
        new URL(request.url),
        base.startsWith("http+memory") ? MEM_INFO : TCP_INFO,
      )).status;
    };
    assertEquals(await upgrade("https://evil.example"), 403);
    assertEquals(await upgrade(null), 403);
    assertEquals(await upgrade(APP, TCP), 403);
    assertEquals(reached, 0, "no app code saw a refused upgrade");
    assertEquals(await upgrade(APP), 200);
    assertEquals(reached, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Send one raw HTTP/1.1 request over TCP and return the status line + body. */
async function rawHttp(port: number, head: string, body = ""): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const bytes = new TextEncoder().encode(body);
    await conn.write(
      new TextEncoder().encode(
        `${head}\r\ncontent-length: ${bytes.byteLength}\r\nconnection: close\r\n\r\n${body}`,
      ),
    );
    let out = "";
    const buf = new Uint8Array(64 * 1024);
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      out += new TextDecoder().decode(buf.subarray(0, n));
    }
    return out;
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

Deno.test("memory world over REAL TCP: a spoofed http+memory Host / target is refused", async () => {
  const dir = await exportDir();
  const controller = new AbortController();
  try {
    const handle = memoryHandler(dir);
    const { promise: listening, resolve } = Promise.withResolvers<number>();
    const server = Deno.serve(
      {
        port: 0,
        hostname: "127.0.0.1",
        signal: controller.signal,
        onListen: ({ port }) => resolve(port),
      },
      (request, info) => handle(request, new URL(request.url), info as DesktopServeInfo),
    );
    const port = await listening;
    const body = JSON.stringify(rpcBody);
    const common = `x-denext-desktop-token: ${TOKEN}\r\norigin: ${APP}\r\n` +
      "content-type: application/json";
    for (
      const head of [
        `POST /_denext/desktop/rpc HTTP/1.1\r\nhost: app\r\n${common}`,
        `POST /_denext/desktop/rpc HTTP/1.1\r\nhost: http+memory://app\r\n${common}`,
        `POST http+memory://app/_denext/desktop/rpc HTTP/1.1\r\nhost: app\r\n${common}`,
        `POST /_denext/desktop/rpc HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\n${common}`,
      ]
    ) {
      const res = await rawHttp(port, head, body);
      assert(!res.includes('"ok":true'), `served over TCP: ${head.split("\r\n")[0]}\n${res}`);
      assert(/^HTTP\/1\.1 (4\d\d)/.test(res), res.split("\r\n")[0]);
    }
    // And the shell served over TCP carries no token, whatever Host it claims.
    const page = await rawHttp(port, "GET / HTTP/1.1\r\nhost: app\r\nsec-fetch-dest: document");
    assertStringIncludes(page, '"desktop":true');
    assert(!page.includes(TOKEN), "TCP-served shell must not carry the token");
    controller.abort();
    await server.finished;
  } finally {
    controller.abort();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDesktop's window: installWindowCloseHandler returns it and ctx.window receives it", async () => {
  let exited: number | undefined;
  class FakeWindow extends EventTarget {}
  const win = installWindowCloseHandler(FakeWindow, (code) => {
    exited = code;
  });
  assert(win instanceof FakeWindow);
  (win as EventTarget).dispatchEvent(new Event("close"));
  assertEquals(exited, 0);
  // Outside the desktop runtime there is no window, and nothing throws.
  assertEquals(installWindowCloseHandler(undefined), undefined);

  // The bridge hands the window to a capability as ctx.window (runDesktop passes getWindow).
  let seen: unknown;
  const cap: DesktopCapability = {
    name: "win",
    methods: {
      get: {
        handler: (_in, ctx) => {
          seen = ctx.window;
          return null;
        },
      },
    },
  };
  const bridge = createDesktopBridge([cap], { trust: MEMORY, getWindow: () => win });
  const request = req("/_denext/desktop/rpc", { body: { cap: "win", method: "get" } });
  const res = await bridge.handle(request, new URL(request.url), TOKEN, MEM_INFO);
  assertEquals(res?.status, 200);
  assertEquals(seen, win);
});

Deno.test("bridge.emit: an OS event reaches the page's event stream", async () => {
  const bridge = createDesktopBridge([], { trust: MEMORY });
  bridge.emit("deepLink", "open", { url: "t3code://app/thread/1" });
  const request = req("/_denext/desktop/events", { method: "GET" });
  const res = await bridge.handle(request, new URL(request.url), TOKEN, MEM_INFO);
  assert(res?.body);
  const reader = res.body.getReader();
  let text = "";
  while (!text.includes("thread/1")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader.cancel();
  assertStringIncludes(text, "deepLink");
  assertStringIncludes(text, "t3code://app/thread/1");
});

// ---------------------------------------------------------------------------------------------
// Relay-marked requests: the runtime's loopback WebSocket relay forwards into the memory
// transport and marks what it forwards (`x-deno-desktop-relay`). Any local process can dial the
// relay, so a relayed request's missing Origin / Sec-Fetch-Dest prove nothing.
// ---------------------------------------------------------------------------------------------

const RELAY = { "x-deno-desktop-relay": "1" };

Deno.test("relay: isRelayConnection reads the runtime's mark, and only it", () => {
  assert(isRelayConnection(new Request(`${MEM}/`, { headers: RELAY })));
  assert(isRelayConnection(new Request(`${MEM}/`, { headers: { [DESKTOP_RELAY_HEADER]: "" } })));
  assert(!isRelayConnection(new Request(`${MEM}/`)));
});

Deno.test("relay: memoryGate admits only an upgrade with the exact Origin", () => {
  const gate = (headers: Record<string, string>, requireOrigin = false) =>
    memoryGate(MEMORY, new Request(`${MEM}/x`, { headers }), MEM_INFO, requireOrigin);
  const ws = { upgrade: "websocket", connection: "Upgrade" };
  // Not an upgrade: refused whatever it carries.
  assertEquals(gate({ ...RELAY }), "relay");
  assertEquals(gate({ ...RELAY, origin: APP }), "relay");
  // An upgrade: the Origin is mandatory even when the caller would not demand it.
  assertEquals(gate({ ...RELAY, ...ws }), "origin");
  assertEquals(gate({ ...RELAY, ...ws, origin: "https://evil.example" }), "origin");
  assertEquals(gate({ ...RELAY, ...ws, origin: APP }), null);
  // Unmarked page requests keep their rules (absent Origin = same-origin).
  assertEquals(gate({}), null);
});

Deno.test("relay: no token is injected and no desktop endpoint is served", async () => {
  const dir = await exportDir();
  try {
    let quit = 0;
    const handle = memoryHandler(dir, () => quit++);
    const send = async (path: string, o: Req) => {
      const request = req(path, o);
      const res = await handle(request, new URL(request.url), MEM_INFO);
      return { status: res.status, text: await res.text() };
    };
    // A relayed GET of the shell (no Origin, no Sec-Fetch-Dest, i.e. "looks like a document").
    const doc = await send("/", { method: "GET", token: null, headers: RELAY });
    assertEquals(doc.status, 403);
    assert(!doc.text.includes(TOKEN));
    const withDest = await send("/", {
      method: "GET",
      token: null,
      origin: APP,
      headers: { ...RELAY, "sec-fetch-dest": "document" },
    });
    assert(!withDest.text.includes(TOKEN));
    assert(
      !shouldInjectDesktopToken(
        new Request(`${MEM}/`, { headers: RELAY }),
        new URL(`${MEM}/`),
        MEMORY,
        MEM_INFO,
      ),
    );
    // The token-gated endpoints, even WITH the token and the exact Origin.
    for (const path of ["/_denext/desktop/quit", "/_denext/desktop/rpc"]) {
      const r = await send(path, { origin: APP, headers: RELAY, body: rpcBody });
      assertEquals(r.status, 403, path);
    }
    const events = await send("/_denext/desktop/events", {
      method: "GET",
      origin: APP,
      headers: { ...RELAY, upgrade: "websocket", connection: "Upgrade" },
    });
    assertEquals(events.status, 403);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(quit, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("relay: the page's own WebSocket upgrade still reaches the app", async () => {
  const dir = await exportDir();
  try {
    let reached = 0;
    const handle = createDesktopHandler(
      { onRequest: () => (reached++, new Response("ws")) },
      dir,
      undefined,
      TOKEN,
      undefined,
      undefined,
      false,
      createDesktopBridge([], { trust: MEMORY }),
      undefined,
      MEMORY,
    );
    const upgrade = async (origin: string | null) => {
      const headers: Record<string, string> = { ...RELAY, upgrade: "websocket" };
      if (origin) headers.origin = origin;
      const request = new Request("http+memory://127.0.0.1:5555/ws", { headers });
      return (await handle(request, new URL(request.url), MEM_INFO)).status;
    };
    assertEquals(await upgrade(null), 403);
    assertEquals(await upgrade(APP), 200);
    assertEquals(reached, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const CROSS = { "x-deno-desktop-cross-origin": "1" };

Deno.test("cross-origin mark: isCrossOriginMarked reads the runtime's mark, and only it", () => {
  assert(isCrossOriginMarked(new Request(`${MEM}/`, { headers: CROSS })));
  assert(
    isCrossOriginMarked(new Request(`${MEM}/`, { headers: { [DESKTOP_CROSS_ORIGIN_HEADER]: "" } })),
  );
  assert(!isCrossOriginMarked(new Request(`${MEM}/`)));
  assert(!isCrossOriginMarked(new Request(`${MEM}/`, { headers: RELAY })));
});

Deno.test("cross-origin mark: no desktop endpoint serves a marked request", async () => {
  const dir = await exportDir();
  try {
    let quit = 0;
    let escaped = 0;
    const bridge = createDesktopBridge([echoCapability], { trust: MEMORY });
    const handle = createDesktopHandler(
      { authSessionEnabled: true, onRequest: () => (escaped++, null) },
      dir,
      undefined,
      TOKEN,
      () => {},
      undefined,
      false,
      bridge,
      () => quit++,
      MEMORY,
    );
    const send = async (path: string, o: Req) => {
      const request = req(path, o);
      return (await handle(request, new URL(request.url), MEM_INFO)).status;
    };
    // Every endpoint, with the token and the exact app Origin: the mark alone refuses it.
    for (
      const path of [
        "/_denext/desktop/rpc",
        "/_denext/desktop/quit",
        "/_denext/desktop/booted",
        "/_denext/desktop/auth-session",
        "/_denext/desktop/anything",
      ]
    ) {
      assertEquals(await send(path, { origin: APP, headers: CROSS, body: rpcBody }), 403, path);
    }
    assertEquals(
      await send("/_denext/desktop/events", { method: "GET", origin: APP, headers: CROSS }),
      403,
    );
    // Refused before the onRequest escape hatch sees it, and nothing ran.
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(escaped, 0);
    assertEquals(quit, 0);
    // The same request unmarked is served.
    assertEquals(await send("/_denext/desktop/rpc", { origin: APP, body: rpcBody }), 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cross-origin mark: a marked page request is still served (form_post callbacks)", async () => {
  const dir = await exportDir();
  try {
    const handle = memoryHandler(dir);
    const request = req("/", {
      method: "GET",
      token: null,
      headers: { ...CROSS, "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" },
    });
    const res = await handle(request, new URL(request.url), MEM_INFO);
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
