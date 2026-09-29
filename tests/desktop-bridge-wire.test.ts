// First end-to-end of the desktop capability bridge over the REAL wire: the runtime's
// `createDesktopHandler` + `createDesktopBridge` (src/build/desktop.ts, src/desktop/bridge.ts)
// served by `Deno.serve` on an ephemeral loopback port, driven by the REAL page side
// (src/desktop/client.ts → bridge-client.ts, and a `denext/mobile` function's desktop branch).
//
// The page runs in Deno, so `fetch` is shimmed to behave like a browser document at the window
// origin: relative URLs resolve against it, and a non-GET request carries `Origin` (a same-origin
// GET does not). Everything past the shim — HTTP, the gate, the dispatcher, SSE — is real.
// The same stack in headless Chromium: tests/e2e/desktop-bridge-browser.e2e.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { desktopExtension, isDesktopBridgeError, onDesktopEvent } from "../src/desktop/client.ts";
import {
  desktopRpc,
  MAX_RPC_BODY_BYTES,
  resetDesktopBridgeForTesting,
} from "../src/desktop/bridge-client.ts";
import { echoCapability } from "../src/desktop/caps/echo.ts";
import type { DesktopCapability } from "../src/desktop/extension.ts";
import { readClipboard } from "../src/mobile/clipboard.ts";
import {
  type BridgeServer,
  injectedGlobal,
  startBridgeServer,
  until,
} from "./helpers/desktop-bridge-server.ts";

/** A slow capability, to reach the runtime's handler deadline (408) through the client. */
const slow: DesktopCapability = {
  name: "slow",
  methods: { hang: { timeoutMs: 50, handler: () => new Promise<never>(() => {}) } },
};

const TEST = { sanitizeOps: false, sanitizeResources: false } as const;

/**
 * Load the shell as a top-level document (as the window would), take the `__denext` the handler
 * injected, and install it plus a browser-like `fetch` for `pageOrigin` (default: the window's).
 */
async function asPage(
  server: BridgeServer,
  opts: { pageOrigin?: string; token?: string } = {},
): Promise<() => void> {
  const html = await (await fetch(`${server.origin}/`, {
    headers: { "sec-fetch-dest": "document", accept: "text/html" },
  })).text();
  const injected = injectedGlobal(html);
  assert(injected, "the top-level shell carries __denext");
  const g = globalThis as { __denext?: unknown };
  const prevFetch = globalThis.fetch;
  g.__denext = opts.token === undefined ? injected : { ...injected, token: opts.token };
  const pageOrigin = opts.pageOrigin ?? server.origin;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), server.origin);
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") headers.set("origin", pageOrigin);
    headers.set("sec-fetch-dest", "empty");
    return prevFetch(url, { ...init, headers });
  };
  return () => {
    resetDesktopBridgeForTesting();
    globalThis.fetch = prevFetch;
    delete g.__denext;
  };
}

/** Run `fn` as the page of a fresh real runtime; always tears both down. */
async function withPage(
  caps: readonly DesktopCapability[],
  fn: (server: BridgeServer) => Promise<void>,
  opts: { pageOrigin?: string; token?: string } = {},
): Promise<void> {
  const server = await startBridgeServer(caps);
  const restore = await asPage(server, opts);
  try {
    await fn(server);
  } finally {
    restore();
    await server.close();
  }
}

const codeOf = (err: unknown) => (err as { code?: string }).code;

Deno.test({ ...TEST, name: "wire: echo.ping round-trips through the real client" }, async () => {
  await withPage([echoCapability], async (server) => {
    const echo = desktopExtension<typeof echoCapability>("echo");
    const before = Date.now();
    const res = await echo.ping({ hi: 1, s: "ü" }) as { echo: unknown; os: string; at: number };
    assertEquals(res.echo, { hi: 1, s: "ü" });
    assertEquals(res.os, Deno.build.os);
    assert(res.at >= before && res.at <= Date.now() + 1, `at: ${res.at}`);
    // No args → the client sends `args: null`, the runtime echoes null.
    assertEquals((await echo.ping(undefined) as { echo: unknown }).echo, null);
    const rpc = server.log.find((r) => r.path === "/_denext/desktop/rpc")!;
    assertEquals(rpc.status, 200);
    assertEquals(rpc.headers.get("origin"), server.origin);
    assertEquals(rpc.headers.get("content-type"), "application/json");
  });
});

Deno.test({ ...TEST, name: "wire: emitPong arrives through onDesktopEvent" }, async () => {
  await withPage([echoCapability], async (server) => {
    const got: unknown[] = [];
    const stop = onDesktopEvent<unknown>("echo", "pong", (d) => got.push(d));
    try {
      await until(() => server.openEventStreams() === 1);
      const echo = desktopExtension<typeof echoCapability>("echo");
      assertEquals(await echo.emitPong({ n: 1 }), { emitted: true });
      await until(() => got.length === 1);
      assertEquals(got, [{ n: 1 }]);
      const ev = server.log.find((r) => r.path === "/_denext/desktop/events")!;
      assertEquals(ev.status, 200);
      assertEquals(ev.headers.get("origin"), null, "a same-origin GET carries no Origin");
    } finally {
      stop();
    }
    await until(() => server.openEventStreams() === 0);
  });
});

