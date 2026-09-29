// CORS (src/server/cors.ts) and its two wirings: API routes through createApp (the preflight
// answered before middleware, response decoration, a route's own `export const cors`) and the
// config validator. Hostile origins: suffix/prefix tricks, `null`, case games, a trailing dot.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createApp } from "../src/server/app.ts";
import {
  applyCors,
  corsOriginAllowed,
  normalizeCorsOrigin,
  preflightResponse,
  resolveCors,
} from "../src/server/cors.ts";
import { validateDenextConfig } from "../src/server/config-validate.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { ApiModule } from "../src/server/types.ts";
import type { CorsConfig } from "../src/server/config.ts";

const APP_ORIGINS = ["capacitor://localhost", "https://localhost", "myapp://app"];

/** A resolved policy for the three app origins (throws if resolution fails). */
function policy(extra: Partial<CorsConfig> = {}) {
  const resolved = resolveCors({ origins: APP_ORIGINS, ...extra });
  assert(resolved);
  return resolved;
}

// ---- origin normalization + matching ------------------------------------------------

Deno.test("normalizeCorsOrigin: web origins canonicalize, custom schemes keep their authority", () => {
  assertEquals(normalizeCorsOrigin("https://App.Example.com"), "https://app.example.com");
  assertEquals(normalizeCorsOrigin("https://localhost:443"), "https://localhost");
  assertEquals(normalizeCorsOrigin("https://localhost/"), "https://localhost");
  assertEquals(normalizeCorsOrigin("http://127.0.0.1:5173"), "http://127.0.0.1:5173");
  assertEquals(normalizeCorsOrigin("Capacitor://LOCALHOST"), "capacitor://localhost");
  assertEquals(normalizeCorsOrigin("myapp://app"), "myapp://app");
});

Deno.test("normalizeCorsOrigin refuses null, paths, credentials, queries and non-origins", () => {
  for (
    const bad of [
      "null",
      "NULL",
      "",
      "*.example.com",
      "https://example.com/path",
      "https://user:pw@example.com",
      "https://example.com?x=1",
      "https://example.com#frag",
      "myapp://app/callback",
      "localhost",
      "//example.com",
      42,
    ]
  ) {
    assertThrows(() => normalizeCorsOrigin(bad), Error, undefined, String(bad));
  }
});

Deno.test("corsOriginAllowed is exact: suffix, prefix, case and null tricks are refused", () => {
  const p = policy();
  assert(corsOriginAllowed(p, "capacitor://localhost"));
  assert(corsOriginAllowed(p, "https://localhost"));
  assert(corsOriginAllowed(p, "myapp://app"));
  for (
    const hostile of [
      "capacitor://localhost.evil",
      "capacitor://localhost.evil.com",
      "capacitor://evil-localhost",
      "capacitor://localhost:8080",
      "Capacitor://localhost",
      "capacitor://LOCALHOST",
      "https://localhost.",
      "https://localhost:444",
      "http://localhost",
      "https://evil.com/https://localhost",
      "myapp://app.evil",
      "myapp://ap",
      " capacitor://localhost",
      "capacitor://localhost ",
      "null",
      "",
      null,
    ]
  ) {
    assertEquals(corsOriginAllowed(p, hostile), false, String(hostile));
  }
});

// ---- resolveCors ----------------------------------------------------------------------

Deno.test("resolveCors: never '*' with credentials, '*' only on its own, maxAge in range", () => {
  assertEquals(resolveCors(undefined), null);
  assertThrows(() => resolveCors({ origins: ["*"], credentials: true }), Error, "credentials");
  assertThrows(() => resolveCors({ origins: ["*", "https://a.test"] }), Error, "on its own");
  assertThrows(() => resolveCors({ origins: ["null"] }), Error, "null");
  assertThrows(() => resolveCors({ origins: APP_ORIGINS, maxAge: -1 }), Error, "maxAge");
  assertThrows(() => resolveCors({ origins: APP_ORIGINS, maxAge: 1e9 }), Error, "maxAge");
  assertThrows(() => resolveCors({ origins: APP_ORIGINS, methods: [""] }), Error, "methods");
  assertThrows(() => resolveCors({} as CorsConfig), Error, "origins");
  const any = resolveCors({ origins: ["*"] });
  assert(any?.any);
  assert(corsOriginAllowed(any, "https://whatever.test"));
  assertEquals(corsOriginAllowed(any, "null"), false, "even '*' never allows the null origin");
});

