// Regression guards for the pre-2.0.0 whole-app audit (server side): Live socket hygiene,
// auth hardening, per-request render scope, cache-control tiers, request rebuilds, the
// pages-router API surface, metadata title templates, and the Next-15 awaitable request APIs.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  cookies,
  createRequestContext,
  draftMode,
  headers,
  runWithContext,
} from "../src/server/request-context.ts";
import { handleLiveUpgrade, installLiveHub, uninstallLiveHub } from "../src/server/live.ts";
import { credentials, google, oidc } from "../src/server/auth/providers.ts";
import { handleAuthRequest } from "../src/server/auth/routes.ts";
import { createRateLimiter, IP_BUCKET_FACTOR } from "../src/server/auth/rate-limit.ts";
import type { AuthConfig } from "../src/server/auth/types.ts";
import { hmacSign, hmacVerify } from "../src/server/session.ts";
import {
  beginSignalCollection,
  endSignalCollection,
  recordSignal,
} from "../src/runtime/signal-state.ts";
import { composeMiddleware } from "../src/server/middleware.ts";
import { NextResponse } from "../src/compat/next/server.ts";
import { NextRequest } from "../src/compat/next/request.ts";
import { ResponseCookies } from "../src/compat/next/cookies.ts";
import { serveImmutableAsset } from "../src/server/serve-utils.ts";
import { bufferedRequest, cappedBody } from "../src/server/body.ts";
import { remoteAddrOf, setRemoteAddr } from "../src/server/remote-addr.ts";
import { type ApiModule, runApiRoute } from "../packages/pages-router/src/api.ts";
import { mergeMetadata } from "../src/server/render-page.ts";
import { handleApi } from "../src/server/api.ts";
import type { ApiMatch } from "../src/router/match.ts";
import { usePathname, useSearchParams } from "../src/client/navigation.ts";
import { unstable_rethrow } from "../src/runtime/error-boundary.ts";
import { redirect } from "../src/runtime/error-boundary.ts";
import { prerender } from "../src/compat/react-dom-server.ts";
import { createFormatter } from "../src/compat/next-intl/index.ts";

const ORIGIN = "https://app.test";
const SECRET = "test-secret-value-at-least-32-chars-long";

// ---- Live socket hygiene -----------------------------------------------------------------

Deno.test("live: a null / non-object frame is ignored and a flood is throttled — the socket survives both", async () => {
  installLiveHub({
    appHandler: () => Promise.resolve(new Response("nope", { status: 404 })),
    originAllowed: () => true,
  });
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/_denext/live") return handleLiveUpgrade(req);
    return new Response("not found", { status: 404 });
  });
  const { port } = server.addr as Deno.NetAddr;
  try {
    const errors: string[] = [];
    let closed = false;
    const ws = new WebSocket(`ws://localhost:${port}/_denext/live`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no throttle error received")), 4000);
      ws.onopen = () => {
        // Frames that parse but are not messages: must not throw inside the handler.
        ws.send("null");
        ws.send("[]");
        ws.send('"str"');
        ws.send("{}");
        // A flood past the per-second budget draws a `limit` error, not a crash/close.
        for (let i = 0; i < 150; i++) ws.send(JSON.stringify({ type: "pong" }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "error") errors.push(msg.reason);
        if (errors.includes("too many messages")) {
          clearTimeout(timer);
          resolve();
        }
      };
      ws.onclose = () => {
        closed = true;
      };
      ws.onerror = () => reject(new Error("socket error"));
    });
    assert(errors.includes("too many messages"), "the flood was throttled");
    assert(!closed, "the connection stays open — the server neither crashed nor dropped it");
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    uninstallLiveHub();
    await server.shutdown();
  }
});

// ---- Auth ----------------------------------------------------------------------------------

Deno.test("providers: email_verified as the STRING 'false' is unverified (not `=== false` only)", () => {
  const g = google({ clientId: "id", clientSecret: "s" });
  const stringFalse = g.profile({
    tokens: {},
    claims: { sub: "g3", email: "victim@x.test", email_verified: "false" },
  });
  assertEquals(stringFalse.email, undefined);
  assertEquals(stringFalse.emailVerified, false);
  const stringTrue = g.profile({
    tokens: {},
    claims: { sub: "g4", email: "ok@x.test", email_verified: "true" },
  });
  assertEquals(stringTrue.email, "ok@x.test");
  assertEquals(stringTrue.emailVerified, true);
  const o = oidc({
    id: "x",
    issuer: "https://idp.test",
    authorizationUrl: "https://idp.test/auth",
    tokenUrl: "https://idp.test/token",
    jwksUrl: "https://idp.test/jwks",
    clientId: "c",
    clientSecret: "s",
  });
  const viaUserinfo = o.profile({
    tokens: {},
    userinfo: { sub: "u1", email: "u@x.test", email_verified: "false" },
  });
  assertEquals(viaUserinfo.email, undefined);
});

