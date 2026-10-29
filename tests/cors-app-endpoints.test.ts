// The app's `cors` policy beyond route handlers: pages, Server Actions, the API batch endpoint
// and the Live handshake. Preflights are answered before middleware; an allowed origin gets the
// CORS headers; and the endpoints whose same-origin check is the CSRF defense let an allowed
// origin in only when it carries no ambient credential (no cookie, no non-Bearer
// Authorization) — a cookie-carrying cross-origin request is refused exactly as before.

import { assert, assertEquals } from "@std/assert";
import { corsCredentialless, resolveCors } from "../src/server/cors.ts";
import { liveOriginAllowed } from "../src/server/origin-check.ts";
import { devLiveOriginAllowed } from "../src/build/dev-server/dev-endpoints.ts";
import { actionEndpoint } from "../src/runtime/server-action.ts";
import { serverAction } from "../src/runtime/action-stub.ts";
import { API_BATCH_HEADER, API_BATCH_PATH } from "../src/runtime/api-batch-protocol.ts";
import { batchApp } from "./helpers/batch-app.ts";
import { createApp } from "./helpers/released-app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";

const WEB = "https://web.test"; // allowed by the app's cors
const EVIL = "https://evil.test";
const CORS = { origins: [WEB], credentials: true };

serverAction("cors_app_echo", () => "ran");

function action(headers: Record<string, string>): Request {
  return new Request(`http://localhost${actionEndpoint("cors_app_echo")}`, {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-denext-action": "1",
      ...headers,
    },
    body: JSON.stringify({ args: [] }),
  });
}

function batch(headers: Record<string, string>): Request {
  return new Request(`http://localhost${API_BATCH_PATH}`, {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      [API_BATCH_HEADER]: "1",
      ...headers,
    },
    body: JSON.stringify({ v: 1, items: [{ id: 0, m: "GET", p: "/api/hello" }] }),
  });
}

function preflight(path: string, origin: string, headers = "content-type, x-denext-action") {
  return new Request(`http://localhost${path}`, {
    method: "OPTIONS",
    headers: {
      host: "localhost",
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": headers,
    },
  });
}

const acao = (res: Response) => res.headers.get("access-control-allow-origin");

// ---- Server Actions -----------------------------------------------------------------------------

Deno.test("cors + Server Action: an allowed origin without cookies runs it, with CORS headers", async () => {
  const app = batchApp({ cors: CORS });
  const res = await app(action({ origin: WEB }));
  assertEquals(res.status, 200);
  assertEquals(acao(res), WEB);
  assertEquals(res.headers.get("access-control-allow-credentials"), "true");
  const bearer = await app(action({ origin: WEB, authorization: "Bearer t0k" }));
  assertEquals(bearer.status, 200);
});

Deno.test("cors + Server Action: a cookie-carrying (or ambient-auth) cross-origin call keeps the CSRF refusal", async () => {
  const app = batchApp({ cors: CORS });
  const cookie = await app(action({ origin: WEB, cookie: "session=abc" }));
  assertEquals(cookie.status, 403);
  const basic = await app(action({ origin: WEB, authorization: "Basic dTpw" }));
  assertEquals(basic.status, 403);
  const evil = await app(action({ origin: EVIL }));
  assertEquals(evil.status, 403);
  assertEquals(acao(evil), null);
  // Without a cors policy nothing changes: cross-origin is refused, cookie or not.
  assertEquals((await batchApp()(action({ origin: WEB }))).status, 403);
  // Same-origin with cookies still works.
  const own = await app(action({ origin: "http://localhost", cookie: "session=abc" }));
  assertEquals(own.status, 200);
});

// ---- the API batch ------------------------------------------------------------------------------

Deno.test("cors + API batch: cookieless from an allowed origin runs; with a cookie it is refused", async () => {
  const app = batchApp({ cors: CORS });
  const ok = await app(batch({ origin: WEB }));
  assertEquals(ok.status, 200);
  assertEquals(acao(ok), WEB);
  assertEquals((await app(batch({ origin: WEB, cookie: "session=abc" }))).status, 403);
  assertEquals((await app(batch({ origin: EVIL }))).status, 403);
  assertEquals((await batchApp()(batch({ origin: WEB }))).status, 403);
});

// ---- preflights ---------------------------------------------------------------------------------

Deno.test("cors: preflights for an action, the batch and a page are answered under the app policy", async () => {
  const app = batchApp({ cors: CORS });
  for (
    const [path, headers] of [
      [actionEndpoint("cors_app_echo"), "content-type, x-denext-action"],
      [API_BATCH_PATH, "content-type, x-denext-api-batch"],
      ["/", "x-denext-nav, x-denext-flight"],
    ]
  ) {
    const ok = await app(preflight(path, WEB, headers));
    assertEquals(ok.status, 204, path);
    assertEquals(acao(ok), WEB, path);
    const refused = await app(preflight(path, EVIL, headers));
    assertEquals(acao(refused), null, path);
  }
  // Without cors the preflight is not answered as one.
  const none = await batchApp()(preflight(API_BATCH_PATH, WEB));
  assertEquals(acao(none), null);
  assert(none.status !== 204);
});

// ---- pages --------------------------------------------------------------------------------------

/** An app with one renderable page at `/about`. */
function pageApp(extra: Record<string, unknown> = {}) {
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("/about"),
      routePath: "/about",
      filePath: "about.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  return createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: () => "about" }),
    ...extra,
  });
}

