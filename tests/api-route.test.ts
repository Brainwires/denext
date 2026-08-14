// API-route dispatch (src/server/api.ts). Two layers are exercised:
//   1. handleApi(match, request, load) directly — method dispatch, HEAD-from-GET
//      synthesis, the 405 + Allow contract, context.params threading, and the
//      various Response shapes a handler may return.
//   2. createApp(...) end-to-end — an API route reached through the real request
//      pipeline, including the redacted-500 contract when a handler throws.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { handleApi } from "../src/server/api.ts";
import { createApp } from "../src/server/app.ts";
import { NextResponse } from "../src/compat/next/server.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { ApiMatch } from "../src/router/match.ts";
import type { ApiRoute, RouteManifest } from "../src/router/manifest.ts";
import type { RouteParams } from "../src/router/segments.ts";
import type { ApiModule, ModuleLoader } from "../src/server/types.ts";

// --- helpers for the direct handleApi layer -------------------------------

/** Build an ApiMatch + loader that resolves `mod` for handleApi to dispatch to. */
function dispatch(
  mod: ApiModule,
  request: Request,
  params: RouteParams = {},
): Promise<Response> {
  const match: ApiMatch = {
    route: {
      kind: "api",
      filePath: "route.ts",
      pattern: parsePattern("/api/x"),
      routePath: "/api/x",
    } satisfies ApiRoute,
    params,
  };
  const load: ModuleLoader = () => Promise.resolve(mod);
  return handleApi(match, request, load);
}

const req = (method: string, body?: BodyInit) =>
  new Request("http://localhost/api/x", { method, body });

// --- 1. method dispatch ---------------------------------------------------

Deno.test("handleApi routes GET to the GET handler", async () => {
  const res = await dispatch({ GET: () => new Response("got") }, req("GET"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "got");
});

Deno.test("handleApi routes each verb to its own handler", async () => {
  const mod: ApiModule = {
    POST: () => new Response("p"),
    PUT: () => new Response("u"),
    PATCH: () => new Response("a"),
    DELETE: () => new Response("d"),
    OPTIONS: () => new Response("o"),
  };
  assertEquals(await (await dispatch(mod, req("POST"))).text(), "p");
  assertEquals(await (await dispatch(mod, req("PUT"))).text(), "u");
  assertEquals(await (await dispatch(mod, req("PATCH"))).text(), "a");
  assertEquals(await (await dispatch(mod, req("DELETE"))).text(), "d");
  assertEquals(await (await dispatch(mod, req("OPTIONS"))).text(), "o");
});

Deno.test("handleApi awaits an async handler", async () => {
  const res = await dispatch({
    GET: async () => {
      await Promise.resolve();
      return new Response("async");
    },
  }, req("GET"));
  assertEquals(await res.text(), "async");
});

Deno.test("handleApi reads the request body in a POST handler", async () => {
  const res = await dispatch({
    POST: async (r) => new Response((await r.text()).toUpperCase()),
  }, req("POST", "hello"));
  assertEquals(await res.text(), "HELLO");
});

// --- 2. context.params ----------------------------------------------------

Deno.test("handleApi threads dynamic params into context", async () => {
  let seen: RouteParams | undefined;
  await dispatch(
    {
      GET: (_r, ctx) => {
        seen = ctx.params;
        return new Response("ok");
      },
    },
    req("GET"),
    { id: "42", slug: "a/b" },
  );
  assertEquals(seen, { id: "42", slug: "a/b" });
});

// --- 3. the 405 + Allow contract ------------------------------------------

Deno.test("handleApi returns 405 with an Allow header listing implemented verbs", async () => {
  const mod: ApiModule = { GET: () => new Response("g"), POST: () => new Response("p") };
  const res = await dispatch(mod, req("DELETE"));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET, POST");
  await res.body?.cancel();
});

Deno.test("handleApi 405 omits Allow when the module exports no handlers", async () => {
  const res = await dispatch({}, req("GET"));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), null);
  await res.body?.cancel();
});

// --- 4. HEAD synthesis ----------------------------------------------------

