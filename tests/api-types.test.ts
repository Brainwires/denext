// Typed API client (src/build/api-types.ts + src/runtime/api-client.ts).
//
// Two halves:
//   1. The GENERATOR emits an `ApiSchema` that imports each route module's TYPE and infers
//      its handlers' shapes (`ModuleEndpoints`) — no `deno doc`. We assert the emitted
//      source, then `deno check` a real consumer to prove the schema type-checks a correct
//      call AND rejects the mistakes it's meant to catch (unknown path, wrong body, missing
//      params, wrong catch-all shape, typed query, undeclared error code).
//   2. The RUNTIME (`buildPath` / `apiRequest` / `createApiClient`) does param substitution
//      and the fetch round-trip — driven against a tiny in-process handler, no browser.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { scanRoutes } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { generateApiTypes } from "../src/build/api-types.ts";
import {
  ApiClientError,
  apiRequest,
  buildPath,
  createApiClient,
  isApiClientError,
} from "../src/runtime/api-client.ts";
import { json } from "../src/server/typed-response.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { batchApp, ORIGIN } from "./helpers/batch-app.ts";
import { API_BATCH_PATH } from "../src/runtime/api-batch-protocol.ts";
import { ApiError, apiErrorResponse } from "../src/server/api-error.ts";

const REPO_CONFIG = new URL("../deno.json", import.meta.url).pathname;

/** Write a set of `{ relPath: source }` files under a fresh temp app dir. */
async function makeApp(files: Record<string, string>): Promise<{ dir: string; outDir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext-api-types-" });
  const outDir = join(dir, ".denext");
  await Deno.mkdir(outDir, { recursive: true });
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(dir, rel);
    await Deno.mkdir(join(abs, ".."), { recursive: true });
    await Deno.writeTextFile(abs, src);
  }
  return { dir, outDir };
}

/** Generate `.denext/api.ts` for a temp app and return the emitted source. */
async function generateFor(dir: string, outDir: string): Promise<string> {
  const manifest = await scanRoutes(join(dir, "app"));
  const src = await generateApiTypes(manifest, { outDir, configPath: REPO_CONFIG });
  await Deno.writeTextFile(join(outDir, "api.ts"), src);
  return src;
}

/** `deno check` one source file; resolve to its exit code (0 = type-checks clean). */
async function denoCheck(file: string): Promise<number> {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["check", "--config", REPO_CONFIG, file],
    stdout: "null",
    stderr: "null",
  }).output();
  return code;
}

const HELLO_ROUTE = `
import { json, type TypedResponse } from "denext/server";
export function GET(): TypedResponse<{ message: string; runtime: "deno" }> {
  return json({ message: "hi", runtime: "deno" });
}
`;

const USER_ROUTE = `
import { json, type TypedRequest, type TypedResponse } from "denext/server";
export interface User { id: string; name?: string; tags: string[] }
type Local = { secret: number }; // NOT exported — must still reach the client's types
export function GET(): TypedResponse<{ user: User; next: string | null; local: Local }> {
  return json({ user: { id: "1", tags: [] }, next: null, local: { secret: 1 } });
}
export async function POST(req: TypedRequest<{ name: string }>): Promise<TypedResponse<{ ok: true }>> {
  await req.json();
  return json({ ok: true }, { status: 201 });
}
export function DELETE(): Response { return new Response(null, { status: 204 }); }
`;

/** A `defineApi` route with a hand-rolled Standard Schema that carries the inference slot. */
const POSTS_ROUTE = `
import { defineApi, type StandardSchemaV1 } from "denext/server";
function schema<T>(): StandardSchemaV1<T> & { "~standard": { types: { input: T; output: T } } } {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v: unknown) => ({ value: v as T }),
      types: undefined as unknown as { input: T; output: T },
    },
  };
}
export const POST = defineApi({
  body: schema<{ title: string }>(),
  query: schema<{ page: number }>(),
  response: schema<{ id: number }>(),
  errors: { conflict: 409 },
}, ({ body }) => ({ id: body.title.length }));
`;

const FILES_ROUTE = `
import { json, type TypedResponse } from "denext/server";
export function GET(): TypedResponse<{ n: number }> { return json({ n: 1 }); }
`;