Deno.test("validateDenextConfig reports a bad cors policy against the cors field", () => {
  assertThrows(
    () => validateDenextConfig({ cors: { origins: ["*"], credentials: true } }),
    Error,
    "cors",
  );
  validateDenextConfig({ cors: { origins: APP_ORIGINS, credentials: true } }); // fine
});

// ---- preflight + decoration -----------------------------------------------------------

function preflight(origin: string | null, method = "POST", headers?: string): Request {
  const h = new Headers({ "access-control-request-method": method });
  if (origin !== null) h.set("origin", origin);
  if (headers) h.set("access-control-request-headers", headers);
  return new Request("https://api.test/api/thing", { method: "OPTIONS", headers: h });
}

Deno.test("preflightResponse approves an allowed origin/method/header set, echoing the origin", () => {
  const res = preflightResponse(
    preflight("capacitor://localhost", "PATCH", "Authorization, Content-Type"),
    policy({ credentials: true, maxAge: 120 }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assertEquals(res.headers.get("access-control-allow-credentials"), "true");
  assertEquals(res.headers.get("access-control-max-age"), "120");
  assert(res.headers.get("access-control-allow-methods")!.includes("PATCH"));
  assert(res.headers.get("access-control-allow-headers")!.includes("authorization"));
  assert(res.headers.get("vary")!.includes("Origin"));
});

Deno.test("preflightResponse grants nothing to a hostile origin, method or header", () => {
  const p = policy();
  for (
    const req of [
      preflight("capacitor://localhost.evil"),
      preflight("null"),
      preflight("capacitor://localhost", "TRACE"),
      preflight("capacitor://localhost", "POST", "authorization, x-evil"),
    ]
  ) {
    const res = preflightResponse(req, p);
    assertEquals(res.status, 204);
    assertEquals(res.headers.get("access-control-allow-origin"), null);
    assertEquals(res.headers.get("access-control-allow-methods"), null);
    assert(res.headers.get("vary")!.includes("Origin"), "a refusal still varies on Origin");
  }
});

Deno.test("applyCors: allowed origin echoed (never '*' with credentials), Vary always", () => {
  const p = policy({ credentials: true, exposeHeaders: ["X-Request-Id"] });
  const ok = applyCors(
    new Request("https://api.test/x", { headers: { origin: "https://localhost" } }),
    Response.json({}),
    p,
  );
  assertEquals(ok.headers.get("access-control-allow-origin"), "https://localhost");
  assertEquals(ok.headers.get("access-control-allow-credentials"), "true");
  assertEquals(ok.headers.get("access-control-expose-headers"), "x-request-id");
  assertEquals(ok.headers.get("vary"), "Origin");
  const hostile = applyCors(
    new Request("https://api.test/x", { headers: { origin: "https://localhost.evil" } }),
    new Response("x", { headers: { vary: "Accept-Encoding" } }),
    p,
  );
  assertEquals(hostile.headers.get("access-control-allow-origin"), null);
  assertEquals(hostile.headers.get("access-control-allow-credentials"), null);
  assertEquals(hostile.headers.get("vary"), "Accept-Encoding, Origin");
  // An immutable response (Response.redirect) is copied, not thrown on.
  const redirected = applyCors(
    new Request("https://api.test/x", { headers: { origin: "myapp://app" } }),
    Response.redirect("https://api.test/y", 302),
    p,
  );
  assertEquals(redirected.status, 302);
  assertEquals(redirected.headers.get("access-control-allow-origin"), "myapp://app");
});

Deno.test("applyCors with no policy leaves the response untouched", () => {
  const res = new Response("x");
  assertEquals(
    applyCors(new Request("https://a.test", { headers: { origin: "https://b.test" } }), res, null),
    res,
  );
});

// ---- through createApp ------------------------------------------------------------------

const MANIFEST: RouteManifest = {
  pages: [],
  api: [{
    kind: "api",
    pattern: parsePattern("/api/thing"),
    routePath: "/api/thing",
    filePath: "thing.ts",
  }],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
};

/** An app with one API route, the given cors config, and an auth-guard middleware. */
function app(mod: ApiModule, cors?: CorsConfig) {
  return createApp({
    getManifest: () => MANIFEST,
    load: (fp: string) => Promise.resolve(fp === "thing.ts" ? mod : undefined),
    cors,
    // Refuses every request that carries no Authorization — the guard a preflight must skip.
    getMiddleware: () => (request: Request) =>
      Promise.resolve(
        request.headers.has("authorization")
          ? { type: "next" } as never
          : { type: "response", response: new Response("unauthorized", { status: 401 }) },
      ),
  });
}

Deno.test("createApp answers an API preflight before middleware, under the app cors policy", async () => {
  const handler = app({ POST: () => Response.json({ ok: true }) }, { origins: APP_ORIGINS });
  const res = await handler(preflight("capacitor://localhost", "POST", "authorization"));
  assertEquals(res.status, 204, "the auth middleware did not see the preflight");
  assertEquals(res.headers.get("access-control-allow-origin"), "capacitor://localhost");
  const refused = await handler(preflight("capacitor://localhost.evil"));
  assertEquals(refused.headers.get("access-control-allow-origin"), null);
});

Deno.test("createApp decorates the actual API response for an allowed origin only", async () => {
  const handler = app({ POST: () => Response.json({ ok: true }) }, { origins: APP_ORIGINS });
  const ok = await handler(
    new Request("https://api.test/api/thing", {
      method: "POST",
      headers: { origin: "capacitor://localhost", authorization: "Bearer x" },
    }),
  );
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assert(ok.headers.get("vary")?.includes("Origin"));
  const evil = await handler(
    new Request("https://api.test/api/thing", {
      method: "POST",
      headers: { origin: "capacitor://localhost.evil", authorization: "Bearer x" },
    }),
  );
  assertEquals(evil.headers.get("access-control-allow-origin"), null);
  await ok.body?.cancel();
  await evil.body?.cancel();
});

Deno.test("createApp without cors adds no CORS headers and leaves OPTIONS to the route", async () => {
  const handler = app({ OPTIONS: () => new Response("own", { status: 200 }) });
  const res = await handler(
    new Request("https://api.test/api/thing", {
      method: "OPTIONS",
      headers: {
        origin: "capacitor://localhost",
        "access-control-request-method": "POST",
        authorization: "Bearer x",
      },
    }),
  );
  assertEquals(await res.text(), "own");
  assertEquals(res.headers.get("access-control-allow-origin"), null);
});

Deno.test("a route's `export const cors` overrides the app policy (false → none, object → replace)", async () => {
  const off = app({ POST: () => Response.json({}), cors: false } as ApiModule, {
    origins: APP_ORIGINS,
  });
  const offRes = await off(
    new Request("https://api.test/api/thing", {
      method: "POST",
      headers: { origin: "capacitor://localhost", authorization: "Bearer x" },
    }),
  );
  assertEquals(offRes.headers.get("access-control-allow-origin"), null);
  await offRes.body?.cancel();

  const only = app(
    { POST: () => Response.json({}), cors: { origins: ["https://web.test"] } } as ApiModule,
    { origins: APP_ORIGINS },
  );
  const fromApp = await only(preflight("capacitor://localhost"));
  assertEquals(fromApp.headers.get("access-control-allow-origin"), null, "app origins replaced");
  const fromWeb = await only(preflight("https://web.test"));
  assertEquals(fromWeb.headers.get("access-control-allow-origin"), "https://web.test");

  // A route may opt IN when the app has no policy.
  const optIn = app(
    { GET: () => Response.json({}), cors: { origins: ["myapp://app"] } } as ApiModule,
  );
  const res = await optIn(
    new Request("https://api.test/api/thing", {
      headers: { origin: "myapp://app", authorization: "Bearer x" },
    }),
  );
  assertEquals(res.headers.get("access-control-allow-origin"), "myapp://app");
  await res.body?.cancel();
});

Deno.test("createApp refuses a bad cors config at boot", () => {
  assertThrows(
    () =>
      createApp({
        getManifest: () => MANIFEST,
        load: () => Promise.resolve({}),
        cors: { origins: ["*"], credentials: true },
      }),
    Error,
    "credentials",
  );
});
