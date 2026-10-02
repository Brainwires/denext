// `runDesktop` (src/build/desktop.ts) end to end, with `Deno.serve` stubbed so the test drives the
// exact handler the window would reach: where it listens, which world it decides it is in (the
// stock runtime's loopback port, the pinned runtime's memory transport, a refused origin), when the
// per-launch token is injected, the live-reload proxy decision, and — under a fake pinned runtime —
// the adopted window, its guarded close and the capabilities registered with it.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { injectedGlobal } from "./helpers/desktop-bridge-server.ts";
import { boot, exportDir, get, pageRpc, RPC, TOKEN_HEADER } from "./helpers/desktop-run-boot.ts";

Deno.test("runDesktop (stock runtime): serves the export on loopback; only a loopback document gets the token", async () => {
  const outDir = await exportDir();
  try {
    const { runtime, served } = await boot({ outDir, port: 8123 });
    assertEquals([served.opts.port, served.opts.hostname], [8123, "127.0.0.1"]);
    assertEquals(runtime.window, undefined, "no BrowserWindow under a plain deno run");
    assertEquals(runtime.trust.kind, "loopback");
    const shell = await served.handler(get("http://127.0.0.1:8123/"), {});
    const html = await shell.text();
    const g = injectedGlobal(html)!;
    assertEquals(g.desktop, true);
    assert(typeof g.token === "string" && g.token.length > 0);
    // The CSP meta now allows the injected script by hash.
    assertStringIncludes(html, "script-src 'self' 'sha256-");
    // A DNS-rebinding Host or a subframe learns it is desktop, but gets no token.
    for (
      const req of [
        get("http://evil.example:8123/"),
        get("http://127.0.0.1:8123/", { "sec-fetch-dest": "iframe" }),
      ]
    ) {
      const other = injectedGlobal(await (await served.handler(req, {})).text());
      assertEquals(other?.desktop, true);
      assertEquals(other?.token, undefined);
    }
    assertEquals(
      await (await served.handler(get("http://127.0.0.1:8123/app.js"), {})).text(),
      "console.log('app')",
    );
    // No capabilities: every RPC answers unavailable (default deny), even with the token.
    const rpc = await served.handler(
      new Request(`http://127.0.0.1:8123${RPC}`, {
        method: "POST",
        headers: {
          [TOKEN_HEADER]: g.token as string,
          origin: "http://127.0.0.1:8123",
          "content-type": "application/json",
          "sec-fetch-dest": "empty",
        },
        body: JSON.stringify({ cap: "window", method: "state", args: {} }),
      }),
      {},
    );
    assertEquals((await rpc.json()).error.code, "unavailable");
    // A handler error is a 502, logged, never a crash.
    const errors: unknown[] = [];
    const prev = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      assertEquals(served.opts.onError(new Error("boom")).status, 502);
    } finally {
      console.error = prev;
    }
    assertEquals(errors.length, 1);
    runtime.emit("window", "state", null); // no page subscribed: a no-op
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop: PORT is the default port; a configured app origin without the pinned runtime warns", async () => {
  const outDir = await exportDir();
  try {
    const { served, errors } = await boot({ outDir, appOrigin: "myapp://app" }, {
      env: { PORT: "9011" },
    });
    assertEquals(served.opts.port, 9011);
    assert(errors.some((e) => e.includes('desktop.app.origin "myapp://app" is not in effect')));
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop (pinned runtime): the memory world injects the token only over the memory transport", async () => {
  const outDir = await exportDir();
  try {
    const { runtime, served } = await boot({ outDir, port: 1 }, {
      env: { DENO_DESKTOP_APP_ORIGIN: "myapp://app" },
    });
    assertEquals(runtime.trust.kind, "memory");
    const memory = await served.handler(get("http+memory://app/"), {
      remoteAddr: { transport: "memory" },
    });
    assert(typeof injectedGlobal(await memory.text())?.token === "string");
    // The same URL over TCP (an absolute-form request target) is not the memory transport.
    const tcp = await served.handler(get("http+memory://app/"), {
      remoteAddr: { transport: "tcp" },
    });
    assertEquals(injectedGlobal(await tcp.text())?.token, undefined);
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test("runDesktop: a malformed published origin refuses every desktop endpoint", async () => {
  const outDir = await exportDir();
  try {
    const { runtime, served, errors } = await boot({ outDir, port: 1 }, {
      env: { DENO_DESKTOP_APP_ORIGIN: "not an origin" },
    });
    assertEquals(runtime.trust.kind, "refuse");
    assert(errors.some((e) => e.includes("every desktop endpoint is refused")));
    const res = await served.handler(get("http://127.0.0.1:1/"), {});
    assertEquals(injectedGlobal(await res.text())?.token, undefined);
  } finally {
    await Deno.remove(outDir, { recursive: true });
  }
});

Deno.test({
  name:
    "runDesktop: a loopback dev URL proxies to `denext dev` (token stripped); a remote one is refused",
  sanitizeResources: false, // the proxied fetch's keep-alive connection
  fn: async () => {
    const outDir = await exportDir();
    const seen: Array<{ path: string; token: string | null }> = [];
    const ac = new AbortController();
    const dev = Deno.serve({
      port: 0,
      hostname: "127.0.0.1",
      signal: ac.signal,
      onListen: () => {},
    }, (req) => {
      seen.push({ path: new URL(req.url).pathname, token: req.headers.get(TOKEN_HEADER) });
      return new Response("<html><head></head><body>from dev</body></html>", {
        headers: { "content-type": "text/html" },
      });
    });
    try {
      const devUrl = `http://127.0.0.1:${dev.addr.port}`;
      const { served } = await boot({ outDir, port: 1 }, {
        env: { DENEXT_DESKTOP_DEV_URL: devUrl },
      });
      const res = await served.handler(
        get("http://127.0.0.1:1/settings", { [TOKEN_HEADER]: "launch-token" }),
        {},
      );
      const html = await res.text();
      assertStringIncludes(html, "from dev");
      assert(
        typeof injectedGlobal(html)?.token === "string",
        "a loopback dev target gets the token",
      );
      assertEquals(seen[0].path, "/settings");
      assertEquals(
        seen[0].token,
        null,
        "the token never reaches the dev server",
      );
      // A non-loopback target without --lan: refused, the static export is served instead.
      const remote = await boot({ outDir, port: 1 }, {
        env: { DENEXT_DESKTOP_DEV_URL: "http://192.168.1.50:3000" },
      });
      assert(remote.errors.some((e) => e.includes("serving the static export")));
      assertStringIncludes(
        await (await remote.served.handler(get("http://127.0.0.1:1/"), {})).text(),
        '<div id="root">',
      );
    } finally {
      ac.abort();
      await dev.finished;
      await Deno.remove(outDir, { recursive: true });
    }
  },
});

/** A pinned-runtime window: enough for the window controller and the app controller. */
class FakeBrowserWindow extends EventTarget {
  static last: FakeBrowserWindow | undefined;
  closed = false;
  constructor() {
    super();
    FakeBrowserWindow.last = this;
  }
  getBounds() {
    return { x: 0, y: 0, width: 1024, height: 768 };
  }
  isMaximized() {
    return false;
  }
  setTitle(_t: string) {}
  close() {
    this.closed = true;
  }
}

Deno.test("runDesktop (pinned runtime): adopts the window; its capabilities answer; a guarded close keeps the app", async () => {
  const outDir = await exportDir();
  const exits: number[] = [];
  try {
    const desktop = Object.assign(new EventTarget(), { quit: () => false, launchUrls: [] });
    const { runtime, served } = await boot({ outDir, port: 1, deepLinks: ["myapp"] }, {
      deno: {
        BrowserWindow: FakeBrowserWindow,
        desktop,
        exit: (code: number) => void exits.push(code),
      },
    });
    const win = FakeBrowserWindow.last!;
    assertEquals(runtime.window, win);
    const token = injectedGlobal(
      await (await served.handler(get("http://127.0.0.1:1/"), {})).text(),
    )!
      .token as string;
    const rpc = pageRpc(served, token);
    assertEquals(((await rpc("window", "state")).data as { bounds: unknown }).bounds, {
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
    });
    assertEquals((await rpc("deepLinks", "take")).ok, true, "the launch router is registered");
    assertEquals((await rpc("app", "capabilities")).ok, true, "the app controller is registered");
    // With the page guarding the close, the native close is held, not an exit.
    assertEquals((await rpc("window", "setCloseGuard", { enabled: true })).ok, true);
    const held = new Event("close", { cancelable: true });
    win.dispatchEvent(held);
    assert(held.defaultPrevented);
    assertEquals(exits, []);
    // Unguarded, the native close ends the process.
    assertEquals((await rpc("window", "setCloseGuard", { enabled: false })).ok, true);
    win.dispatchEvent(new Event("close", { cancelable: true }));
    assertEquals(exits, [0]);
  } finally {
    FakeBrowserWindow.last = undefined;
    await Deno.remove(outDir, { recursive: true });
  }
});
