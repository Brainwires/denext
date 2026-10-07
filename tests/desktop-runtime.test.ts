// The `denext/desktop` runtime's request handler: static export assets (no-store), the
// SPA shell for navigations, the onRequest escape hatch, and 404s — no window needed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  createDesktopHandler,
  desktopDevProxyDecision,
  isDenoCliExecPath,
  resolveOutDir,
  stripDesktopCredentials,
} from "../src/build/desktop.ts";
import { isLoopbackHost } from "../src/utils/loopback.ts";

Deno.test("isLoopbackHost: strict — a `127.`-prefix / `.localhost`-suffix DNS name is NOT loopback", () => {
  // Genuine loopback.
  assert(isLoopbackHost("localhost"));
  assert(isLoopbackHost("LOCALHOST"));
  assert(isLoopbackHost("127.0.0.1"));
  assert(isLoopbackHost("127.0.0.2"));
  assert(isLoopbackHost("::1"));
  assert(isLoopbackHost("[::1]"));
  // Attacker-controllable names that a loose prefix/suffix check would wrongly accept.
  assert(!isLoopbackHost("127.0.0.1.evil.com"));
  assert(!isLoopbackHost("foo.localhost"));
  assert(!isLoopbackHost("127.evil.example"));
  assert(!isLoopbackHost("192.168.1.5"));
  assert(!isLoopbackHost("example.com"));
});

const DENO_CLI = "/usr/local/bin/deno";
const PACKAGED = "/Applications/T3.app/Contents/MacOS/T3";

Deno.test("isDenoCliExecPath: deno CLI (case-insensitive) vs a packaged binary", () => {
  assert(isDenoCliExecPath("deno"));
  assert(isDenoCliExecPath("/usr/local/bin/deno"));
  assert(isDenoCliExecPath("deno.exe"));
  assert(isDenoCliExecPath("DENO.EXE"));
  assert(!isDenoCliExecPath(PACKAGED));
  assert(!isDenoCliExecPath("/opt/app/myapp"));
  assert(!isDenoCliExecPath("app.exe"));
});

Deno.test("desktopDevProxyDecision: runtime loopback + packaged enforcement (the release-proxy blocker)", () => {
  // No env → never proxy.
  assertEquals(desktopDevProxyDecision(undefined, false, DENO_CLI), { proxy: false });
  // Loopback under the deno CLI → proxy, and NOT allowNonLoopback (so proxyToBackend keeps its guard).
  assertEquals(desktopDevProxyDecision("http://127.0.0.1:3000", false, DENO_CLI), {
    proxy: true,
    target: "http://127.0.0.1:3000",
    allowNonLoopback: false,
  });
  assertEquals(desktopDevProxyDecision("http://localhost:3000", false, DENO_CLI).proxy, true);
  // Non-loopback WITHOUT the --lan opt-in → REFUSED (serve static), even under the deno CLI.
  const refused = desktopDevProxyDecision("http://192.168.1.5:3000", false, DENO_CLI);
  assertEquals(refused.proxy, false);
  assert(refused.proxy === false && refused.refused);
  // Non-loopback WITH --lan → proxy + allowNonLoopback.
  assertEquals(desktopDevProxyDecision("http://192.168.1.5:3000", true, DENO_CLI), {
    proxy: true,
    target: "http://192.168.1.5:3000",
    allowNonLoopback: true,
  });
  // PACKAGED binary → the env is IGNORED even for a loopback target (the release-proxy hole).
  const packagedLoopback = desktopDevProxyDecision("http://127.0.0.1:3000", false, PACKAGED);
  assertEquals(packagedLoopback.proxy, false);
  assert(packagedLoopback.proxy === false && packagedLoopback.refused);
  // Packaged + --lan + non-loopback → still ignored.
  assertEquals(desktopDevProxyDecision("http://192.168.1.5:3000", true, PACKAGED).proxy, false);
  // Unparseable URL → refused.
  assertEquals(desktopDevProxyDecision("not a url", false, DENO_CLI).proxy, false);
  // A `127.`-prefix / `.localhost`-suffix DNS name is NOT loopback → refused without --lan (would
  // otherwise be proxied to an attacker AND handed the token via devInjectToken).
  assertEquals(
    desktopDevProxyDecision("http://127.0.0.1.evil.com:3000", false, DENO_CLI).proxy,
    false,
  );
  assertEquals(desktopDevProxyDecision("http://foo.localhost:3000", false, DENO_CLI).proxy, false);
  // Non-http protocol → refused.
  assertEquals(desktopDevProxyDecision("ftp://127.0.0.1:3000", false, DENO_CLI).proxy, false);
  assertEquals(desktopDevProxyDecision("https://127.0.0.1:3000", false, DENO_CLI).proxy, false);
  // Genuine full-block loopback → proxied.
  assertEquals(desktopDevProxyDecision("http://127.0.0.2:3000", false, DENO_CLI), {
    proxy: true,
    target: "http://127.0.0.2:3000",
    allowNonLoopback: false,
  });
  assertEquals(desktopDevProxyDecision("http://[::1]:3000", false, DENO_CLI).proxy, true);
});

