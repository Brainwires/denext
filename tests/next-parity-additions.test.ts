// Behavior tests for the next/* App Router signature-parity additions:
// redirect push/replace, ReadonlyURLSearchParams, defaultHead, getImageProps,
// next/server (URLPattern/userAgentFromString/NextFetchEvent), next/cache (io + unstable
// aliases), next/dynamic noSSR, and the next/script imperative loaders.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { redirect, type RedirectError, RedirectType } from "../src/runtime/error-boundary.ts";
import { ReadonlyURLSearchParams } from "../src/compat/next/navigation.ts";
import { defaultHead } from "../src/compat/next/head.ts";
import { getImageProps } from "../src/runtime/image.ts";
import { NextFetchEvent, URLPattern, userAgentFromString } from "../src/compat/next/server.ts";
import { io, unstable_cacheLife, unstable_noStore } from "../src/compat/next/cache.ts";
import { noSSR } from "../src/compat/next/dynamic.ts";
import { cacheLife } from "../src/server/mod.ts";
import { h } from "../src/jsx/jsx-runtime.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("redirect: 2nd arg is a RedirectType (push/replace) or an HTTP status", () => {
  const soft = assertThrows(() => redirect("/next", RedirectType.replace)) as RedirectError;
  assertEquals(soft.url, "/next");
  assertEquals(soft.status, 307);
  assertEquals(soft.redirectType, RedirectType.replace);
  // denext's numeric-status extension still works.
  const withStatus = assertThrows(() => redirect("/perm", 308)) as RedirectError;
  assertEquals(withStatus.status, 308);
  // Bare redirect defaults to 307, no soft-nav type.
  const bare = assertThrows(() => redirect("/x")) as RedirectError;
  assertEquals(bare.status, 307);
  assertEquals(bare.redirectType, undefined);
});

Deno.test("ReadonlyURLSearchParams: reads work, mutations throw", () => {
  const p = new ReadonlyURLSearchParams("a=1&b=2");
  assertEquals(p.get("a"), "1");
  assertEquals([...p.keys()].sort(), ["a", "b"]);
  assertThrows(() => p.set("a", "9"), Error, "read-only");
  assertThrows(() => p.append("c", "3"), Error, "read-only");
  assertThrows(() => p.delete("a"), Error, "read-only");
  assertThrows(() => p.sort(), Error, "read-only");
});

Deno.test("defaultHead returns charset + viewport (charset only in AMP mode)", () => {
  const normal = defaultHead();
  assertEquals(normal.length, 2);
  assertEquals((normal[0].props as Any).charSet, "utf-8");
  assertEquals((normal[1].props as Any).name, "viewport");
  const amp = defaultHead(true);
  assertEquals(amp.length, 1); // viewport omitted under AMP
});

Deno.test("getImageProps resolves <img> attributes (loader → srcSet)", () => {
  const { props } = getImageProps({
    src: "/hero.jpg",
    alt: "hero",
    width: 800,
    loader: ({ src, width }) => `${src}?w=${width}`,
  });
  // Fixed image → 1×/2× candidates [800, 1600]; `src` is the largest (high-DPI), matching Next.
  assertEquals(props.src, "/hero.jpg?w=1600");
  assert(String(props.srcSet).includes("800w"), "srcSet generated");
  assert(String(props.srcSet).includes("1600w"), "2x candidate present");
  assertEquals(props.loading, "lazy");
  assertEquals(props.decoding, "async");
});

Deno.test("next/server: URLPattern is the platform global; userAgentFromString parses", () => {
  assertEquals(URLPattern, globalThis.URLPattern);
  const ua = userAgentFromString(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  );
  assertEquals(ua.os?.name, "iOS");
  assertEquals(ua.isBot, false);
  // Empty string → empty details, no throw.
  assertEquals(userAgentFromString().ua, "");
});

Deno.test("NextFetchEvent exposes sourcePage + waitUntil", () => {
  const evt = new NextFetchEvent({ request: new Request("https://x.test/"), sourcePage: "/mw" });
  assertEquals(evt.sourcePage, "/mw");
  evt.waitUntil(Promise.resolve(1)); // must not throw
});

Deno.test("next/cache: io + unstable_noStore are callable no-ops; unstable aliases match", () => {
  io();
  unstable_noStore();
  assertEquals(unstable_cacheLife, cacheLife); // alias identity
});

Deno.test("next/dynamic noSSR returns a client-only component", () => {
  const C = noSSR(() => Promise.resolve({ default: () => h("div", null) }));
  assertEquals(typeof C, "function");
});
