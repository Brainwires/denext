// `trackInheritedReads`: which reads of a self-call's request count as reading the visitor's
// request (and so make the caller's render per-visitor), which don't, and what a read does
// during a prerender (postpones, remembering the API on the context).

import { assert, assertEquals, assertThrows } from "@std/assert";
import { trackInheritedReads } from "../src/server/inherited-read-tracking.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { withPrerender } from "../src/runtime/prerender.ts";
import { isPostpone } from "../src/runtime/postpone.ts";

const INHERITED = new Set(["cookie", "authorization"]);

/** A tracked request and the context its reads mark. */
function setup(headers: Record<string, string>) {
  const request = trackInheritedReads(
    new Request("http://localhost/api/me", { headers }),
    INHERITED,
  );
  const ctx = createRequestContext(request);
  return { request, ctx, read: <T>(fn: () => T): T => runWithContext(ctx, fn) };
}

Deno.test("trackInheritedReads: a named read of an inherited header marks the render dynamic", () => {
  for (
    const read of [
      (r: Request) => r.headers.get("cookie"),
      (r: Request) => r.headers.get("Authorization"),
      (r: Request) => r.headers.has("cookie"),
      (r: Request) => r.headers.getSetCookie(),
    ]
  ) {
    const t = setup({ cookie: "u=a", authorization: "Bearer a" });
    t.read(() => read(t.request));
    // `getSetCookie()` takes no name: it reveals nothing inherited.
    assertEquals(
      t.ctx.usedDynamicApi === true,
      read.toString().includes("get(") ||
        read.toString().includes("has("),
      read.toString(),
    );
  }
});

Deno.test("trackInheritedReads: enumerating counts only when an inherited header is present", () => {
  const enumerations = [
    (r: Request) => [...r.headers],
    (r: Request) => [...r.headers.entries()],
    (r: Request) => [...r.headers.keys()],
    (r: Request) => [...r.headers.values()],
    (r: Request) => r.headers.forEach(() => {}),
  ];
  for (const read of enumerations) {
    const withCookie = setup({ cookie: "u=a", accept: "x" });
    withCookie.read(() => read(withCookie.request));
    assertEquals(withCookie.ctx.usedDynamicApi, true, read.toString());
    const without = setup({ accept: "x" });
    without.read(() => read(without.request));
    assertEquals(without.ctx.usedDynamicApi, undefined, read.toString());
  }
});

Deno.test("trackInheritedReads: a header the self-call did not inherit is not a visitor read", () => {
  const t = setup({ cookie: "u=a", accept: "application/json", "x-request-id": "r1" });
  t.read(() => {
    assertEquals(t.request.headers.get("accept"), "application/json");
    assert(t.request.headers.has("x-request-id"));
    assertEquals(typeof t.request.headers.append, "function"); // non-read methods pass through
  });
  assertEquals(t.ctx.usedDynamicApi, undefined);
  // Outside any request context a read is simply a read.
  assertEquals(t.request.headers.get("cookie"), "u=a");
});

Deno.test("trackInheritedReads: a NextRequest-style cookie jar is tracked too", () => {
  const request = new Request("http://localhost/api/me", { headers: { cookie: "u=a" } });
  const jar = { size: 1, get: (name: string) => (name === "u" ? { value: "a" } : undefined) };
  Object.defineProperty(request, "cookies", { value: jar, configurable: true });
  trackInheritedReads(request, INHERITED);
  const tracked = (request as unknown as { cookies: typeof jar }).cookies;
  for (const read of [(): unknown => tracked.get("u"), (): unknown => tracked.size]) {
    const ctx = createRequestContext(request);
    runWithContext(ctx, read);
    assertEquals(ctx.usedDynamicApi, true);
  }
  assertEquals(tracked.get("u")?.value, "a");
});

Deno.test("trackInheritedReads: during a prerender a read postpones and names the API", () => {
  const t = setup({ cookie: "u=a" });
  const err = assertThrows(() =>
    t.read(() => withPrerender(() => t.request.headers.get("cookie")))
  );
  assert(isPostpone(err));
  assertEquals(t.ctx.postponedBy, "headers");
  assertEquals(t.ctx.usedDynamicApi, undefined, "a postpone is not a dynamic render");
});
