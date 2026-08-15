// Part C1: PPR postpone primitives — a dynamic read postpones during a prerender
// pass, but not inside a `use cache` scope and not during a normal render.

import { assert, assertEquals } from "@std/assert";
import {
  isPostpone,
  isPrerendering,
  type Postpone,
  shouldPostpone,
  withoutPostpone,
  withPrerender,
} from "../src/runtime/prerender.ts";
import {
  connection,
  cookies,
  createRequestContext,
  headers,
  runWithContext,
} from "../src/server/request-context.ts";
import { withCacheScope } from "../src/server/cache.ts";

const ctx = () => createRequestContext(new Request("http://x/", { headers: { cookie: "a=1" } }));

Deno.test("C1: headers() postpones during a prerender pass", () => {
  runWithContext(ctx(), () => {
    withPrerender(() => {
      let thrown: unknown;
      try {
        headers();
      } catch (e) {
        thrown = e;
      }
      assert(isPostpone(thrown), "headers() should throw a Postpone during prerender");
      assertEquals((thrown as Postpone).api, "headers");
    });
  });
});

Deno.test("C1: cookies() and connection() postpone during a prerender pass", async () => {
  await runWithContext(ctx(), async () => {
    await withPrerender(async () => {
      let cookieThrew = false;
      try {
        cookies();
      } catch (e) {
        cookieThrew = isPostpone(e);
      }
      assert(cookieThrew, "cookies() should postpone during prerender");

      let connThrew = false;
      try {
        await connection();
      } catch (e) {
        connThrew = isPostpone(e);
      }
      assert(connThrew, "connection() should postpone during prerender");
    });
  });
});

Deno.test("C1: no postpone outside a prerender pass (normal render)", () => {
  runWithContext(ctx(), () => {
    assert(!isPrerendering(), "not prerendering outside withPrerender");
    assert(!shouldPostpone());
    // A normal read resolves and marks the render dynamic.
    const h = headers();
    assertEquals(h.get("cookie"), "a=1");
  });
});

Deno.test("C1: a `use cache` scope suppresses postpone during prerender", async () => {
  await runWithContext(ctx(), async () => {
    let readInsideCache: string | undefined;
    let postponedInsideCache = false;
    await withPrerender(async () => {
      assert(shouldPostpone(), "outside the cache scope, prerender postpones");
      const { value } = await withCacheScope(() => {
        // Inside the cache body, postponing is suppressed: reads resolve.
        assert(!shouldPostpone(), "inside a use cache scope, postpone is suppressed");
        try {
          readInsideCache = headers().get("cookie") ?? undefined;
        } catch (e) {
          postponedInsideCache = isPostpone(e);
        }
        return "ok";
      });
      assertEquals(value, "ok");
    });
    assert(!postponedInsideCache, "a read inside use cache must not postpone");
    assertEquals(readInsideCache, "a=1", "the read resolved to the real header value");
  });
});

Deno.test("C1: withoutPostpone is a no-op outside a prerender pass", async () => {
  await runWithContext(ctx(), async () => {
    const v = await withoutPostpone(() => Promise.resolve(42));
    assertEquals(v, 42);
    assert(!isPrerendering());
  });
});
