// Part A4/A5: updateTag() read-your-writes (same-request recompute) and refresh(),
// both Server-Action-only, and their surfacing to the client in the action response.

import { assertEquals } from "@std/assert";
import {
  inMemoryCacheStore,
  refresh,
  setCacheStore,
  unstable_cache,
  updateTag,
} from "../src/server/cache.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { createApp } from "../src/server/app.ts";
import { actionEndpoint, serverAction } from "../src/runtime/server-action.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";

Deno.test("A4: updateTag forces a same-request recompute (read-your-writes)", async () => {
  setCacheStore(inMemoryCacheStore());
  let n = 0;
  const load = unstable_cache(() => Promise.resolve(++n), ["u"], { tags: ["profile"] });
  const ctx = createRequestContext(new Request("http://x/"));
  await runWithContext(ctx, async () => {
    assertEquals(await load(), 1, "primed");
    assertEquals(await load(), 1, "cached hit");
    await updateTag("profile"); // the action writes, then expires the tag
    // Same request, after updateTag: the read must recompute (see its own write).
    assertEquals(await load(), 2, "read-your-writes: recomputed in-request");
  });
});

function manifest(): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern("x"),
      routePath: "/x",
      filePath: "page.tsx",
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
}

function postAction(app: (req: Request) => Promise<Response>, id: string): Promise<Response> {
  return app(
    new Request("http://localhost" + actionEndpoint(id), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        host: "localhost",
        "x-denext-action": "1",
      },
      body: JSON.stringify({ args: [] }),
    }),
  );
}

Deno.test("A4/A5: an action's updateTag + refresh surface in its XHR response", async () => {
  setCacheStore(inMemoryCacheStore());
  serverAction("a4_update", () => {
    updateTag("posts");
    updateTag("user-1");
    refresh();
    return "ok";
  });
  const app = createApp({ getManifest: manifest, load: () => Promise.resolve({}) });
  const res = await postAction(app, "a4_update");
  assertEquals(res.status, 200);
  const body = await res.json() as { result: string; refresh?: boolean; updatedTags?: string[] };
  assertEquals(body.result, "ok");
  assertEquals(body.refresh, true, "refresh() surfaced");
  assertEquals((body.updatedTags ?? []).sort(), ["posts", "user-1"], "updateTag tags surfaced");
});

Deno.test("A5: an action that doesn't call refresh/updateTag carries no directives", async () => {
  setCacheStore(inMemoryCacheStore());
  serverAction("a4_plain", () => "done");
  const app = createApp({ getManifest: manifest, load: () => Promise.resolve({}) });
  const res = await postAction(app, "a4_plain");
  const body = await res.json() as Record<string, unknown>;
  assertEquals(body, { result: "done" }, "no refresh/updatedTags fields when unused");
});
