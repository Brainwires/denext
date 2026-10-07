// The WebSocket relay under denext's pinned Deno Desktop runtime: the page runs at a custom origin
// (`myapp://app`) whose transport carries no WebSockets, so its own WebSockets dial the runtime's
// loopback relay at `DENO_DESKTOP_WS_URL` (`ws://127.0.0.1:<port>/.deno-desktop-relay/<token>`),
// which the desktop runtime injects as `__denext.wsUrl`. Covers the env parse, the page-side URL
// choice (`denext/desktop/client` and the Live client), and the injection (memory world only, and
// only with the per-launch token: the URL carries the relay's token).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { createDesktopHandler, injectDesktopGlobal } from "../src/build/desktop.ts";
import { resolveDesktopWsUrl } from "../src/desktop/transport.ts";
import type { DesktopServeInfo, DesktopTrust } from "../src/desktop/transport.ts";
import { desktopWebSocketUrl, desktopWsUrl } from "../src/desktop/client.ts";
import { subscribeLiveTags } from "../src/client/live-client.ts";

const TOKEN = "0123456789abcdef".repeat(4);
const RELAY = `ws://127.0.0.1:51234/.deno-desktop-relay/${TOKEN}`;
const MEMORY: DesktopTrust = { kind: "memory", origin: "myapp://app" };
const MEM_INFO: DesktopServeInfo = { remoteAddr: { transport: "memory" } };

// deno-lint-ignore no-explicit-any
type AnyGlobal = any;

/** Run `fn` with `__denext` and `location` stubbed, restoring both. */
function withPage<T>(
  denext: unknown,
  location: { protocol: string; host: string; href?: string } | undefined,
  fn: () => T,
): T {
  const g = globalThis as AnyGlobal;
  const had = { denext: g.__denext, location: g.location };
  g.__denext = denext;
  if (location) g.location = location;
  else delete g.location;
  try {
    return fn();
  } finally {
    if (had.denext === undefined) delete g.__denext;
    else g.__denext = had.denext;
    if (had.location === undefined) delete g.location;
    else g.location = had.location;
  }
}

Deno.test("resolveDesktopWsUrl: only a loopback ws: relay URL with its token", () => {
  assertEquals(resolveDesktopWsUrl(RELAY), RELAY);
  assertEquals(
    resolveDesktopWsUrl(`ws://[::1]:9/.deno-desktop-relay/${TOKEN}`),
    `ws://[::1]:9/.deno-desktop-relay/${TOKEN}`,
  );
  assertEquals(
    resolveDesktopWsUrl(`ws://localhost:9/.deno-desktop-relay/${TOKEN}`),
    `ws://localhost:9/.deno-desktop-relay/${TOKEN}`,
  );
  for (
    const bad of [
      undefined,
      "",
      "not a url",
      "ws://127.0.0.1:51234", // the bare origin: the relay refuses it without the token
      "ws://127.0.0.1:51234/",
      `ws://127.0.0.1/.deno-desktop-relay/${TOKEN}`, // no port
      `wss://127.0.0.1:9/.deno-desktop-relay/${TOKEN}`, // the relay speaks plain ws on loopback
      `http://127.0.0.1:9/.deno-desktop-relay/${TOKEN}`,
      `ws://example.com:9/.deno-desktop-relay/${TOKEN}`, // never a remote host
      `ws://127.0.0.1:9/.deno-desktop-relay/${TOKEN}/`, // a trailing slash
      `ws://127.0.0.1:9/.deno-desktop-relay/${TOKEN}/ws`, // a path after the token
      `ws://127.0.0.1:9/.deno-desktop-relay/${TOKEN.toUpperCase()}`, // lowercase hex only
      `ws://127.0.0.1:9/.deno-desktop-relay/${TOKEN.slice(1)}`, // 63 hex digits
      `ws://127.0.0.1:9/.deno-desktop-relay/${TOKEN}0`, // 65
      `ws://127.0.0.1:9/x/.deno-desktop-relay/${TOKEN}`,
      `ws://127.0.0.1:9/.deno-desktop-relay/${TOKEN}?q=1`,
      `ws://127.0.0.1:9/.deno-desktop-relay/${TOKEN}?`,
      `ws://127.0.0.1:9/.deno-desktop-relay/${TOKEN}#f`,
      `ws://u:p@127.0.0.1:9/.deno-desktop-relay/${TOKEN}`,
    ]
  ) {
    assertEquals(resolveDesktopWsUrl(bad), undefined, String(bad));
  }
});

