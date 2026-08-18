// Part C1: PPR postpone primitives — a dynamic read postpones during a prerender
// pass, but not inside a `use cache` scope and not during a normal render.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("C1: a `use cache` scope suppresses postpone and rejects dynamic reads", async () => {
  await runWithContext(ctx(), async () => {
    await withPrerender(async () => {
      assert(shouldPostpone(), "outside the cache scope, prerender postpones");
      const { value } = await withCacheScope(() => {
        // Inside the cache body, postponing is suppressed.
        assert(!shouldPostpone(), "inside a use cache scope, postpone is suppressed");
        // But a dynamic read is REJECTED (its value would be cached cross-request) —
        // a hard error, not a postpone.
        let err: unknown;
        try {
          headers();
        } catch (e) {
          err = e;
        }
        assert(err instanceof Error && !isPostpone(err), "dynamic read throws, not postpones");
        assertStringIncludes((err as Error).message, 'cannot be read inside a "use cache"');
        return "ok";
      });
      assertEquals(value, "ok");
    });
  });
});

Deno.test("C1: withoutPostpone is a no-op outside a prerender pass", async () => {
  await runWithContext(ctx(), async () => {
    const v = await withoutPostpone(() => Promise.resolve(42));
    assertEquals(v, 42);
    assert(!isPrerendering());
  });
});
