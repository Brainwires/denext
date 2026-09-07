// A small app with a handful of API routes (and one page) — the target for the typed-API batch
// tests (server handler + client batcher). Shared so both sides exercise the same routes.

import { createApp } from "../../src/server/app.ts";
import { parsePattern } from "../../src/router/segments.ts";
import type { RouteManifest } from "../../src/router/manifest.ts";
import type { ApiModule } from "../../src/server/types.ts";
import { createMiddlewareRunner } from "../../src/server/middleware.ts";
import { ApiError } from "../../src/server/api-error.ts";
import { json } from "../../src/server/typed-response.ts";
import { cookies } from "../../src/server/request-context.ts";
import { createApiClient } from "../../src/runtime/api-client.ts";

/** How many times `/api/count` ran (reset by tests). */
export const counters = { count: 0 };

/** The app's origin (what a browser would send as `Origin`). */
export const ORIGIN = "http://localhost";

/** An app with a few API routes (and a page) — the batch's targets. */
export function batchApp(extra: Record<string, unknown> = {}, middleware?: unknown) {
  const routes: Record<string, ApiModule> = {
    "hello.ts": {
      GET: (req) => json({ hello: "world", id: req.headers.get("x-request-id") }),
    },
    "when.ts": { GET: () => json({ at: new Date(0) }) },
    "secret.ts": { GET: () => json({ secret: true }) },
    "boom.ts": {
      GET: () => {
        throw new ApiError(409, "conflict", { message: "taken" });
      },
    },
    "cookie.ts": {
      GET: () => new Response("c", { headers: { "set-cookie": "seen=1; Path=/" } }),
    },
    "crash.ts": {
      GET: () => {
        throw new Error("db password = hunter2");
      },
    },
    "echo.ts": {
      GET: (req) => json({ q: new URL(req.url).search, cookie: req.headers.get("cookie") }),
    },
    // Reads a dynamic request API — a render calling this must become dynamic too.
    "dynamic.ts": {
      GET: async () => json({ theme: (await cookies()).get("theme")?.value ?? null }),
    },
    // Counts its runs, so a test can prove an in-process call was served from the cache.
    "count.ts": { GET: () => json({ n: ++counters.count }) },
    // Slow enough that concurrent batches queue on the shared gate.
    "slow.ts": {
      GET: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return json({ ok: true });
      },
    },
    // Calls ITSELF through the typed client: in-process recursion must terminate (508).
    "self.ts": {
      GET: async () => {
        const api = createApiClient<{ "/api/self": { GET: { response: unknown } } }>();
        return json({ inner: await api("/api/self", "GET") });
      },
    },
  };
  const api = Object.keys(routes).map((f) => ({
    kind: "api" as const,
    pattern: parsePattern(`/api/${f.replace(".ts", "")}`),
    routePath: `/api/${f.replace(".ts", "")}`,
    filePath: f,
  }));
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("/"),
      routePath: "/",
      filePath: "page.tsx",
      layouts: [],
    } as never],
    api,
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp: string) =>
      Promise.resolve(
        fp === "page.tsx" ? { default: () => null } : routes[fp],
      ),
    ...(middleware
      ? { getMiddleware: () => createMiddlewareRunner({ default: middleware } as never) }
      : {}),
    ...extra,
  });
}