Deno.test("handleApi synthesizes HEAD from GET: null body, GET status + headers", async () => {
  const res = await dispatch({
    GET: () => new Response("body", { status: 201, headers: { "x-tag": "v" } }),
  }, req("HEAD"));
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("x-tag"), "v");
  assertEquals(await res.text(), ""); // HEAD carries no body
});

Deno.test("handleApi prefers an explicit HEAD handler over GET synthesis", async () => {
  const res = await dispatch({
    GET: () => new Response("from-get"),
    HEAD: () => new Response(null, { status: 204, headers: { "x-head": "1" } }),
  }, req("HEAD"));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("x-head"), "1");
});

Deno.test("handleApi returns 405 for HEAD when neither HEAD nor GET exists", async () => {
  const res = await dispatch({ POST: () => new Response("p") }, req("HEAD"));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "POST");
  await res.body?.cancel();
});

// --- 5. response shapes ---------------------------------------------------

Deno.test("handleApi passes a Response.json() payload through", async () => {
  const res = await dispatch({ GET: () => Response.json({ ok: true, n: 1 }) }, req("GET"));
  assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
  assertEquals(await res.json(), { ok: true, n: 1 });
});

Deno.test("handleApi passes a NextResponse through unchanged", async () => {
  const res = await dispatch({
    GET: () => NextResponse.json({ via: "next" }, { status: 202 }),
  }, req("GET"));
  assertEquals(res.status, 202);
  assertEquals(await res.json(), { via: "next" });
});

Deno.test("handleApi passes a streaming body through", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("chunk-1;"));
      c.enqueue(new TextEncoder().encode("chunk-2"));
      c.close();
    },
  });
  const res = await dispatch({ GET: () => new Response(stream) }, req("GET"));
  assertEquals(await res.text(), "chunk-1;chunk-2");
});

// --- 6. end-to-end through createApp --------------------------------------

function appWithApi(mod: ApiModule, extra: Record<string, unknown> = {}) {
  const manifest: RouteManifest = {
    pages: [],
    api: [{
      kind: "api",
      pattern: parsePattern("/api/thing"),
      routePath: "/api/thing",
      filePath: "thing.ts",
    }],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  return createApp({
    getManifest: () => manifest,
    load: (fp: string) => Promise.resolve(fp === "thing.ts" ? mod : undefined),
    ...extra,
  });
}

Deno.test("createApp dispatches a matched API route through the pipeline", async () => {
  const app = appWithApi({ GET: () => Response.json({ hello: "api" }) });
  const res = await app(new Request("http://localhost/api/thing"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { hello: "api" });
});

Deno.test("createApp returns 405 for an unimplemented verb on a matched API route", async () => {
  const app = appWithApi({ GET: () => new Response("g") });
  const res = await app(new Request("http://localhost/api/thing", { method: "DELETE" }));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET");
  await res.body?.cancel();
});

Deno.test("createApp redacts a thrown API handler to a 500 with a request id and no leak", async () => {
  const app = appWithApi({
    GET: () => {
      throw new Error("secret db credentials at 10.0.0.1");
    },
  });
  const res = await app(new Request("http://localhost/api/thing"));
  const body = await res.text();
  assertEquals(res.status, 500);
  assert(res.headers.get("x-request-id"), "a 500 must carry a correlation id");
  assert(!body.includes("secret db credentials"), "the error message must not leak to the client");
  assert(!body.includes("10.0.0.1"), "internal details must not leak to the client");
});

Deno.test("createApp threads dynamic API params from the matched route", async () => {
  const manifest: RouteManifest = {
    pages: [],
    api: [{
      kind: "api",
      pattern: parsePattern("/api/users/[id]"),
      routePath: "/api/users/[id]",
      filePath: "user.ts",
    }],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
  const app = createApp({
    getManifest: () => manifest,
    load: () =>
      Promise.resolve(
        {
          GET: (_r, ctx) => Response.json({ id: ctx.params.id }),
        } satisfies ApiModule,
      ),
  });
  const res = await app(new Request("http://localhost/api/users/99"));
  assertEquals(await res.json(), { id: "99" });
});
