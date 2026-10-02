// The WebSocket relay origin under denext's pinned Deno Desktop runtime: the page runs at a custom
// origin (`myapp://app`) whose transport carries no WebSockets, so its own WebSockets dial the
// runtime's loopback relay (`DENO_DESKTOP_WS_ORIGIN`), which the desktop runtime injects as
// `__denext.wsOrigin`. Covers the env parse, the page-side URL choice (`denext/desktop/client` and
// the Live client), and the injection (memory world only, token or not).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { createDesktopHandler, injectDesktopGlobal } from "../src/build/desktop.ts";
import { resolveDesktopWsOrigin } from "../src/desktop/transport.ts";
import type { DesktopServeInfo, DesktopTrust } from "../src/desktop/transport.ts";
import { desktopWebSocketUrl, desktopWsOrigin } from "../src/desktop/client.ts";
import { subscribeLiveTags } from "../src/client/live-client.ts";

const RELAY = "ws://127.0.0.1:51234";
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

Deno.test("resolveDesktopWsOrigin: only a loopback ws: origin with a port", () => {
  assertEquals(resolveDesktopWsOrigin("ws://127.0.0.1:51234"), RELAY);
  assertEquals(resolveDesktopWsOrigin("ws://127.0.0.1:51234/"), RELAY);
  assertEquals(resolveDesktopWsOrigin("ws://[::1]:9"), "ws://[::1]:9");
  assertEquals(resolveDesktopWsOrigin("ws://localhost:9"), "ws://localhost:9");
  for (
    const bad of [
      undefined,
      "",
      "not a url",
      "ws://127.0.0.1", // no port
      "wss://127.0.0.1:9", // the relay speaks plain ws on loopback
      "http://127.0.0.1:9",
      "ws://example.com:9", // never a remote host
      "ws://127.0.0.1:9/path",
      "ws://127.0.0.1:9/?q=1",
      "ws://u:p@127.0.0.1:9",
    ]
  ) {
    assertEquals(resolveDesktopWsOrigin(bad), undefined, String(bad));
  }
});

Deno.test("desktopWebSocketUrl: the relay at a custom origin, the page's own host elsewhere", () => {
  const app = { protocol: "myapp:", host: "app" };
  // Pinned runtime: the relay, whatever the page origin.
  withPage({ desktop: true, wsOrigin: RELAY }, app, () => {
    assertEquals(desktopWsOrigin(), RELAY);
    assertEquals(desktopWebSocketUrl("/api/ws?x=1"), `${RELAY}/api/ws?x=1`);
  });
  // The web / the stock runtime: ws(s) on the page's host.
  withPage(undefined, { protocol: "https:", host: "example.com" }, () => {
    assertEquals(desktopWsOrigin(), undefined);
    assertEquals(desktopWebSocketUrl("/ws"), "wss://example.com/ws");
  });
  withPage({ desktop: true }, { protocol: "http:", host: "127.0.0.1:8000" }, () => {
    assertEquals(desktopWebSocketUrl("/ws"), "ws://127.0.0.1:8000/ws");
  });
  // A malformed injected value, or one without the desktop marker, is ignored.
  for (const denext of [{ desktop: true, wsOrigin: "http://x:1" }, { wsOrigin: RELAY }]) {
    withPage(denext, { protocol: "http:", host: "h" }, () => {
      assertEquals(desktopWsOrigin(), undefined);
      assertEquals(desktopWebSocketUrl("/ws"), "ws://h/ws");
    });
  }
  // No location (a worker without one, SSR): the path as is.
  withPage(undefined, undefined, () => assertEquals(desktopWebSocketUrl("/ws"), "/ws"));
  // Only an absolute path.
  for (const bad of ["ws", "//evil.example/ws", "https://x/ws"]) {
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
      { desktop: true, wsOrigin: RELAY },
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

Deno.test("injectDesktopGlobal: wsOrigin rides in __denext, with or without the token", async () => {
  const html = "<html><head></head><body></body></html>";
  const withToken = await injectDesktopGlobal(html, "tok", false, undefined, undefined, {
    wsOrigin: RELAY,
  });
  assertStringIncludes(withToken, `"token":"tok"`);
  assertStringIncludes(withToken, `"wsOrigin":"${RELAY}"`);
  const noToken = await injectDesktopGlobal(html, null, false, undefined, undefined, {
    wsOrigin: RELAY,
  });
  assert(!noToken.includes("token"));
  assertStringIncludes(noToken, `"wsOrigin":"${RELAY}"`);
  assert(!(await injectDesktopGlobal(html, "tok")).includes("wsOrigin"));
});

/** The served shell for `trust`, with a relay origin handed to the handler. */
async function shell(trust: DesktopTrust, base: string, info?: DesktopServeInfo): Promise<string> {
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
    const request = new Request(`${base}/`);
    const res = await handle(request, new URL(request.url), info);
    return await res.text();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("createDesktopHandler: the relay origin is injected in the memory world only", async () => {
  assertStringIncludes(await shell(MEMORY, "http+memory://app", MEM_INFO), RELAY);
  assert(!(await shell({ kind: "loopback" }, "http://127.0.0.1:8000")).includes(RELAY));
});
