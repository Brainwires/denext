// `setRequestTimeout(ms)` (denext/server) replaces the app's `requestTimeout` for one request —
// longer (an Edge Function's own 150 s, a large upload), `0` (none), or shorter — and
// `@denext/backend` uses it to give its surfaces their own deadlines: functions, storage and
// REST were all cut at the app's 30 s default (an Edge Function's 150 s was unreachable).

import { assertEquals } from "@std/assert";
import { createApp } from "../src/server/app.ts";
import { setRequestTimeout } from "../src/server/request-context.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { deadlineHandler, surfaceDeadlines } from "../packages/backend/src/timeouts.ts";
import { resolveFunctions } from "../packages/backend/src/functions.ts";
import { resolveRest } from "../packages/backend/src/rest.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const EMPTY: RouteManifest = {
  pages: [],
  api: [],
  rootLayout: null,
  rootNotFound: null,
  rootGlobalError: null,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An app whose only handler sets `deadline` (when given), then answers after `work` ms. */
function app(requestTimeout: number, deadline: number | undefined, work: number) {
  return createApp({
    getManifest: () => EMPTY,
    load: () => Promise.reject(new Error("no modules")),
    requestTimeout,
    matchExternal: async () => {
      if (deadline !== undefined) setRequestTimeout(deadline);
      await sleep(work);
      return new Response("done");
    },
  });
}

async function status(handler: ReturnType<typeof app>): Promise<number> {
  const res = await handler(new Request("http://localhost/fn"));
  await res.body?.cancel();
  return res.status;
}

Deno.test("setRequestTimeout: longer, none, or shorter than the app's deadline", async () => {
  assertEquals(await status(app(40, undefined, 120)), 503, "the app's deadline applies");
  assertEquals(await status(app(40, 1000, 120)), 200, "a longer deadline lets it finish");
  assertEquals(await status(app(40, 0, 120)), 200, "0 removes it");
  assertEquals(await status(app(5000, 30, 120)), 503, "a shorter one cuts it early");
});

Deno.test("@denext/backend: each surface's deadline, only ever longer than the app's", () => {
  const functions = resolveFunctions({ functions: { slow: { timeoutMs: 400_000 } } });
  const rest = resolveRest({ statementTimeout: 60_000 });
  const table = surfaceDeadlines({
    appTimeoutMs: 30_000,
    functions,
    rest,
    storage: true,
    storageApiBase: "/storage/v1",
  });
  assertEquals(table, [
    { prefix: "/functions/v1/", ms: 410_000 },
    { prefix: "/_denext/storage/", ms: 3_600_000 },
    { prefix: "/storage/v1/", ms: 3_600_000 },
    { prefix: "/rest/v1/", ms: 66_000 },
  ]);
  // REST's default 5 s statements fit in the app's 30 s: no entry. An app with no deadline
  // gives none to any surface.
  const defaults = surfaceDeadlines({
    appTimeoutMs: 30_000,
    rest: resolveRest({}),
    storage: false,
    storageApiBase: null,
  });
  assertEquals(defaults, []);
  assertEquals(
    surfaceDeadlines({ appTimeoutMs: 0, functions, storage: true, storageApiBase: null }),
    [],
  );
});

Deno.test("@denext/backend: the deadline handler sets the surface's deadline and claims nothing", async () => {
  const handler = deadlineHandler([{ prefix: "/functions/v1/", ms: 160_000 }], "/app");
  const at = async (path: string) => {
    const ctx = createRequestContext(new Request(`http://localhost${path}`));
    await runWithContext(ctx, () => {
      assertEquals(handler(new Request(`http://localhost${path}`)), null);
    });
    return ctx.timeoutMs;
  };
  assertEquals(await at("/app/functions/v1/hello"), 160_000);
  assertEquals(await at("/functions/v1/hello"), 160_000);
  assertEquals(await at("/app/other"), undefined);
});