Deno.test("generateApiTypes: imports each route's type and infers via ModuleEndpoints (no deno doc)", async () => {
  const { dir, outDir } = await makeApp({
    "app/api/hello/route.ts": HELLO_ROUTE,
    "app/api/user/[id]/route.ts": USER_ROUTE,
    "app/api/files/[...path]/route.ts": FILES_ROUTE,
    "app/api/docs/[[...slug]]/route.ts": FILES_ROUTE,
  });
  try {
    const src = await generateFor(dir, outDir);
    assertStringIncludes(src, `import type { ModuleEndpoints } from "denext";`);
    // A `type` alias (not interface) so keyof stays literal yet satisfies the Record constraint.
    assertStringIncludes(src, "export type ApiSchema = {");
    // Routes sorted by path; each imports the route module's TYPE and infers from it.
    assertStringIncludes(src, `import type * as R0 from "../app/api/docs/[[...slug]]/route.ts";`);
    assertStringIncludes(
      src,
      `"/api/docs/[[...slug]]": ModuleEndpoints<typeof R0, { slug?: string[] }>;`,
    );
    assertStringIncludes(
      src,
      `"/api/files/[...path]": ModuleEndpoints<typeof R1, { path: string[] }>;`,
    );
    assertStringIncludes(src, `"/api/hello": ModuleEndpoints<typeof R2, never>;`);
    assertStringIncludes(src, `"/api/user/[id]": ModuleEndpoints<typeof R3, { id: string }>;`);
    // Registered so `createApiClient()` needs no type argument.
    assertStringIncludes(src, `declare module "denext"`);
    assertStringIncludes(src, "interface RegisteredApi");
    assert(!src.includes("deno doc"), "the generator no longer mentions deno doc");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateApiTypes: empty (and unregistered) when an app has no route handlers", async () => {
  const { dir, outDir } = await makeApp({
    "app/page.tsx": "export default function P() { return null; }",
  });
  try {
    const src = await generateFor(dir, outDir);
    assertStringIncludes(src, "// (no route handlers)");
    assert(!src.includes("RegisteredApi"), "an empty schema must not be registered");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generateApiTypes: is a pure function of the manifest — no subprocess, sub-millisecond per route", async () => {
  const api = Array.from({ length: 50 }, (_, i) => ({
    kind: "api" as const,
    pattern: parsePattern(`/api/r${i}/[id]`),
    routePath: `/api/r${i}/[id]`,
    filePath: `/app/api/r${i}/[id]/route.ts`,
  }));
  const manifest = { pages: [], api, rootLayout: null, rootNotFound: null, rootGlobalError: null };
  const t0 = performance.now();
  const src = await generateApiTypes(manifest as never, { outDir: "/app/.denext" });
  const ms = performance.now() - t0;
  assert(ms < 50, `50 routes took ${ms.toFixed(1)} ms (a deno doc per route took seconds)`);
  assertStringIncludes(src, "typeof R49");
});

/**
 * Write a consumer module under `dir` that binds a typed client, followed by `body`. It imports
 * the generated module for its side effect only: the `declare module "denext"` augmentation
 * registers the schema, so `createApiClient()` is typed with NO type argument.
 */
async function writeConsumer(dir: string, name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await Deno.writeTextFile(
    file,
    `import { createApiClient, type ErrorsOf } from "denext";\n` +
      `import "./.denext/api.ts";\n` +
      `import type { ApiSchema } from "./.denext/api.ts";\n` +
      `const api = createApiClient();\n` +
      `type Posts = ApiSchema["/api/posts"]["POST"];\n` + body,
  );
  return file;
}

// Each of these is a distinct mistake the schema must reject (non-zero exit). Checked in
// small BATCHES — a `deno check` is heavy, and firing all of them at once starved a small
// (2-core) CI runner enough to flake; a pool of 2 keeps the subprocess load bounded.
const BAD_CONSUMERS: Record<string, string> = {
  "unknown route path": `await api("/api/nope", "GET");`,
  "wrong method": `await api("/api/hello", "POST");`,
  "missing required params": `await api("/api/user/[id]", "GET");`,
  "wrong param name": `await api("/api/user/[id]", "GET", { params: { slug: "1" } });`,
  "missing required body": `await api("/api/user/[id]", "POST", { params: { id: "1" } });`,
  "wrong body field type":
    `await api("/api/user/[id]", "POST", { params: { id: "1" }, body: { name: 1 } });`,
  "misused response type":
    `const h = await api("/api/hello", "GET"); const n: number = h.message; void n;`,
  "catch-all param must be a string[]":
    `await api("/api/files/[...path]", "GET", { params: { path: "a/b" } });`,
  "defineApi body wrong type":
    `await api("/api/posts", "POST", { body: { title: 1 }, query: { page: 1 } });`,
  "typed query rejects an unknown key":
    `await api("/api/posts", "POST", { body: { title: "x" }, query: { pag: 1 } });`,
  "undeclared error code": `const c: ErrorsOf<Posts> = "nope"; void c;`,
};

async function stepCorrectConsumer(dir: string): Promise<void> {
  const file = await writeConsumer(
    dir,
    "ok.ts",
    `
const hello = await api("/api/hello", "GET");
const _msg: string = hello.message;
const _rt: "deno" = hello.runtime;
const u = await api("/api/user/[id]", "GET", { params: { id: "1" } });
const _next: string | null = u.next;
const _secret: number = u.local.secret; // a NON-exported local type came through
const created = await api("/api/user/[id]", "POST", { params: { id: "1" }, body: { name: "Ada" } });
const _ok: true = created.ok;
const f = await api("/api/files/[...path]", "GET", { params: { path: ["a", "b"] } });
const _n: number = f.n;
const p = await api("/api/posts", "POST", { body: { title: "x" }, query: { page: 2 } });
const _id: number = p.id;
const _declared: ErrorsOf<Posts> = "conflict";
const _builtin: ErrorsOf<Posts> = "not_found";
const explicit = createApiClient<ApiSchema>(); // the explicit form still works
void [_msg, _rt, _next, _secret, _ok, _n, _id, _declared, _builtin, explicit];
`,
  );
  assertEquals(await denoCheck(file), 0);
}

async function stepRejectsEveryMistake(dir: string): Promise<void> {
  const entries = Object.entries(BAD_CONSUMERS);
  const results: Array<readonly [string, number]> = [];
  const POOL = 2; // bounded concurrency, gentle on a small CI runner
  for (let i = 0; i < entries.length; i += POOL) {
    const batch = await Promise.all(
      entries.slice(i, i + POOL).map(async ([label, body]) => {
        const file = await writeConsumer(dir, `bad-${label.replace(/\W+/g, "-")}.ts`, body);
        return [label, await denoCheck(file)] as const;
      }),
    );
    results.push(...batch);
  }
  const slipped = results.filter(([, code]) => code === 0).map(([label]) => label);
  assertEquals(slipped, [], `these mistakes were NOT caught: ${slipped.join(", ")}`);
}

Deno.test({
  name: "the generated ApiSchema type-checks a correct consumer and rejects mistakes",
  // Spawns `deno check` a few times — allow the extra time budget.
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const { dir, outDir } = await makeApp({
    "app/api/hello/route.ts": HELLO_ROUTE,
    "app/api/user/[id]/route.ts": USER_ROUTE,
    "app/api/posts/route.ts": POSTS_ROUTE,
    "app/api/files/[...path]/route.ts": FILES_ROUTE,
  });
  try {
    await generateFor(dir, outDir);

    await t.step("a correct consumer type-checks clean", () => stepCorrectConsumer(dir));
    await t.step("rejects every class of mistake", () => stepRejectsEveryMistake(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Runtime: buildPath ─────────────────────────────────────────────────────

Deno.test("buildPath: substitutes params, spans catch-alls, and appends query", () => {
  assertEquals(buildPath("/api/hello"), "/api/hello");
  assertEquals(buildPath("/api/user/[id]", { id: "42" }), "/api/user/42");
  // A value is percent-encoded.
  assertEquals(buildPath("/api/user/[id]", { id: "a b" }), "/api/user/a%20b");
  // A catch-all value keeps its slashes (each segment encoded) — as a string or a string[].
  assertEquals(buildPath("/files/[...path]", { path: "a/b c/d" }), "/files/a/b%20c/d");
  assertEquals(buildPath("/files/[...path]", { path: ["a", "b c", "d"] }), "/files/a/b%20c/d");
  // A typed query: arrays repeat the key, numbers stringify, undefined is skipped.
  assertEquals(
    buildPath("/api/posts", undefined, { page: 2, tag: ["a", "b"], skip: undefined }),
    "/api/posts?page=2&tag=a&tag=b",
  );
  // An optional catch-all substitutes like a catch-all when present.
  assertEquals(buildPath("/docs/[[...slug]]", { slug: "x/y" }), "/docs/x/y");
  // Query params are appended.
  assertEquals(buildPath("/api/hello", undefined, { q: "hi", n: "1" }), "/api/hello?q=hi&n=1");
});

Deno.test("buildPath: throws a clear error when a required param is missing", () => {
  assertThrows(() => buildPath("/api/user/[id]", {}), Error, 'missing param "id"');
});

// ── Runtime: apiRequest / createApiClient ─────────────────────────────────────

/** Boot a tiny handler on an ephemeral port; returns its origin + a closer. */
async function tinyServer(
  handler: (req: Request) => Response | Promise<Response>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => resolve(port) },
    handler,
  );
  const port = await promise;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

Deno.test("apiRequest: GETs and parses JSON, and POSTs a JSON body", async () => {
  const srv = await tinyServer(async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/api/user/7") {
      return Response.json({ id: url.searchParams.get("q") ?? "7" });
    }
    if (req.method === "POST" && url.pathname === "/api/echo") {
      assertEquals(req.headers.get("content-type"), "application/json");
      return Response.json({ youSent: await req.json() }, { status: 201 });
    }
    return new Response("no", { status: 404 });
  });
  try {
    const got = await apiRequest("/api/user/[id]", "GET", {
      params: { id: "7" },
      query: { q: "9" },
    }, srv.origin);
    assertEquals(got, { id: "9" });
    const echoed = await apiRequest("/api/echo", "POST", { body: { a: 1 } }, srv.origin);
    assertEquals(echoed, { youSent: { a: 1 } });
  } finally {
    await srv.close();
  }
});

Deno.test("apiRequest: a 204 yields undefined; a non-2xx throws with method+status", async () => {
  const srv = await tinyServer((req) =>
    new URL(req.url).pathname === "/api/gone"
      ? new Response("nope", { status: 500 })
      : new Response(null, { status: 204 })
  );
  try {
    assertEquals(await apiRequest("/api/empty", "DELETE", {}, srv.origin), undefined);
    let err: Error | null = null;
    try {
      await apiRequest("/api/gone", "GET", {}, srv.origin);
    } catch (e) {
      err = e as Error;
    }
    assert(err, "a 500 should throw");
    assertStringIncludes(err!.message, "500");
    assertStringIncludes(err!.message, "GET");
  } finally {
    await srv.close();
  }
});

Deno.test("apiRequest: a hanging endpoint is bounded by the timeout (does not hang forever)", async () => {
  const ac = new AbortController();
  const { promise, resolve } = Promise.withResolvers<number>();
  // A server that never responds (holds the request open).
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => resolve(port) },
    () => new Promise<Response>(() => {}),
  );
  const port = await promise;
  try {
    await assertRejects(
      () => apiRequest("/api/slow", "GET", { timeoutMs: 150 }, `http://127.0.0.1:${port}`),
    );
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("createApiClient: dispatches through apiRequest with the bound base", async () => {
  const srv = await tinyServer((req) => Response.json({ path: new URL(req.url).pathname }));
  try {
    // deno-lint-ignore no-explicit-any
    const api = createApiClient<any>(srv.origin);
    const res = await api("/api/hello", "GET");
    assertEquals(res, { path: "/api/hello" });
  } finally {
    await srv.close();
  }
});

Deno.test("apiRequest: Date/Map/BigInt bodies and results ride the wire codec; plain JSON is unflagged", async () => {
  let sawHeader: string | null = "unset";
  let sawBody: unknown;
  const srv = await tinyServer(async (req) => {
    sawHeader = req.headers.get("x-denext-wire");
    sawBody = await req.json(); // raw: the server-side decode lives in handleApi
    return json({ at: new Date(0), ids: new Set([1n]), plain: 1 });
  });
  try {
    const got = await apiRequest("/api/x", "POST", {
      body: { when: new Date(5), m: new Map([["k", 1]]) },
    }, srv.origin) as { at: Date; ids: Set<bigint>; plain: number };
    assertEquals(sawHeader, "1", "a tagged body is flagged");
    assertEquals((sawBody as { when: unknown }).when, { $: "D", v: "1970-01-01T00:00:00.005Z" });
    assert(got.at instanceof Date && got.at.getTime() === 0);
    assert(got.ids instanceof Set && got.ids.has(1n));
    assertEquals(got.plain, 1);
    await apiRequest("/api/x", "POST", { body: { hello: "world" } }, srv.origin);
    assertEquals(sawHeader, null, "plain JSON is not flagged");
    assertEquals(sawBody, { hello: "world" });
  } finally {
    await srv.close();
  }
});

Deno.test("apiRequest: a non-2xx with the error envelope throws a typed ApiClientError", async () => {
  const srv = await tinyServer(() =>
    apiErrorResponse(
      new ApiError(409, "conflict", {
        message: "taken",
        data: { id: 7 },
        fieldErrors: { name: "dup" },
      }),
      "req-42",
      "abcdef0123456789",
    )
  );
  try {
    let err: unknown;
    try {
      await apiRequest("/api/x", "POST", { body: {} }, srv.origin);
    } catch (e) {
      err = e;
    }
    assert(isApiClientError(err));
    assert(err instanceof ApiClientError);
    assertEquals([err.status, err.code, err.data], [409, "conflict", { id: 7 }]);
    assertEquals(err.fieldErrors, { name: "dup" });
    assertEquals([err.requestId, err.digest, err.method], ["req-42", "abcdef0123456789", "POST"]);
    assertStringIncludes(err.message, "409 conflict: taken");
  } finally {
    await srv.close();
  }
});

Deno.test("apiRequest: a non-envelope failure (text 500, HTML page, huge body) is `http_error`", async () => {
  const srv = await tinyServer((req) => {
    const p = new URL(req.url).pathname;
    if (p === "/html") {
      return new Response("<h1>oops</h1>", {
        status: 502,
        headers: { "content-type": "text/html" },
      });
    }
    if (p === "/huge") {
      return new Response(JSON.stringify({ error: { code: "x", pad: "y".repeat(70_000) } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("nope", { status: 500 });
  });
  try {
    for (const path of ["/text", "/html", "/huge"]) {
      const err = await apiRequest(path, "GET", {}, srv.origin).catch((e) => e as ApiClientError);
      assert(isApiClientError(err), path);
      assertEquals(err.code, "http_error", path);
      assertEquals(err.data, undefined, path);
    }
  } finally {
    await srv.close();
  }
});

// ── Runtime: in-flight dedupe ──────────────────────────────────────────────────

/** A counting fetch that resolves each call on the next macrotask (so calls overlap). */
function countingFetch(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = ((input: URL | RequestInfo, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Promise<Response>((r) => setTimeout(() => r(Response.json({ n: calls.length })), 5));
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** A small concrete schema so the typed client accepts params/body in the dedupe tests. */
type DedupeSchema = {
  "/api/user/[id]": { GET: { params: { id: string }; response: { n: number } } };
  "/api/x": { GET: { response: unknown }; POST: { body: unknown; response: unknown } };
  "/api/me": { GET: { response: unknown } };
};

/** Pretend to be a browser bundle: hide the server's context bridge for the duration. */
async function asBrowser(fn: () => Promise<void>): Promise<void> {
  const g = globalThis as { __denextCurrentRequestContext?: unknown };
  const bridge = g.__denextCurrentRequestContext;
  delete g.__denextCurrentRequestContext;
  try {
    await fn();
  } finally {
    g.__denextCurrentRequestContext = bridge;
  }
}

Deno.test("createApiClient: concurrent equal GETs share one fetch in the browser; mutations never do", async () => {
  await asBrowser(async () => {
    const { fetch, calls } = countingFetch();
    const api = createApiClient<DedupeSchema>({ fetch, batch: false });
    const [a, b] = await Promise.all([
      api("/api/user/[id]", "GET", { params: { id: "1" }, query: { q: "x" } }),
      api("/api/user/[id]", "GET", { params: { id: "1" }, query: { q: "x" } }),
    ]);
    assertEquals(calls.length, 1, "equal in-flight GETs coalesce");
    assertEquals(a, b);
    // Different inputs (query order does not matter, values do) are different keys.
    await Promise.all([
      api("/api/user/[id]", "GET", { params: { id: "1" }, query: { q: "y" } }),
      api("/api/user/[id]", "GET", { params: { id: "1" }, headers: { authorization: "t" } }),
    ]);
    assertEquals(calls.length, 3, "a different query or header is a different request");
    // Once settled, the entry is gone: a later equal call fetches again.
    await api("/api/user/[id]", "GET", { params: { id: "1" }, query: { q: "x" } });
    assertEquals(calls.length, 4);
    // Mutations are never deduped; `dedupe: false` opts a read out.
    await Promise.all([api("/api/x", "POST", { body: {} }), api("/api/x", "POST", { body: {} })]);
    assertEquals(calls.length, 6);
    await Promise.all([
      api("/api/x", "GET", { dedupe: false }),
      api("/api/x", "GET", { dedupe: false }),
    ]);
    assertEquals(calls.length, 8);
    const off = createApiClient<DedupeSchema>({ fetch, dedupe: false, batch: false });
    await Promise.all([off("/api/x", "GET"), off("/api/x", "GET")]);
    assertEquals(calls.length, 10);
  });
});

Deno.test("createApiClient: on the server, dedupe is per request context and off outside one", async () => {
  const { fetch, calls } = countingFetch();
  const api = createApiClient<DedupeSchema>({ fetch, batch: false });
  const ctxA = createRequestContext(new Request("http://localhost/a"));
  const ctxB = createRequestContext(new Request("http://localhost/b"));
  // Two users' requests, interleaved, each calling the same endpoint twice.
  await Promise.all([
    runWithContext(ctxA, () => Promise.all([api("/api/me", "GET"), api("/api/me", "GET")])),
    runWithContext(ctxB, () => Promise.all([api("/api/me", "GET"), api("/api/me", "GET")])),
  ]);
  assertEquals(calls.length, 2, "one fetch per request context — never shared across users");
  // Outside any request context a shared module-level client must not coalesce.
  await Promise.all([api("/api/me", "GET"), api("/api/me", "GET")]);
  assertEquals(calls.length, 4);
});

// ── Runtime: batching (client) ────────────────────────────────────────────────

/** A `fetch` over a createApp handler that adds what a browser would (Origin/Host) and logs calls. */
function appFetch(
  app: (req: Request) => Promise<Response>,
  opts: { origin?: boolean } = {},
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = ((input: URL | RequestInfo, init?: RequestInit) => {
    const req = new Request(new URL(String(input), ORIGIN), init);
    calls.push(`${req.method} ${new URL(req.url).pathname}`);
    const headers = new Headers(req.headers);
    headers.set("host", "localhost");
    if (opts.origin !== false) headers.set("origin", ORIGIN);
    return app(new Request(req, { headers }));
  }) as typeof fetch;
  return { fetch: impl, calls };
}

type BatchSchema = {
  "/api/hello": { GET: { response: { hello: string } } };
  "/api/when": { GET: { response: { at: Date } } };
  "/api/boom": { GET: { response: unknown; errors: "conflict" } };
  "/api/nope": { GET: { response: unknown } };
  "/api/echo": { GET: { response: { q: string } } };
  "/api/x": { POST: { body: unknown; response: unknown } };
};

Deno.test("createApiClient: concurrent GETs in one tick ride one batch POST; each settles on its own", async () => {
  await asBrowser(async () => {
    const { fetch, calls } = appFetch(batchApp());
    const api = createApiClient<BatchSchema>({ fetch });
    const [hello, when, boom, nope] = await Promise.allSettled([
      api("/api/hello", "GET"),
      api("/api/when", "GET"),
      api("/api/boom", "GET"),
      api("/api/nope", "GET"),
    ]);
    assertEquals(calls, [`POST ${API_BATCH_PATH}`], "exactly one request for four calls");
    assertEquals(hello.status, "fulfilled");
    assertEquals((hello as PromiseFulfilledResult<{ hello: string }>).value.hello, "world");
    // A codec-tagged item is decoded through the same path as a direct response.
    assert((when as PromiseFulfilledResult<{ at: Date }>).value.at instanceof Date);
    // A typed error item is the same ApiClientError a direct call would throw.
    assertEquals(boom.status, "rejected");
    const err = (boom as PromiseRejectedResult).reason as ApiClientError;
    assert(isApiClientError(err));
    assertEquals([err.status, err.code, err.message.includes("conflict")], [409, "conflict", true]);
    const nf = (nope as PromiseRejectedResult).reason as ApiClientError;
    assertEquals([nf.status, nf.code], [404, "not_found"]);
  });
});

Deno.test("createApiClient: a single call, a mutation, custom headers, or batch:false go alone", async () => {
  await asBrowser(async () => {
    const { fetch, calls } = appFetch(batchApp());
    const api = createApiClient<BatchSchema>({ fetch });
    await api("/api/hello", "GET"); // alone in its tick → plain GET, no batch framing
    assertEquals(calls, ["GET /api/hello"]);
    calls.length = 0;
    await Promise.allSettled([
      api("/api/hello", "GET", { batch: false }),
      api("/api/hello", "GET", { headers: { "x-extra": "1" } }),
      api("/api/x", "POST", { body: { a: 1 } }),
    ]);
    assertEquals(calls.sort(), ["GET /api/hello", "GET /api/hello", "POST /api/x"]);
    calls.length = 0;
    const off = createApiClient<BatchSchema>({ fetch, batch: false });
    await Promise.allSettled([off("/api/hello", "GET"), off("/api/echo", "GET")]);
    assertEquals(calls.sort(), ["GET /api/echo", "GET /api/hello"]);
  });
});

Deno.test("createApiClient: batches chunk by maxItems and compose with dedupe", async () => {
  await asBrowser(async () => {
    const { fetch, calls } = appFetch(batchApp());
    const api = createApiClient<BatchSchema>({ fetch, batch: { maxItems: 2 } });
    await Promise.allSettled([
      api("/api/hello", "GET"),
      api("/api/hello", "GET"), // deduped into the first
      api("/api/echo", "GET", { query: { a: "1" } }),
      api("/api/echo", "GET", { query: { a: "2" } }),
    ]);
    // 3 distinct requests, chunked 2 + 1: two batch POSTs.
    assertEquals(calls, [`POST ${API_BATCH_PATH}`, `POST ${API_BATCH_PATH}`]);
  });
});

Deno.test("createApiClient: an aborted item rejects alone; a batch-level failure fails every item", async () => {
  await asBrowser(async () => {
    const { fetch } = appFetch(batchApp());
    const api = createApiClient<BatchSchema>({ fetch });
    const ac = new AbortController();
    ac.abort();
    const [aborted, fine] = await Promise.allSettled([
      api("/api/hello", "GET", { signal: ac.signal }),
      api("/api/echo", "GET"),
    ]);
    assertEquals(aborted.status, "rejected");
    assertEquals(fine.status, "fulfilled");
    // No Origin header → the batch itself is a 403 → every item is an http_error with that status.
    const cross = appFetch(batchApp(), { origin: false });
    const api2 = createApiClient<BatchSchema>({ fetch: cross.fetch });
    const results = await Promise.allSettled([api2("/api/hello", "GET"), api2("/api/echo", "GET")]);
    for (const r of results) {
      assertEquals(r.status, "rejected");
      const e = (r as PromiseRejectedResult).reason as ApiClientError;
      assertEquals([e.status, e.code], [403, "http_error"]);
    }
  });
});