Deno.test("cors + pages: an allowed origin's GET carries the CORS headers; another's does not", async () => {
  const app = pageApp({ cors: CORS });
  const ok = await app(
    new Request("http://localhost/about", { headers: { host: "localhost", origin: WEB } }),
  );
  assertEquals(ok.status, 200);
  assertEquals(acao(ok), WEB);
  assert(ok.headers.get("vary")?.includes("Origin"));
  const other = await app(
    new Request("http://localhost/about", { headers: { host: "localhost", origin: EVIL } }),
  );
  assertEquals(acao(other), null);
  assert(other.headers.get("vary")?.includes("Origin"), "Vary: Origin either way");
});

// ---- Live ---------------------------------------------------------------------------------------

Deno.test("cors + Live (prod): a cookieless handshake from a listed origin to the pinned host passes", () => {
  const cors = resolveCors(CORS);
  const pinned = { cors, canonicalOrigin: "https://api.test" };
  const upgrade = (headers: Record<string, string>) =>
    new Request("http://api.test/_denext/live", {
      headers: { host: "api.test", upgrade: "websocket", ...headers },
    });
  assert(liveOriginAllowed(upgrade({ origin: WEB }), pinned));
  assert(!liveOriginAllowed(upgrade({ origin: WEB, cookie: "s=1" }), pinned));
  assert(!liveOriginAllowed(upgrade({ origin: EVIL }), pinned));
  assert(!liveOriginAllowed(upgrade({ origin: WEB }), {}), "no cors → same-origin only");
  assert(liveOriginAllowed(upgrade({ origin: "http://api.test", cookie: "s=1" }), pinned));
});

Deno.test("cors + Live (prod): a rebinding-style handshake (foreign Host) is refused", () => {
  const cors = resolveCors(CORS);
  const rebound = (headers: Record<string, string>) =>
    new Request("http://evil.test/_denext/live", {
      headers: { host: "evil.test", upgrade: "websocket", origin: WEB, ...headers },
    });
  // The Host is not the app's canonical one.
  assert(!liveOriginAllowed(rebound({}), { cors, canonicalOrigin: "https://api.test" }));
  // Without canonicalOrigin no Host can be trusted for a cross-origin socket.
  assert(!liveOriginAllowed(rebound({}), { cors }));
  // X-Forwarded-Host only counts behind a trusted proxy, and must be the canonical host.
  const forwarded = rebound({ "x-forwarded-host": "api.test" });
  assert(!liveOriginAllowed(forwarded, { cors, canonicalOrigin: "https://api.test" }));
  assert(
    liveOriginAllowed(forwarded, {
      cors,
      canonicalOrigin: "https://api.test",
      trustForwardedHeaders: true,
    }),
  );
  const spoofed = new Request("http://api.test/_denext/live", {
    headers: { host: "api.test", origin: WEB, "x-forwarded-host": "evil.test" },
  });
  assert(
    !liveOriginAllowed(spoofed, {
      cors,
      canonicalOrigin: "https://api.test",
      trustForwardedHeaders: true,
    }),
  );
  // A wildcard policy never opens the socket, even to the pinned host.
  const any = resolveCors({ origins: ["*"] });
  const ok = new Request("http://api.test/_denext/live", {
    headers: { host: "api.test", origin: EVIL },
  });
  assert(!liveOriginAllowed(ok, { cors: any, canonicalOrigin: "https://api.test" }));
});

Deno.test("cors + Live (dev): the dev Host allowlist holds whatever cors allows", () => {
  const cors = resolveCors(CORS);
  const at = (host: string, headers: Record<string, string>) => {
    const url = new URL(`http://${host}/_denext/live`);
    return [new Request(url, { headers: { host, ...headers } }), url] as const;
  };
  // A listed origin, cookieless, to the loopback dev server: in.
  const [ok, okUrl] = at("localhost:3000", { origin: WEB, "sec-fetch-site": "cross-site" });
  assert(devLiveOriginAllowed(ok, okUrl, [], cors));
  // DNS rebinding: an attacker hostname resolving to the dev server — refused even with an
  // allowed Origin and no cookie.
  const [rebound, reboundUrl] = at("evil.test:3000", {
    origin: WEB,
    "sec-fetch-site": "cross-site",
  });
  assert(!devLiveOriginAllowed(rebound, reboundUrl, [], cors));
  // A cookie-carrying cross-site handshake stays refused.
  const [cookie, cookieUrl] = at("localhost:3000", {
    origin: WEB,
    cookie: "s=1",
    "sec-fetch-site": "cross-site",
  });
  assert(!devLiveOriginAllowed(cookie, cookieUrl, [], cors));
  // A wildcard policy does not open the dev socket to every page either.
  const [any, anyUrl] = at("localhost:3000", { origin: EVIL, "sec-fetch-site": "cross-site" });
  assert(!devLiveOriginAllowed(any, anyUrl, [], resolveCors({ origins: ["*"] })));
  // An allowedDevOrigins host still works as before.
  const [lan, lanUrl] = at("dev.lan:3000", {
    origin: "http://dev.lan:3000",
    "sec-fetch-site": "same-origin",
  });
  assert(devLiveOriginAllowed(lan, lanUrl, ["dev.lan"], cors));
});

Deno.test("corsCredentialless: exact origin, no cookie, no ambient Authorization", () => {
  const cors = resolveCors(CORS);
  const req = (headers: Record<string, string>) => new Request("http://x/", { headers });
  assert(corsCredentialless(req({ origin: WEB }), cors));
  assert(corsCredentialless(req({ origin: WEB, authorization: "bearer x" }), cors));
  assert(!corsCredentialless(req({ origin: WEB, cookie: "a=1" }), cors));
  assert(!corsCredentialless(req({ origin: WEB, authorization: "Negotiate x" }), cors));
  assert(!corsCredentialless(req({ origin: `${WEB}.evil` }), cors));
  assert(!corsCredentialless(req({}), cors));
  assert(!corsCredentialless(req({ origin: WEB }), null));
});
