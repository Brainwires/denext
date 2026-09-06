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
import { ApiError } from "../src/server/api-error.ts";
import {
  forbidden,
  notFound,
  permanentRedirect,
  redirect,
  unauthorized,
} from "../src/runtime/error-boundary.ts";

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

Deno.test("handleApi cancels the synthesized GET stream for a HEAD (no leak)", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new TextEncoder().encode("chunk"));
    },
    cancel() {
      canceled = true; // the reconciler must cancel the GET body we discard
    },
  });
  const res = await dispatch({
    GET: () => new Response(stream, { status: 200 }),
  }, req("HEAD"));
  assertEquals(res.status, 200);
  assertEquals(res.body, null, "HEAD response carries no body");
  assert(canceled, "the discarded GET stream was canceled, not leaked");
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

Deno.test("createApp returns 405 (not 404) for a non-GET/HEAD method on a page URL", async () => {
  const manifest: RouteManifest = {
    pages: [{
      kind: "page",
      pattern: parsePattern("/about"),
      routePath: "/about",
      filePath: "about.tsx",
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
  const app = createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: () => null }),
  });
  const res = await app(new Request("http://localhost/about", { method: "POST" }));
  assertEquals(res.status, 405, "the page exists; POST is just not allowed");
  assertEquals(res.headers.get("allow"), "GET, HEAD");
  await res.body?.cancel();
  // A truly unknown path stays a 404, not a 405.
  const missing = await app(new Request("http://localhost/nope", { method: "POST" }));
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
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

// --- 3. control signals, typed errors, and the body cap (the handleApi seam) -----

Deno.test("handleApi: redirect()/permanentRedirect() thrown in a handler become the redirect", async () => {
  const res = await dispatch({ GET: () => redirect("/login") }, req("GET"));
  assertEquals([res.status, res.headers.get("location")], [307, "/login"]);
  const perm = await dispatch({ GET: () => permanentRedirect("/new") }, req("GET"));
  assertEquals(perm.status, 308);
  // A user-controlled target is normalized so it cannot become a protocol-relative escape.
  const evil = await dispatch({ GET: () => redirect("//evil.com/x") }, req("GET"));
  assertEquals(evil.headers.get("location"), "/evil.com/x");
});

Deno.test("handleApi: notFound()/forbidden()/unauthorized() are 404/403/401 (JSON, or text for a browser)", async () => {
  const nf = await dispatch({ GET: () => notFound() }, req("GET"));
  assertEquals(nf.status, 404);
  assertEquals((await nf.json()).error.code, "not_found");
  const fb = await dispatch({ GET: () => forbidden() }, req("GET"));
  assertEquals([fb.status, (await fb.json()).error.code], [403, "forbidden"]);
  const ua = await dispatch({ GET: () => unauthorized() }, req("GET"));
  assertEquals([ua.status, (await ua.json()).error.code], [401, "unauthorized"]);
  const browser = await dispatch(
    { GET: () => notFound() },
    new Request("http://localhost/api/x", { headers: { accept: "text/html,*/*" } }),
  );
  assertEquals(browser.status, 404);
  assertStringIncludes(browser.headers.get("content-type") ?? "", "text/plain");
  assertEquals(await browser.text(), "Not Found");
});

Deno.test("createApp: a thrown ApiError is its JSON envelope verbatim, with a request id", async () => {
  const app = appWithApi({
    GET: () => {
      throw new ApiError(409, "conflict", { message: "already exists", data: { id: 7 } });
    },
  });
  const res = await app(new Request("http://localhost/api/thing"));
  assertEquals(res.status, 409);
  assert(res.headers.get("x-request-id"));
  assertEquals(await res.json(), {
    error: { code: "conflict", status: 409, message: "already exists", data: { id: 7 } },
  });
});

Deno.test("createApp: a declared over-cap body is a 413 before the handler runs", async () => {
  let ran = false;
  const app = appWithApi({
    POST: async (r) => {
      ran = true;
      return Response.json(await r.json());
    },
  }, { apiMaxBodyBytes: 16 });
  const body = JSON.stringify({ padding: "x".repeat(64) });
  // A real server sets Content-Length from the socket; a constructed Request needs it spelled out.
  const res = await app(
    new Request("http://localhost/api/thing", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    }),
  );
  assertEquals(res.status, 413);
  assertEquals((await res.json()).error.code, "payload_too_large");
  assertEquals(ran, false, "the declared-length fast path must refuse before the handler runs");
});

