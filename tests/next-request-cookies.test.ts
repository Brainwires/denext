// Unit coverage for the next/request + next/cookies compat surface:
// NextRequest (nextUrl/cookies/ip/geo), NextURL.clone(), and the
// RequestCookies / ResponseCookies jars.

import { assert, assertEquals } from "@std/assert";
import { NextRequest, NextURL } from "../src/compat/next/request.ts";
import { RequestCookies, ResponseCookies } from "../src/compat/next/cookies.ts";

Deno.test("NextURL.clone copies href, basePath, and locale independently", () => {
  const url = new NextURL("https://example.com/app/page?q=1");
  url.basePath = "/app";
  url.locale = "fr";
  const copy = url.clone();
  assertEquals(copy.href, url.href);
  assertEquals(copy.basePath, "/app");
  assertEquals(copy.locale, "fr");
  // Independent: mutating the copy doesn't affect the original.
  copy.locale = "de";
  assertEquals(url.locale, "fr");
});

Deno.test("NextRequest exposes nextUrl and parses cookies", () => {
  const req = new NextRequest("https://example.com/x?a=1", {
    headers: { cookie: "sid=abc; theme=dark" },
  });
  assertEquals(req.nextUrl.pathname, "/x");
  assertEquals(req.nextUrl.searchParams.get("a"), "1");
  assertEquals(req.cookies.get("sid")?.value, "abc");
  assertEquals(req.cookies.get("theme")?.value, "dark");
  assert(req.cookies.has("sid"));
  assert(!req.cookies.has("missing"));
});

Deno.test("NextRequest.ip uses x-forwarded-for's LAST hop (proxy-appended), falls back to x-real-ip", () => {
  // The first hop is whatever the client sent; only the last one was appended by our proxy.
  const fwd = new NextRequest("https://x/", {
    headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.1" },
  });
  assertEquals(fwd.ip, "203.0.113.1");

  const real = new NextRequest("https://x/", { headers: { "x-real-ip": "198.51.100.9" } });
  assertEquals(real.ip, "198.51.100.9");

  const none = new NextRequest("https://x/");
  assertEquals(none.ip, undefined);
});

Deno.test("NextRequest.geo reads Vercel/Cloudflare headers", () => {
  const req = new NextRequest("https://x/", {
    headers: {
      "x-vercel-ip-country": "US",
      "x-vercel-ip-city": "Denver",
      "cf-ipcountry": "GB", // vercel wins for country when both present
    },
  });
  assertEquals(req.geo.country, "US");
  assertEquals(req.geo.city, "Denver");

  const cf = new NextRequest("https://x/", { headers: { "cf-ipcountry": "GB" } });
  assertEquals(cf.geo.country, "GB");
});

Deno.test("RequestCookies: get/getAll/has/set/delete/size/iteration", () => {
  const jar = new RequestCookies(new Headers({ cookie: "a=1; b=2" }));
  assertEquals(jar.size, 2);
  assertEquals(jar.get("a")?.value, "1");
  assertEquals(jar.getAll().length, 2);
  assertEquals(jar.getAll("b"), [{ name: "b", value: "2" }]);

  jar.set("c", "3");
  assert(jar.has("c"));
  assertEquals(jar.size, 3);

  assert(jar.delete("a"));
  assert(!jar.delete("a"), "deleting again returns false");
  assertEquals(jar.size, 2);

  const seen = new Map([...jar].map(([name, cookie]) => [name, cookie.value]));
  assertEquals(seen.get("b"), "2");
  assertEquals(seen.get("c"), "3");
});

Deno.test("ResponseCookies: set emits Set-Cookie with attributes; delete expires", () => {
  const headers = new Headers();
  const res = new ResponseCookies(headers);
  res.set("sid", "xyz", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 3600 });

  const staged = res.get("sid");
  assertEquals(staged?.value, "xyz");
  assertEquals(staged?.httpOnly, true);
  assertEquals(staged?.sameSite, "Lax");

  const raw = headers.get("set-cookie") ?? "";
  assert(/sid=xyz/i.test(raw));
  assert(/httponly/i.test(raw));
  assert(/samesite=lax/i.test(raw));

  res.delete("sid");
  // A deletion stages an expiring Set-Cookie for the same name.
  assert(res.getAll().some((c) => c.name === "sid"));
});