Deno.test("desktopWebSocketUrl: the relay at a custom origin, the page's own host elsewhere", () => {
  const app = { protocol: "myapp:", host: "app" };
  // Pinned runtime: the relay URL with the page's path appended, whatever the page origin.
  withPage({ desktop: true, wsUrl: RELAY }, app, () => {
    assertEquals(desktopWsUrl(), RELAY);
    assertEquals(desktopWebSocketUrl("/api/ws?x=1"), `${RELAY}/api/ws?x=1`);
    assertEquals(desktopWebSocketUrl("/"), `${RELAY}/`);
    // A bare query is the server's `/` with that query.
    assertEquals(desktopWebSocketUrl("?room=1"), `${RELAY}?room=1`);
  });
  // The web / the stock runtime: ws(s) on the page's host.
  withPage(undefined, { protocol: "https:", host: "example.com" }, () => {
    assertEquals(desktopWsUrl(), undefined);
    assertEquals(desktopWebSocketUrl("/ws"), "wss://example.com/ws");
    assertEquals(desktopWebSocketUrl("?room=1"), "wss://example.com/?room=1");
  });
  withPage({ desktop: true }, { protocol: "http:", host: "127.0.0.1:8000" }, () => {
    assertEquals(desktopWebSocketUrl("/ws"), "ws://127.0.0.1:8000/ws");
  });
  // A malformed injected value (the bare relay origin of older runtimes included), or one without
  // the desktop marker, is ignored.
  for (
    const denext of [
      { desktop: true, wsUrl: "http://x:1" },
      { desktop: true, wsUrl: "ws://127.0.0.1:51234" },
      { desktop: true, wsOrigin: "ws://127.0.0.1:51234" },
      { wsUrl: RELAY },
    ]
  ) {
    withPage(denext, { protocol: "http:", host: "h" }, () => {
      assertEquals(desktopWsUrl(), undefined);
      assertEquals(desktopWebSocketUrl("/ws"), "ws://h/ws");
    });
  }
  // No location (a worker without one, SSR): the absolute path as is.
  withPage(undefined, undefined, () => {
    assertEquals(desktopWebSocketUrl("/ws"), "/ws");
    assertEquals(desktopWebSocketUrl("?a=1"), "/?a=1");
  });
  // Only an absolute path or a query.
  for (const bad of ["", "ws", "//evil.example/ws", "https://x/ws", "#f", "./ws"]) {
    assertThrows(() => desktopWebSocketUrl(bad), TypeError);
  }
});

Deno.test("Live client: dials the relay in a pinned-runtime window", () => {
  const g = globalThis as AnyGlobal;
  const urls: string[] = [];
  const origWs = g.WebSocket;
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    constructor(url: string) {
      urls.push(url);
    }
    send() {}
    close() {}
  }
  g.WebSocket = FakeWebSocket;
  try {
    withPage(
      { desktop: true, wsUrl: RELAY },
      { protocol: "myapp:", host: "app", href: "myapp://app/" },
      () => {
        const stop = subscribeLiveTags(["t"], () => {});
        stop();
      },
    );
  } finally {
    g.WebSocket = origWs;
  }
  assertEquals(urls, [`${RELAY}/_denext/live`]);
});

Deno.test("injectDesktopGlobal: wsUrl rides in __denext only with the token", async () => {
  const html = "<html><head></head><body></body></html>";
  const withToken = await injectDesktopGlobal(html, "tok", false, undefined, undefined, {
    wsUrl: RELAY,
  });
  assertStringIncludes(withToken, `"token":"tok"`);
  assertStringIncludes(withToken, `"wsUrl":"${RELAY}"`);
  // A document that gets no desktop token (a subframe, a DNS-rebinding Host) gets no relay token.
  const noToken = await injectDesktopGlobal(html, null, false, undefined, undefined, {
    wsUrl: RELAY,
  });
  assert(!noToken.includes("token"));
  assert(!noToken.includes(TOKEN));
  assert(!(await injectDesktopGlobal(html, "tok")).includes("wsUrl"));
});

/** The served shell for `trust`, with a relay origin handed to the handler. */
async function shell(
  trust: DesktopTrust,
  base: string,
  info?: DesktopServeInfo,
  headers?: HeadersInit,
): Promise<string> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "index.html"), "<html><head></head><body></body></html>");
    const handle = createDesktopHandler(
      {},
      dir,
      undefined,
      "tok",
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      trust,
      undefined,
      undefined,
      RELAY,
    );
    const request = new Request(`${base}/`, { headers });
    const res = await handle(request, new URL(request.url), info);
    return await res.text();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("createDesktopHandler: the relay URL is injected in the memory world only", async () => {
  assertStringIncludes(await shell(MEMORY, "http+memory://app", MEM_INFO), RELAY);
  assert(!(await shell({ kind: "loopback" }, "http://127.0.0.1:8000")).includes(RELAY));
  // Not into a document the token does not go to (a subframe of the app).
  assert(
    !(await shell(MEMORY, "http+memory://app", MEM_INFO, { "sec-fetch-dest": "iframe" }))
      .includes(TOKEN),
  );
});