Deno.test("handleApi: a chunked body read past the cap is a 413; under the cap it streams", async () => {
  const chunked = (chunks: string[]) =>
    new Request("http://localhost/api/x", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
          c.close();
        },
      }),
      // @ts-ignore duplex is required by the spec for streaming bodies
      duplex: "half",
    });
  const echo: ApiModule = { POST: async (r) => new Response(await r.text()) };
  const over = await handleApiWithCap(echo, chunked(["0123456789", "0123456789"]), 16);
  assertEquals(over.status, 413);
  const under = await handleApiWithCap(echo, chunked(["0123", "4567"]), 16);
  assertEquals([under.status, await under.text()], [200, "01234567"]);
});

Deno.test("handleApi: `export const maxBodyBytes = false` lifts the cap; a number raises it", async () => {
  const big = "x".repeat(2 * 1024 * 1024);
  const unbounded = {
    POST: async (r: Request) => new Response(String((await r.text()).length)),
    maxBodyBytes: false,
  };
  const res = await handleApiWithCap(unbounded as unknown as ApiModule, req("POST", big), 16);
  assertEquals([res.status, await res.text()], [200, String(big.length)]);
  const raised = {
    POST: async (r: Request) => new Response(String((await r.text()).length)),
    maxBodyBytes: 4 * 1024 * 1024,
  };
  const ok = await handleApiWithCap(raised as unknown as ApiModule, req("POST", big), 16);
  assertEquals(ok.status, 200);
  // Default cap (1 MiB) refuses the 2 MiB body on a plain route.
  const capped = await dispatch(
    { POST: async (r) => new Response(await r.text()) },
    req("POST", big),
  );
  assertEquals(capped.status, 413);
});

Deno.test("handleApi: the cap leaves GET, and a small multipart formData(), untouched", async () => {
  const get = await handleApiWithCap({ GET: () => new Response("ok") }, req("GET"), 1);
  assertEquals(await get.text(), "ok");
  const fd = new FormData();
  fd.set("name", "Ada");
  const mod: ApiModule = {
    POST: async (r) => new Response(String((await r.formData()).get("name"))),
  };
  const res = await dispatch(
    mod,
    new Request("http://localhost/api/x", { method: "POST", body: fd }),
  );
  assertEquals([res.status, await res.text()], [200, "Ada"]);
});

/** Direct handleApi with an explicit app-level cap. */
function handleApiWithCap(
  mod: ApiModule,
  request: Request,
  maxBodyBytes: number,
): Promise<Response> {
  const match: ApiMatch = {
    route: {
      kind: "api",
      filePath: "route.ts",
      pattern: parsePattern("/api/x"),
      routePath: "/api/x",
    },
    params: {},
  };
  return handleApi(match, request, () => Promise.resolve(mod), { maxBodyBytes });
}

Deno.test("handleApi: a request flagged x-denext-wire is decoded before a plain handler's req.json()", async () => {
  const seen: unknown[] = [];
  const mod: ApiModule = {
    POST: async (r) => {
      seen.push(await r.json());
      return new Response("ok");
    },
  };
  const flagged = (body: unknown) =>
    new Request("http://localhost/api/x", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-denext-wire": "1" },
    });
  const ok = await dispatch(mod, flagged({ when: { $: "D", v: "1970-01-01T00:00:00.000Z" } }));
  assertEquals(ok.status, 200);
  assert((seen[0] as { when: Date }).when instanceof Date);
  // Unflagged: untouched (a literal `$` object stays data).
  await dispatch(
    mod,
    new Request("http://localhost/api/x", {
      method: "POST",
      body: JSON.stringify({ when: { $: "D", v: "x" } }),
      headers: { "content-type": "application/json" },
    }),
  );
  assertEquals(seen[1], { when: { $: "D", v: "x" } });
  // A malformed tag in a flagged body is a 400, not a 500.
  const bad = await dispatch(mod, flagged({ when: { $: "Z" } }));
  assertEquals(bad.status, 400);
  assertEquals((await bad.json()).error.code, "bad_request");
});