Deno.test({
  ...TEST,
  name: "wire: an event emitted before any subscriber is replayed to the first one",
}, async () => {
  await withPage([echoCapability], async () => {
    const echo = desktopExtension<typeof echoCapability>("echo");
    await echo.emitPong({ launch: true }); // before the page subscribed (a launch event)
    const got: unknown[] = [];
    const stop = onDesktopEvent("echo", "pong", (d) => got.push(d));
    try {
      await until(() => got.length === 1);
      assertEquals(got, [{ launch: true }]);
    } finally {
      stop();
    }
  });
});

Deno.test({
  ...TEST,
  name: "wire: a dropped stream reconnects with Last-Event-ID and replays only the missed events",
}, async () => {
  await withPage([echoCapability], async (server) => {
    const got: unknown[] = [];
    const stop = onDesktopEvent<{ n: number }>("echo", "pong", (d) => got.push(d.n));
    try {
      await until(() => server.openEventStreams() === 1);
      const echo = desktopExtension<typeof echoCapability>("echo");
      await echo.emitPong({ n: 1 });
      await echo.emitPong({ n: 2 });
      await until(() => got.length === 2);
      server.dropEventStreams();
      await until(() => server.openEventStreams() === 0);
      // Emitted while the page is disconnected.
      await echo.emitPong({ n: 3 });
      server.bridge.emit("echo", "pong", { n: 4 });
      // The client backs off (1 s) then reconnects with the last id it saw.
      await until(() => got.length === 4, 8000);
      assertEquals(got, [1, 2, 3, 4], "no repeat of 1–2, no gap for 3–4");
      const opens = server.log.filter((r) => r.path === "/_denext/desktop/events");
      assertEquals(opens.length, 2);
      assertEquals(opens[0].headers.get("last-event-id"), null);
      assertEquals(opens[1].headers.get("last-event-id"), "2");
      await echo.emitPong({ n: 5 }); // live again after the reconnect
      await until(() => got.length === 5);
    } finally {
      stop();
    }
  });
});

Deno.test({
  ...TEST,
  name: "wire: a cap that is not enabled → unavailable, and the web fallback runs",
}, async () => {
  await withPage([echoCapability], async (server) => {
    const err = await assertRejects(() => desktopExtension("scanner").list({}));
    assert(isDesktopBridgeError(err));
    assertEquals(codeOf(err), "unavailable");
    assertEquals(server.log.at(-1)?.status, 404);
    // An enabled cap with an unknown method is unavailable too.
    assertEquals(
      codeOf(await assertRejects(() => desktopExtension("echo").nope({}))),
      "unavailable",
    );
    // `denext/mobile`'s readClipboard on desktop asks the runtime's `clipboard` cap first; it is
    // not enabled, so the call falls through to navigator.clipboard (the web path).
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(nav, "clipboard");
    Object.defineProperty(nav, "clipboard", {
      configurable: true,
      value: { readText: () => Promise.resolve("from-web"), writeText: () => Promise.resolve() },
    });
    try {
      const before = server.log.length;
      assertEquals(await readClipboard(), "from-web");
      const asked = server.log.slice(before);
      assertEquals(asked.map((r) => [r.path, r.status]), [["/_denext/desktop/rpc", 404]]);
    } finally {
      if (had) Object.defineProperty(nav, "clipboard", had);
      else delete nav.clipboard;
    }
  });
});

Deno.test({ ...TEST, name: "wire: a wrong token is refused (forbidden)" }, async () => {
  await withPage([echoCapability], async (server) => {
    const err = await assertRejects(() => desktopExtension("echo").ping({}));
    assertEquals(codeOf(err), "forbidden");
    assertEquals(server.log.at(-1)?.status, 403);
    // The event stream is refused too, and the client stops (403 is fatal, no retry storm).
    const stop = onDesktopEvent("echo", "pong", () => {});
    try {
      await until(() => server.log.some((r) => r.path === "/_denext/desktop/events"));
      await new Promise((r) => setTimeout(r, 1500));
      const opens = server.log.filter((r) => r.path === "/_denext/desktop/events");
      assertEquals(opens.map((r) => r.status), [403]);
    } finally {
      stop();
    }
  }, { token: "not-the-launch-token" });
});

Deno.test({ ...TEST, name: "wire: a foreign Origin is refused (forbidden)" }, async () => {
  await withPage([echoCapability], async (server) => {
    const err = await assertRejects(() => desktopExtension("echo").ping({}));
    assertEquals(codeOf(err), "forbidden");
    assertEquals(server.log.at(-1)?.status, 403);
  }, { pageOrigin: "http://evil.example" });
});

