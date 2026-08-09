// Full NextRequest / NextResponse: nextUrl, cookies, geo/ip, and NextResponse's
// interop with the denext middleware runner (x-middleware-* protocol + cookies).

import { assert, assertEquals } from "@std/assert";
import { NextRequest, NextResponse } from "../src/compat/next/server.ts";
import { composeMiddleware, type Middleware } from "../src/server/mod.ts";

Deno.test("NextRequest: nextUrl, cookies, ip, geo", () => {
  const req = new NextRequest("https://ex.test/dash?tab=1", {
    headers: {
      cookie: "session=abc; theme=dark",
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      "x-vercel-ip-country": "US",
    },
  });
  assertEquals(req.nextUrl.pathname, "/dash");
  assertEquals(req.nextUrl.searchParams.get("tab"), "1");
  assertEquals(req.cookies.get("session")?.value, "abc");
  assert(req.cookies.has("theme"));
  assertEquals(req.cookies.get("missing"), undefined);
  assertEquals(req.ip, "203.0.113.7");
  assertEquals(req.geo.country, "US");
});

Deno.test("NextURL.clone() is independent", () => {
  const req = new NextRequest("https://ex.test/a?x=1");
  const c = req.nextUrl.clone();
  c.pathname = "/b";
  assertEquals(req.nextUrl.pathname, "/a", "original unchanged");
  assertEquals(c.pathname, "/b");
});

Deno.test("NextResponse.json / redirect statics", () => {
  const json = NextResponse.json({ ok: true });
  assert((json.headers.get("content-type") ?? "").includes("application/json"));
  const red = NextResponse.redirect("https://ex.test/login", 302);
  assertEquals(red.status, 302);
  assertEquals(red.headers.get("location"), "https://ex.test/login");
});

Deno.test("NextResponse.cookies.set stages a Set-Cookie", () => {
  const res = NextResponse.next();
  res.cookies.set("seen", "1", { httpOnly: true, path: "/" });
  const setCookie = res.headers.getSetCookie();
  assert(setCookie.some((c) => c.startsWith("seen=1")), setCookie.join("|"));
  assertEquals(res.cookies.get("seen")?.value, "1");
});

Deno.test("runner: NextResponse.next() continues routing and forwards cookies", async () => {
  const mw: Middleware = () => {
    const res = NextResponse.next();
    res.cookies.set("seen", "1");
    return res;
  };
  const run = composeMiddleware([{ handler: mw }])!;
  const outcome = await run(new Request("https://ex.test/"));
  assertEquals(outcome.type, "next");
  assert(outcome.type === "next" && outcome.headers, "headers forwarded");
  const cookies = outcome.type === "next" ? outcome.headers!.getSetCookie() : [];
  assert(cookies.some((c) => c.startsWith("seen=1")), cookies.join("|"));
});

Deno.test("runner: NextResponse.rewrite() routes internally", async () => {
  const mw: Middleware = (req) => NextResponse.rewrite(new URL("/dest", req.url));
  const run = composeMiddleware([{ handler: mw }])!;
  const outcome = await run(new Request("https://ex.test/from"));
  assertEquals(outcome.type, "rewrite");
  assert(outcome.type === "rewrite" && outcome.url.endsWith("/dest"), outcome.type);
});

Deno.test("runner: NextResponse with a body still short-circuits as a response", async () => {
  const mw: Middleware = () => NextResponse.json({ blocked: true }, { status: 403 });
  const run = composeMiddleware([{ handler: mw }])!;
  const outcome = await run(new Request("https://ex.test/"));
  assertEquals(outcome.type, "response");
  if (outcome.type === "response") assertEquals(outcome.response.status, 403);
});

Deno.test("runner: middleware receives a NextRequest (nextUrl present)", async () => {
  let sawNextUrl = false;
  const mw: Middleware = (req) => {
    sawNextUrl = (req as NextRequest).nextUrl?.pathname === "/x";
    return NextResponse.next();
  };
  const run = composeMiddleware([{ handler: mw }])!;
  await run(new Request("https://ex.test/x"));
  assert(sawNextUrl, "handler should get a NextRequest with nextUrl");
});