function credsConfig(seen: Record<string, string>[]): AuthConfig {
  return {
    secret: SECRET,
    canonicalOrigin: ORIGIN,
    providers: [
      credentials({
        authorize: (c) => {
          seen.push(c);
          return c.email === "a@b.co" && c.password === "pw" ? { id: "1", email: c.email } : null;
        },
      }),
    ],
    rateLimit: { max: 2, windowMs: 60_000 },
  };
}

function loginRaw(config: AuthConfig, body: BodyInit, contentType: string, ip: string) {
  const request = new Request(`${ORIGIN}/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      accept: "application/json",
      origin: ORIGIN,
      "x-forwarded-for": ip,
    },
    body,
  });
  return runWithContext(
    createRequestContext(request),
    () => handleAuthRequest(request, config),
  ) as Promise<Response>;
}

Deno.test("credentials: only STRING values reach authorize; an oversized body is refused, never buffered", async () => {
  const seen: Record<string, string>[] = [];
  const config = credsConfig(seen);
  const res = await loginRaw(
    config,
    JSON.stringify({ email: "a@b.co", password: "pw", role: { admin: true }, tags: ["x"] }),
    "application/json",
    "10.0.0.1",
  );
  assertEquals(res.status, 200, "valid credentials still sign in");
  assertEquals(seen[0], { email: "a@b.co", password: "pw" }, "nested JSON values are dropped");
  // 1 MiB of JSON: over the 64 KiB credentials cap → parsed as no credentials → 401 (not 500).
  const huge = JSON.stringify({ email: "a@b.co", password: "pw", pad: "x".repeat(1024 * 1024) });
  const big = await loginRaw(config, huge, "application/json", "10.0.0.2");
  assertEquals(big.status, 401);
  assertEquals(seen.length, 2, "authorize ran once more (with empty creds), the body was not kept");
});

Deno.test("rate limit: an IP-wide bucket catches an attacker who varies the identifier per attempt", async () => {
  const seen: Record<string, string>[] = [];
  const config = credsConfig(seen); // max 2 per key
  // 2 * IP_BUCKET_FACTOR distinct identifiers from ONE IP: each per-identifier bucket stays
  // under its max, but the IP bucket fills and the next attempt is a 429.
  let status = 0;
  for (let i = 0; i < 2 * IP_BUCKET_FACTOR + 1; i++) {
    const res = await loginRaw(
      config,
      JSON.stringify({ email: `u${i}@x.test`, password: "no" }),
      "application/json",
      "198.51.100.7",
    );
    status = res.status;
    await res.body?.cancel();
  }
  assertEquals(status, 429, "the IP-wide bucket locked the client out");
  // The limiter's `maxFactor` is the mechanism: a looser threshold for the IP key.
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  await limiter.fail("ip|k");
  assert(await limiter.lockedOut("ip|k") !== null, "at max for factor 1");
  assertEquals(await limiter.lockedOut("ip|k", 10), null, "under max*10 for the IP factor");
});

// ---- Session MAC domain separation ---------------------------------------------------------

Deno.test("session: HMAC tokens are domain-separated — one secret, two token spaces", async () => {
  const sig = await hmacSign("payload", SECRET);
  assert(await hmacVerify("payload", sig, [SECRET]), "verifies in its own domain");
  assert(
    !(await hmacVerify("payload", sig, [SECRET], "denext.remix-session.v1")),
    "a denext session token can't be replayed as a Remix cookie session",
  );
  const remix = await hmacSign("payload", SECRET, "denext.remix-session.v1");
  assert(!(await hmacVerify("payload", remix, [SECRET])), "and vice versa");
});

// ---- Per-request render scope --------------------------------------------------------------

Deno.test("signal collection is per request: interleaved renders never see each other's values", () => {
  const a = createRequestContext(new Request("http://x/a"));
  const b = createRequestContext(new Request("http://x/b"));
  runWithContext(a, () => beginSignalCollection());
  runWithContext(b, () => beginSignalCollection());
  runWithContext(a, () => recordSignal("count", 1));
  runWithContext(b, () => recordSignal("count", 2));
  assertEquals(runWithContext(a, () => endSignalCollection()), { count: 1 });
  assertEquals(runWithContext(b, () => endSignalCollection()), { count: 2 });
  // Outside a request the process-wide fallback still works (tests, denext/testing).
  beginSignalCollection();
  recordSignal("x", 3);
  assertEquals(endSignalCollection(), { x: 3 });
});

// ---- Request rebuilds keep the socket peer -------------------------------------------------

Deno.test("bufferedRequest / cappedBody carry the remembered remote address", async () => {
  const req = new Request("http://x/", { method: "POST", body: "hello" });
  setRemoteAddr(req, { hostname: "203.0.113.5", port: 1, transport: "tcp" });
  const buffered = bufferedRequest(req, new TextEncoder().encode("hello"));
  assertEquals(remoteAddrOf(buffered), "203.0.113.5");
  const streamed = new Request("http://x/", { method: "POST", body: "hello" });
  setRemoteAddr(streamed, { hostname: "203.0.113.6", port: 1, transport: "tcp" });
  const capped = cappedBody(streamed, 1024);
  assertEquals(remoteAddrOf(capped), "203.0.113.6");
  await capped.text();
});

// ---- Cache-control tiers for build assets --------------------------------------------------

Deno.test("serveImmutableAsset: only content-hashed names are immutable; route entries revalidate", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_assets_" });
  try {
    await Deno.writeTextFile(join(dir, "app_home.js"), "// entry");
    await Deno.writeTextFile(join(dir, "chunk-ab12cd34.js"), "// chunk");
    await Deno.writeTextFile(join(dir, "inter-0123456789ab.woff2"), "font");
    const get = (rel: string) =>
      serveImmutableAsset(dir, rel, new Request("http://x" + rel), false, undefined);
    const entry = await get("/app_home.js");
    assertEquals(entry.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    await entry.body?.cancel();
    const chunk = await get("/chunk-ab12cd34.js");
    assertStringIncludes(chunk.headers.get("cache-control") ?? "", "immutable");
    await chunk.body?.cancel();
    const font = await get("/inter-0123456789ab.woff2");
    assertStringIncludes(font.headers.get("cache-control") ?? "", "immutable");
    await font.body?.cancel();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- pages-router API: Set-Cookie arrays -------------------------------------------------

Deno.test("pages-router runApiRoute: setHeader with an array emits one header per element", async () => {
  const mod: ApiModule = {
    default: (_req, res) => {
      res.setHeader("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.status(200).json({ ok: true });
    },
  };
  const request = new Request("http://x/api/cookies");
  const res = await runApiRoute(mod, request, {}, new URL(request.url));
  assertEquals(res.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  await res.body?.cancel();
});

// ---- Metadata: ancestor template applies to `title.default` --------------------------------

Deno.test("metadata: an ancestor title.template applies to a child's title.default (absolute opts out)", () => {
  const withDefault = mergeMetadata([
    { title: { template: "%s | Site" } },
    { title: { default: "Blog" } },
  ]);
  assertEquals(withDefault.title, "Blog | Site");
  const absolute = mergeMetadata([
    { title: { template: "%s | Site" } },
    { title: { absolute: "Standalone" } },
  ]);
  assertEquals(absolute.title, "Standalone");
  // A title containing replacement patterns is inserted literally.
  const literal = mergeMetadata([{ title: { template: "%s | Site" } }, { title: "Cost: $&" }]);
  assertEquals(literal.title, "Cost: $& | Site");
});

// ---- Next 15 awaitable request APIs ----------------------------------------------------------

Deno.test("cookies()/headers()/draftMode() are usable synchronously AND awaitable; set() takes an object and chains", async () => {
  const request = new Request("http://x/p", { headers: { cookie: "sid=1", "x-a": "b" } });
  const ctx = createRequestContext(request);
  await runWithContext(ctx, async () => {
    const sync = cookies();
    assertEquals(sync.get("sid")?.value, "1");
    const awaited = await cookies();
    assertEquals(awaited.get("sid")?.value, "1", "the awaited view reads the same jar");
    awaited.set({ name: "theme", value: "dark", path: "/" }).set("lang", "fr");
    assertEquals(cookies().get("theme")?.value, "dark", "object-form set is read-your-writes");
    assertEquals(cookies().get("lang")?.value, "fr", "set() chains");
    awaited.delete({ name: "lang" });
    assertEquals(cookies().has("lang"), false);
    assertEquals((await headers()).get("x-a"), "b");
    assertEquals(headers().get("x-a"), "b");
    assertEquals((await draftMode()).isEnabled, false);
    assertEquals(draftMode().isEnabled, false);
  });
  assertEquals(ctx.outgoingHeaders.getSetCookie().length, 3, "two sets + one delete queued");
});

// ---- NextResponse.rewrite request headers; route handlers receive a NextRequest --------------

Deno.test("NextResponse.rewrite({ request: { headers } }) overrides the forwarded request headers", async () => {
  const run = composeMiddleware([{
    handler: () =>
      NextResponse.rewrite("http://localhost/dest", {
        request: { headers: new Headers({ "x-user": "carol" }) },
      }),
  }])!;
  const outcome = await run(new Request("http://localhost/from"));
  assertEquals(outcome.type, "rewrite");
  if (outcome.type === "rewrite") assertEquals(outcome.requestHeaders?.get("x-user"), "carol");
});

Deno.test("route handlers receive a NextRequest once next/server is loaded (nextUrl, cookies)", async () => {
  let seen: unknown;
  const mod = {
    GET: (req: Request) => {
      seen = req;
      return new Response("ok");
    },
  };
  const match: ApiMatch = {
    route: { filePath: "r.ts" } as unknown as ApiMatch["route"],
    params: {},
  };
  const request = new Request("http://x/api/r?q=1", { headers: { cookie: "s=1" } });
  const res = await runWithContext(
    createRequestContext(request),
    () => handleApi(match, request, () => Promise.resolve(mod)),
  );
  await res.body?.cancel();
  assert(seen instanceof NextRequest, "the handler got a NextRequest");
  assertEquals((seen as NextRequest).nextUrl.searchParams.get("q"), "1");
  assertEquals((seen as NextRequest).cookies.get("s")?.value, "1");
});

Deno.test("NextRequest.nextUrl reflects the resolved basePath and locale inside the pipeline", () => {
  const request = new Request("http://x/app/fr/about");
  const ctx = createRequestContext(request);
  ctx.routing = { basePath: "/app", locale: "fr" };
  runWithContext(ctx, () => {
    const r = new NextRequest(request);
    assertEquals(r.nextUrl.basePath, "/app");
    assertEquals(r.nextUrl.locale, "fr");
  });
  assertEquals(new NextRequest(request).nextUrl.basePath, "", "outside the pipeline: unset");
});

// ---- SSR navigation hooks are seeded from the request ---------------------------------------

Deno.test("usePathname()/useSearchParams() during SSR reflect the request being rendered", async () => {
  const Where = () => h("p", null, `${usePathname()}?${useSearchParams().get("q")}`);
  const request = new Request("http://x/blog/hello?q=1");
  const html = await runWithContext(
    createRequestContext(request),
    () => renderToString(h(Where, null)),
  );
  assertStringIncludes(html, "<p>/blog/hello?1</p>");
});

// ---- unstable_rethrow, ResponseCookies, prerender, next-intl named formats -------------------

Deno.test("unstable_rethrow: rethrows a control signal wrapped in an Error's cause chain; no-op otherwise", () => {
  let signal: unknown;
  try {
    redirect("/x");
  } catch (e) {
    signal = e;
  }
  const wrapped = new Error("outer", { cause: new Error("mid", { cause: signal }) });
  assertThrows(() => unstable_rethrow(wrapped));
  unstable_rethrow(new Error("plain")); // does not throw
  unstable_rethrow(undefined);
});

Deno.test("ResponseCookies: has(), toString(), delete(object | array)", () => {
  const headers = new Headers();
  const jar = new ResponseCookies(headers);
  jar.set("a", "1").set({ name: "b", value: "2", path: "/x" });
  assert(jar.has("a") && jar.has("b") && !jar.has("zzz"));
  assertEquals(jar.toString(), "a=1; b=2");
  jar.delete({ name: "b", path: "/x" });
  jar.delete(["a"]);
  const cleared = headers.getSetCookie().filter((c) => /Max-Age=0|Expires=/i.test(c));
  assertEquals(cleared.length, 2, "both deletions staged an expiry");
});

Deno.test("react-dom/static prerender: resolves with the complete document and a null postponed state", async () => {
  const { prelude, postponed } = await prerender(h("p", null, "static"));
  assertEquals(postponed, null);
  assertStringIncludes(await new Response(prelude).text(), "<p>static</p>");
});

Deno.test("next-intl: useFormatter/createFormatter resolve named formats; an unknown name throws", () => {
  const f = createFormatter({
    locale: "en-US",
    formats: { dateTime: { year: { year: "numeric" } }, number: { pct: { style: "percent" } } },
  });
  assertEquals(f.dateTime(new Date(Date.UTC(2026, 0, 1, 12)), "year"), "2026");
  assertEquals(f.number(0.5, "pct"), "50%");
  assertThrows(() => f.dateTime(new Date(), "nope"), Error, "formats.dateTime.nope");
});

// ---- a shell render error rejects renderToReadableStream (see react-compat-interop too) ------

Deno.test("prerender rejects when the shell throws (a static build can fail loudly)", async () => {
  const Boom = () => {
    throw new Error("prerender boom");
  };
  await assertRejects(() => prerender(h(Boom, null)), Error, "prerender boom");
});