Deno.test(
  { ...TEST, name: "wire: raw gate — preflight, content type, events Origin, size" },
  async () => {
    const server = await startBridgeServer([echoCapability]);
    const rpcUrl = `${server.origin}/_denext/desktop/rpc`;
    const eventsUrl = `${server.origin}/_denext/desktop/events`;
    const tok = { "x-denext-desktop-token": server.token };
    try {
      for (const url of [rpcUrl, eventsUrl]) {
        const pre = await fetch(url, {
          method: "OPTIONS",
          headers: {
            origin: "http://evil.example",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type,x-denext-desktop-token",
          },
        });
        await pre.body?.cancel();
        assertEquals(pre.status, 403, url);
        assertEquals(pre.headers.get("access-control-allow-origin"), null, url);
        assertEquals(pre.headers.get("access-control-allow-headers"), null, url);
      }
      // text/plain (a CORS "simple" request a foreign form could send) → 415.
      const plain = await fetch(rpcUrl, {
        method: "POST",
        headers: { ...tok, origin: server.origin, "content-type": "text/plain" },
        body: JSON.stringify({ cap: "echo", method: "ping" }),
      });
      assertEquals(plain.status, 415);
      assertEquals((await plain.json()).error.code, "forbidden");
      // No Origin on the RPC → 403.
      const noOrigin = await fetch(rpcUrl, {
        method: "POST",
        headers: { ...tok, "content-type": "application/json" },
        body: JSON.stringify({ cap: "echo", method: "ping" }),
      });
      assertEquals(noOrigin.status, 403);
      await noOrigin.body?.cancel();
      // Events: token required; a foreign Origin refused; absent Origin accepted.
      const evNoTok = await fetch(eventsUrl);
      assertEquals(evNoTok.status, 403);
      await evNoTok.body?.cancel();
      const evForeign = await fetch(eventsUrl, {
        headers: { ...tok, origin: "http://evil.example" },
      });
      assertEquals(evForeign.status, 403);
      await evForeign.body?.cancel();
      const evOk = await fetch(eventsUrl, { headers: tok });
      assertEquals(evOk.status, 200);
      assertEquals(evOk.headers.get("content-type"), "text/event-stream; charset=utf-8");
      await evOk.body?.cancel();
      // Over 4 MiB → 413 too_large (runtime side, a real body).
      const big = JSON.stringify({
        cap: "echo",
        method: "ping",
        args: "x".repeat(MAX_RPC_BODY_BYTES),
      });
      const tooBig = await fetch(rpcUrl, {
        method: "POST",
        headers: { ...tok, origin: server.origin, "content-type": "application/json" },
        body: big,
      });
      assertEquals(tooBig.status, 413);
      assertEquals((await tooBig.json()).error.code, "too_large");
    } finally {
      await server.close();
    }
  },
);

Deno.test({ ...TEST, name: "wire: client-side too_large and runtime timeout (408)" }, async () => {
  await withPage([echoCapability, slow], async (server) => {
    const before = server.log.length;
    const big = await assertRejects(() =>
      desktopRpc("echo", "ping", "x".repeat(MAX_RPC_BODY_BYTES))
    );
    assertEquals(codeOf(big), "too_large");
    assertEquals(server.log.length, before, "rejected before any request");
    const slowErr = await assertRejects(() => desktopExtension("slow").hang({}));
    assertEquals(codeOf(slowErr), "timeout");
    assertEquals(server.log.at(-1)?.status, 408);
  });
});

Deno.test({
  ...TEST,
  name: "wire: the token goes into the top-level document only, never a subframe",
}, async () => {
  const server = await startBridgeServer([echoCapability]);
  try {
    const get = async (path: string, dest?: string) => {
      const headers: Record<string, string> = { accept: "text/html" };
      if (dest) headers["sec-fetch-dest"] = dest;
      const res = await fetch(server.origin + path, { headers });
      assertEquals(res.headers.get("cache-control"), "no-store, must-revalidate");
      return injectedGlobal(await res.text());
    };
    for (const path of ["/", "/index.html", "/some/route"]) {
      const top = await get(path, "document");
      assertEquals(top, { desktop: true, token: server.token, os: Deno.build.os }, path);
      for (const dest of ["iframe", "frame", "embed", "object"]) {
        const sub = await get(path, dest);
        assertEquals(sub, { desktop: true, os: Deno.build.os }, `${path} as ${dest}`);
      }
    }
  } finally {
    await server.close();
  }
});

Deno.test(
  "wire: a top-level navigation runs every capability's onPageLoad (a reload drops page state)",
  TEST,
  async () => {
    let loads = 0;
    const pageScoped: DesktopCapability = {
      name: "pageScoped",
      methods: { ping: { handler: () => "pong" } },
      onPageLoad: () => {
        loads++;
      },
    };
    const server = await startBridgeServer([pageScoped]);
    try {
      const nav = (headers: Record<string, string>) =>
        fetch(`${server.origin}/`, { headers: { accept: "text/html", ...headers } }).then((r) =>
          r.body?.cancel()
        );
      await nav({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" });
      assertEquals(loads, 1);
      // A subframe, a subresource or a non-browser GET is not a new page.
      await nav({ "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" });
      await nav({ "sec-fetch-dest": "document" });
      await nav({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" });
      assertEquals(loads, 1);
      await nav({ "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" });
      assertEquals(loads, 2);
    } finally {
      await server.close();
    }
  },
);