async function exportDir(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "index.html"), "<!doctype html><div id=root></div>");
  await Deno.mkdir(join(dir, "_denext", "client"), { recursive: true });
  await Deno.writeTextFile(join(dir, "_denext", "client", "index.js"), "console.log(1);");
  return dir;
}

Deno.test("desktop handler: assets are served no-store, navigations get the shell, files 404", async () => {
  const dir = await exportDir();
  try {
    const handle = createDesktopHandler({}, dir, undefined);
    const get = (path: string, headers: Record<string, string> = {}) =>
      handle(
        new Request(`http://127.0.0.1${path}`, { headers }),
        new URL(`http://127.0.0.1${path}`),
      );

    const asset = await get("/_denext/client/index.js");
    assertEquals(asset.status, 200);
    assertEquals(asset.headers.get("cache-control"), "no-store, must-revalidate");
    assertEquals(asset.headers.get("etag"), null);
    assertEquals(await asset.text(), "console.log(1);");

    const nav = await get("/settings/profile", { accept: "text/html" });
    assertEquals(nav.status, 200);
    assertStringIncludes(await nav.text(), "<div id=root>");
    assertEquals(nav.headers.get("cache-control"), "no-store, must-revalidate");

    const head = await handle(
      new Request("http://127.0.0.1/", { method: "HEAD" }),
      new URL("http://127.0.0.1/"),
    );
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");

    const missing = await get("/missing.png");
    assertEquals(missing.status, 404);

    const post = await handle(
      new Request("http://127.0.0.1/route", { method: "POST" }),
      new URL("http://127.0.0.1/route"),
    );
    assertEquals(post.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler: a multi-page export's routes load their own page, not the root shell", async () => {
  // A static App Router export (examples/clerk): `<a href="/protected">` must load
  // `protected/index.html`. It used to get the root `index.html`, so the link "did nothing".
  const dir = await exportDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "protected"));
    await Deno.writeTextFile(
      join(dir, "protected", "index.html"),
      "<!doctype html><head></head><main>PROTECTED</main>",
    );
    await Deno.writeTextFile(
      join(dir, "about.html"),
      "<!doctype html><head></head><main>ABOUT</main>",
    );
    await Deno.writeTextFile(join(outside, "index.html"), "<main>OUTSIDE</main>");
    await Deno.symlink(outside, join(dir, "leak"));
    const handle = createDesktopHandler({}, dir, undefined, "tok-pages");
    const get = (path: string, headers: Record<string, string>) =>
      handle(
        new Request(`http://127.0.0.1${path}`, { headers }),
        new URL(`http://127.0.0.1${path}`),
      );
    // A hard navigation (the link without the client router) and the client router's soft-nav fetch.
    const navigation = {
      accept: "text/html",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    const softNav = { "x-denext-nav": "1", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" };

    for (const path of ["/protected", "/protected/", "/protected/index.html"]) {
      const res = await get(path, navigation);
      assertEquals(res.status, 200, path);
      assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
      assertEquals(res.headers.get("cache-control"), "no-store, must-revalidate");
      const html = await res.text();
      assertStringIncludes(html, "PROTECTED", path);
      // The page gets the same desktop global (with the token) the root shell gets.
      assertStringIncludes(html, "globalThis.__denext=", path);
      assertStringIncludes(html, "tok-pages", path);
    }
    const soft = await (await get("/protected", softNav)).text();
    assertStringIncludes(soft, "PROTECTED");
    assert(!soft.includes("tok-pages"), "a non-document fetch never gets the token");

    assertStringIncludes(await (await get("/about", navigation)).text(), "ABOUT");
    // `/` and a client-side route of a single-page app still get the root shell.
    assertStringIncludes(await (await get("/", navigation)).text(), "<div id=root>");
    assertStringIncludes(
      await (await get("/settings/profile", navigation)).text(),
      "<div id=root>",
    );
    // A page reached through a symlink out of the export is not served.
    const leak = await (await get("/leak", navigation)).text();
    assert(!leak.includes("OUTSIDE"));
    assertStringIncludes(leak, "<div id=root>");
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("desktop handler: onRequest intercepts before serving; a null result falls through", async () => {
  const dir = await exportDir();
  try {
    const handle = createDesktopHandler(
      {
        onRequest: (_req, url) => url.pathname === "/api/ping" ? new Response("pong") : null,
      },
      dir,
      undefined,
    );
    const hit = await handle(
      new Request("http://127.0.0.1/api/ping"),
      new URL("http://127.0.0.1/api/ping"),
    );
    assertEquals(await hit.text(), "pong");
    const asset = await handle(
      new Request("http://127.0.0.1/_denext/client/index.js"),
      new URL("http://127.0.0.1/_denext/client/index.js"),
    );
    assertEquals(asset.status, 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler: no shell when the export has no index.html", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const handle = createDesktopHandler({}, dir, undefined);
    const res = await handle(
      new Request("http://127.0.0.1/anything", { headers: { accept: "text/html" } }),
      new URL("http://127.0.0.1/anything"),
    );
    assertEquals(res.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler: boot beacon confirms via a token-gated endpoint (updater on)", async () => {
  const dir = await exportDir();
  try {
    let booted = 0;
    const token = "tok-abc-123";
    const handle = createDesktopHandler({}, dir, undefined, token, () => {
      booted++;
    });
    const at = (path: string) => `http://127.0.0.1${path}`;

    // The shell carries the boot-confirm beacon (and the __denext global) when the updater is on.
    const shell = await handle(
      new Request(at("/"), { headers: { accept: "text/html" } }),
      new URL(at("/")),
    );
    const html = await shell.text();
    assertStringIncludes(html, "globalThis.__denext=");
    assertStringIncludes(html, "/_denext/desktop/booted");

    // A GET is rejected; only POST confirms.
    const bad = await handle(
      new Request(at("/_denext/desktop/booted")),
      new URL(at("/_denext/desktop/booted")),
    );
    assertEquals(bad.status, 405);
    assertEquals(booted, 0);

    // A POST without the per-launch token is refused (a cross-origin drive-by cannot confirm).
    const noToken = await handle(
      new Request(at("/_denext/desktop/booted"), { method: "POST" }),
      new URL(at("/_denext/desktop/booted")),
    );
    assertEquals(noToken.status, 403);
    assertEquals(booted, 0);

    // A POST with the token confirms exactly once.
    const ok = await handle(
      new Request(at("/_denext/desktop/booted"), {
        method: "POST",
        headers: { "x-denext-desktop-token": token },
      }),
      new URL(at("/_denext/desktop/booted")),
    );
    assertEquals(ok.status, 204);
    assertEquals(booted, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler: window.close() quits via a token-gated quit endpoint", async () => {
  const dir = await exportDir();
  try {
    let quit = 0;
    const token = "tok-quit-xyz";
    const handle = createDesktopHandler(
      {},
      dir,
      undefined,
      token,
      undefined, // onBooted
      undefined, // devProxy
      false, // devInjectToken
      undefined, // bridge
      () => quit++, // onQuit (production passes Deno.exit(0))
    );
    const at = (p: string) => `http://127.0.0.1${p}`;

    // The shell overrides window.close to POST the token to /quit.
    const shell = await handle(
      new Request(at("/"), { headers: { accept: "text/html" } }),
      new URL(at("/")),
    );
    const html = await shell.text();
    assertStringIncludes(html, "window.close=function");
    assertStringIncludes(html, "/_denext/desktop/quit");

    // GET is rejected; a POST without the token is refused (a cross-origin page cannot quit).
    assertEquals(
      (await handle(new Request(at("/_denext/desktop/quit")), new URL(at("/_denext/desktop/quit"))))
        .status,
      405,
    );
    const noTok = await handle(
      new Request(at("/_denext/desktop/quit"), { method: "POST" }),
      new URL(at("/_denext/desktop/quit")),
    );
    assertEquals(noTok.status, 403);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(quit, 0);

    // A POST with the token quits (204, then onQuit on the next microtask so the 204 flushes first).
    const ok = await handle(
      new Request(at("/_denext/desktop/quit"), {
        method: "POST",
        headers: { "x-denext-desktop-token": token },
      }),
      new URL(at("/_denext/desktop/quit")),
    );
    assertEquals(ok.status, 204);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(quit, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler: no beacon and no booted endpoint when the updater is off", async () => {
  const dir = await exportDir();
  try {
    const handle = createDesktopHandler({}, dir, undefined, "tok"); // no onBooted
    const shell = await handle(
      new Request("http://127.0.0.1/", { headers: { accept: "text/html" } }),
      new URL("http://127.0.0.1/"),
    );
    const html = await shell.text();
    assertStringIncludes(html, "globalThis.__denext=");
    assertEquals(html.includes("/_denext/desktop/booted"), false);
    // Without the updater the path is not special — it 404s through normal routing.
    const res = await handle(
      new Request("http://127.0.0.1/_denext/desktop/booted", { method: "POST" }),
      new URL("http://127.0.0.1/_denext/desktop/booted"),
    );
    assertEquals(res.status, 404);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- live-reload proxy mode (`denext desktop dev`) -------------------------------------------

Deno.test("desktop handler (dev mode): a normal request is proxied, with the desktop token stripped", async () => {
  const dir = await exportDir();
  try {
    let seen: Request | undefined;
    // The proxy call is injectable: tests need no real dev server.
    const devProxy = (req: Request, _url: URL) => {
      seen = req;
      return new Response("from-dev-server");
    };
    const handle = createDesktopHandler({}, dir, undefined, "tok", undefined, devProxy);
    const res = await handle(
      new Request("http://127.0.0.1/settings", {
        headers: { "x-denext-desktop-token": "tok", accept: "text/html" },
      }),
      new URL("http://127.0.0.1/settings"),
    );
    assertEquals(await res.text(), "from-dev-server", "the dev server's response is returned");
    assert(seen, "the proxy was called for a normal path");
    assertEquals(
      seen!.headers.get("x-denext-desktop-token"),
      null,
      "the per-launch token never reaches the dev server (invariant 2)",
    );
    assertEquals(seen!.headers.get("accept"), "text/html", "other headers pass through");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler (dev mode): token-gated local endpoints are served locally, never proxied", async () => {
  const dir = await exportDir();
  try {
    let booted = 0;
    const token = "tok-xyz";
    // A proxy that FAILS the test if it is ever reached for a local endpoint (invariant 1).
    const devProxy = (): Response => {
      throw new Error("a token-gated local endpoint was proxied to the dev server");
    };
    const handle = createDesktopHandler({}, dir, undefined, token, () => {
      booted++;
    }, devProxy);
    const at = (p: string) => `http://127.0.0.1${p}`;

    // auth-session: default-deny (no `auth-session` capability) — answered LOCALLY with
    // `unavailable` (404), never proxied. The invariant under test is "served locally", which
    // holds whether the cap is on or off.
    const auth = await handle(
      new Request(at("/_denext/desktop/auth-session")),
      new URL(at("/_denext/desktop/auth-session")),
    );
    assertEquals(auth.status, 404);
    assertEquals((await auth.json()).code, "unavailable");

    // With the capability enabled the endpoint is live locally (a GET is 405), still never proxied.
    const handleAuth = createDesktopHandler(
      { authSessionEnabled: true },
      dir,
      undefined,
      token,
      () => {
        booted++;
      },
      devProxy,
    );
    const authOn = await handleAuth(
      new Request(at("/_denext/desktop/auth-session")),
      new URL(at("/_denext/desktop/auth-session")),
    );
    assertEquals(authOn.status, 405);

    // booted: a POST without the token is refused locally (403), never proxied.
    const noTok = await handle(
      new Request(at("/_denext/desktop/booted"), { method: "POST" }),
      new URL(at("/_denext/desktop/booted")),
    );
    assertEquals(noTok.status, 403);
    assertEquals(booted, 0);

    // booted: a POST with the token confirms locally (204), never proxied.
    const ok = await handle(
      new Request(at("/_denext/desktop/booted"), {
        method: "POST",
        headers: { "x-denext-desktop-token": token },
      }),
      new URL(at("/_denext/desktop/booted")),
    );
    assertEquals(ok.status, 204);
    assertEquals(booted, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop handler (release path): no devProxy means the static export is served, never proxied", async () => {
  const dir = await exportDir();
  try {
    // `run` / `package` (no DENEXT_DESKTOP_DEV_URL) pass no devProxy: proxy mode is unreachable.
    const handle = createDesktopHandler({}, dir, undefined);
    const nav = await handle(
      new Request("http://127.0.0.1/settings", { headers: { accept: "text/html" } }),
      new URL("http://127.0.0.1/settings"),
    );
    assertEquals(nav.status, 200);
    assertStringIncludes(await nav.text(), "<div id=root>", "the local shell, not a proxied body");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stripDesktopCredentials: drops the token from HTTP, never reconstructs a WS upgrade", () => {
  const http = new Request("http://127.0.0.1/x", {
    headers: { "x-denext-desktop-token": "t", "x-keep": "1" },
  });
  const stripped = stripDesktopCredentials(http);
  assertEquals(stripped.headers.get("x-denext-desktop-token"), null);
  assertEquals(stripped.headers.get("x-keep"), "1", "other headers survive");

  // A WS upgrade cannot be reconstructed (Deno.upgradeWebSocket needs the original connection);
  // a browser cannot set a custom header on a WS handshake, and the WS bridge never forwards it.
  const ws = new Request("http://127.0.0.1/x", {
    headers: { upgrade: "websocket", "x-denext-desktop-token": "t" },
  });
  assert(stripDesktopCredentials(ws) === ws, "a WS upgrade is passed through unchanged");

  const plain = new Request("http://127.0.0.1/x");
  assert(stripDesktopCredentials(plain) === plain, "no token: the same request is returned");
});

Deno.test("desktop handler (dev mode): __denext injected into proxied HTML; token only when devInjectToken", async () => {
  const dir = await exportDir();
  try {
    const at = (p: string) => `http://127.0.0.1${p}`;
    const nav = (p: string) =>
      [new Request(at(p), { headers: { accept: "text/html" } }), new URL(at(p))] as const;
    const htmlProxy = () =>
      new Response("<!doctype html><html><head></head><body></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    // Loopback (devInjectToken = true): {desktop:true} + the token + the boot beacon.
    const loop = createDesktopHandler({}, dir, undefined, "tok", undefined, htmlProxy, true);
    const rl = await loop(...nav("/"));
    const bl = await rl.text();
    assertStringIncludes(bl, '"desktop":true');
    assertStringIncludes(bl, '"token":"tok"');
    assertStringIncludes(bl, "/_denext/desktop/booted");

    // --lan (devInjectToken = false): {desktop:true} only — NO token, NO beacon.
    const lan = createDesktopHandler({}, dir, undefined, "tok", undefined, htmlProxy, false);
    const bLan = await (await lan(...nav("/"))).text();
    assertStringIncludes(bLan, '"desktop":true');
    assert(!bLan.includes('"token"'));
    assert(!bLan.includes("/_denext/desktop/booted"));

    // A non-HTML proxied response streams through untouched.
    const js = createDesktopHandler(
      {},
      dir,
      undefined,
      "tok",
      undefined,
      () =>
        new Response("console.log(1)", { headers: { "content-type": "application/javascript" } }),
      true,
    );
    assertEquals(await (await js(...nav("/x.js"))).text(), "console.log(1)");

    // A COMPRESSED HTML response is NOT injected into (would corrupt the gzip) — passed through.
    const gz = createDesktopHandler(
      {},
      dir,
      undefined,
      "tok",
      undefined,
      () =>
        new Response("GZIPPEDBYTES", {
          headers: { "content-type": "text/html", "content-encoding": "gzip" },
        }),
      true,
    );
    assertEquals(await (await gz(...nav("/"))).text(), "GZIPPEDBYTES");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resolveOutDir: relative to importMetaUrl when given, else cwd", () => {
  const importMetaUrl = "file:///app/src/main.ts";
  assertEquals(resolveOutDir({ importMetaUrl }), fromFileUrl("file:///app/src/out"));
  assertEquals(
    resolveOutDir({ importMetaUrl, outDir: "../dist" }),
    fromFileUrl("file:///app/dist"),
  );
  assertEquals(resolveOutDir({ outDir: "/abs/out" }), "/abs/out");
  assertEquals(resolveOutDir({}), join(Deno.cwd(), "out"));
});

// ---- the backend proxy (`spa.proxy`) through the release handler -----------------------------

Deno.test({
  name: "desktop handler (release path): a gzip API response from the backend is relayed decodable",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // The T3 Code 3.0.0 black screen: the backend gzipped `/api/orchestration/shell`, `fetch`
  // decoded it, and the proxy relayed the plain bytes still labelled `Content-Encoding: gzip`
  // with the ENCODED `Content-Length` — WebKit: "cannot decode raw data".
  const { gzipSync } = await import("node:zlib");
  const payload = JSON.stringify({ shell: "zsh", pad: "x".repeat(2048) });
  const gz = new Uint8Array(gzipSync(new TextEncoder().encode(payload)));
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  const backend = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    signal: ac.signal,
    onListen: ({ port }) => resolve(port),
  }, () =>
    new Response(gz, {
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(gz.byteLength),
      },
    }));
  const backendPort = await promise;
  const dir = await exportDir();
  try {
    const proxy = await import("../src/build/dev-proxy.ts");
    const handle = createDesktopHandler(
      { proxy: { prefixes: ["/api"], target: `http://127.0.0.1:${backendPort}` } },
      dir,
      proxy,
    );
    const res = await handle(
      new Request("http://127.0.0.1/api/orchestration/shell", {
        headers: { "accept-encoding": "gzip, deflate, br" },
      }),
      new URL("http://127.0.0.1/api/orchestration/shell"),
    );
    assertEquals(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The body is plain JSON, so the response must not claim a gzip encoding or its length.
    assertEquals(res.headers.get("content-encoding"), null);
    assertEquals(res.headers.get("content-length"), null);
    assertEquals(new TextDecoder().decode(bytes), payload);
  } finally {
    ac.abort();
    await backend.finished;
    await Deno.remove(dir, { recursive: true });
  }
});
