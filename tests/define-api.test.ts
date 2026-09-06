// defineApi / createApi().use(): schema-validated route handlers, driven directly (the handler
// is a plain ApiHandler) and through handleApi for the error mapping. A hand-rolled Standard
// Schema stands in for Zod/Valibot so the test has zero dependencies.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { apiDefinitionOf, createApi, defineApi } from "../src/server/define-api.ts";
import { rateLimit, requireSession } from "../src/server/api-middleware.ts";
import { ApiError, isApiError } from "../src/server/api-error.ts";
import { handleApi } from "../src/server/api.ts";
import { asyncProps } from "../src/runtime/async-props.ts";
import type { StandardSchemaV1 } from "../src/runtime/define-action.ts";
import type { ApiModule } from "../src/server/types.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { ApiMatch } from "../src/router/match.ts";
import { inMemoryRateLimitStore } from "../src/server/auth/rate-limit.ts";
import { unauthorized } from "../src/runtime/error-boundary.ts";

/** A minimal Standard Schema: an object whose listed keys must be strings; extra keys are STRIPPED. */
function strings<K extends string>(...keys: K[]): StandardSchemaV1<Record<K, string>> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(value) {
        const issues: { message: string; path: string[] }[] = [];
        const out: Record<string, string> = {};
        const obj = (value ?? {}) as Record<string, unknown>;
        for (const k of keys) {
          if (typeof obj[k] !== "string") {
            issues.push({ message: `${k} must be a string`, path: [k] });
          } else out[k] = obj[k] as string;
        }
        return issues.length ? { issues } : { value: out as Record<K, string> };
      },
    },
  };
}

/** Await a handler and return what it THREW (an ApiError / control signal), or undefined. */
async function rejects(p: Response | Promise<Response>): Promise<ApiError & { name: string }> {
  try {
    await p;
    throw new Error("expected the handler to throw");
  } catch (e) {
    return e as ApiError & { name: string };
  }
}

const ctx = (params: Record<string, string> = {}) => ({ params: asyncProps({ ...params }) });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x?tag=a&tag=b&page=2", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

Deno.test("defineApi: parsed params/query/body reach the handler; the return value is JSON", async () => {
  const POST = defineApi({
    params: strings("id"),
    body: strings("title"),
  }, ({ params, query, body, request }) => ({
    id: params.id,
    title: body.title,
    tags: query.tag,
    page: query.page,
    method: request.method,
  }));
  const res = await POST(post({ title: "Hi", extra: "stripped" }), ctx({ id: "7" }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    id: "7",
    title: "Hi",
    tags: ["a", "b"],
    page: "2",
    method: "POST",
  });
});

Deno.test("defineApi: undefined → 204; a returned Response passes through", async () => {
  const del = defineApi({}, () => undefined);
  assertEquals((await del(post({}), ctx())).status, 204);
  const raw = defineApi({}, () => new Response("raw", { status: 202 }));
  const res = await raw(post({}), ctx());
  assertEquals([res.status, await res.text()], [202, "raw"]);
});

Deno.test("defineApi: the response schema always runs and strips undeclared keys (data-leak guard)", async () => {
  const GET = defineApi(
    { response: strings("name") },
    () => ({ name: "Ada", passwordHash: "secret" }),
  );
  const body = await (await GET(post({}), ctx())).text();
  assertEquals(JSON.parse(body), { name: "Ada" });
  assert(!body.includes("secret"));
});

Deno.test("defineApi: a response that fails its schema is a server error, not a client error", async () => {
  const GET = defineApi({ response: strings("name") }, () => ({ name: 42 }) as never);
  let thrown: unknown;
  try {
    await GET(post({}), ctx());
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof Error && !isApiError(thrown));
  assertStringIncludes(thrown.message, "response failed validation");
});

Deno.test("defineApi: validation failures throw ApiValidationError with field errors + source", async () => {
  const POST = defineApi({ params: strings("id"), body: strings("title") }, () => "unreachable");
  const bad = await rejects(POST(post({ title: 5 }), ctx({ id: "1" })));
  assert(isApiError(bad));
  assertEquals([bad.status, bad.code], [400, "validation"]);
  assertEquals(bad.fieldErrors, { title: "title must be a string" });
  assertEquals(bad.data, { source: "body" });
  const badParams = await rejects(POST(post({ title: "ok" }), ctx({})));
  assertEquals(badParams.data, { source: "params" });
});

Deno.test("defineApi: a body schema requires a JSON content-type and well-formed JSON", async () => {
  const POST = defineApi({ body: strings("title") }, () => "unreachable");
  const text = await rejects(POST(post({ title: "x" }, { "content-type": "text/plain" }), ctx()));
  assertEquals([text.status, text.code], [400, "bad_request"]);
  const malformed = await rejects(POST(post("{not json"), ctx()));
  assertEquals([malformed.status, malformed.code], [400, "bad_request"]);
  assertStringIncludes(malformed.message, "malformed");
});

Deno.test("defineApi: fail(code) throws the declared status and default message", async () => {
  const GET = defineApi({
    errors: { not_owner: 403, gone: { status: 410, message: "that post was deleted" } },
  }, ({ fail }) => {
    fail("gone");
  });
  const err = await rejects(GET(post({}), ctx()));
  assert(isApiError(err));
  assertEquals([err.status, err.code, err.message], [410, "gone", "that post was deleted"]);
  const GET2 = defineApi(
    { errors: { not_owner: 403 } },
    ({ fail }) => fail("not_owner", { data: { id: 1 } }),
  );
  const err2 = await rejects(GET2(post({}), ctx()));
  assertEquals([err2.status, err2.message, err2.data], [403, "not_owner", { id: 1 }]);
});

Deno.test("createApi().use(): middleware accumulates typed context, can short-circuit, and can throw", async () => {
  const order: string[] = [];
  const api = createApi()
    .use(() => {
      order.push("a");
      return { user: "ada" };
    })
    .use(({ ctx }) => {
      order.push("b:" + ctx.user);
      return { role: "admin" as const };
    });
  const GET = api.define({}, ({ ctx }) => `${ctx.user}/${ctx.role}`);
  assertEquals(await (await GET(post({}), ctx())).json(), "ada/admin");
  assertEquals(order, ["a", "b:ada"]);

  let validated = false;
  const gated = createApi()
    .use(() => new Response("nope", { status: 418 }))
    .define({ body: strings("title") }, () => {
      validated = true;
      return "unreachable";
    });
  const short = await gated(post({ title: 1 }), ctx());
  assertEquals([short.status, await short.text()], [418, "nope"]);
  assertEquals(validated, false, "a short-circuit runs before validation");

  const thrower = createApi().use(() => unauthorized()).define({}, () => "unreachable");
  const err = await rejects(thrower(post({}), ctx()));
  assertEquals(err?.name, "UnauthorizedError");
});

Deno.test("apiDefinitionOf: exposes the definition + chain for a defined handler, undefined otherwise", () => {
  const mw = () => ({});
  const GET = createApi().use(mw).define({ summary: "list" }, () => []);
  const meta = apiDefinitionOf(GET);
  assertEquals(meta?.def.summary, "list");
  assertEquals(meta?.middleware, [mw]);
  assertEquals(apiDefinitionOf(() => new Response()), undefined);
  assertEquals(apiDefinitionOf("nope"), undefined);
});

Deno.test("requireSession: without a signed-in viewer it fails 401 before validation", async () => {
  let validated = false;
  const GET = createApi().use(requireSession({ message: "sign in first" })).define(
    { body: strings("title") },
    () => {
      validated = true;
      return "unreachable";
    },
  );
  const err = await rejects(GET(post({ title: 1 }), ctx()));
  assert(isApiError(err));
  assertEquals([err.status, err.code, err.message], [401, "unauthorized", "sign in first"]);
  assertEquals(validated, false);
});

Deno.test("rateLimit: the (max+1)th request in a window is a 429 with retry-after; forged XFF is ignored", async () => {
  const store = inMemoryRateLimitStore();
  const GET = createApi().use(rateLimit({ max: 2, windowMs: 60_000, store })).define(
    {},
    () => "ok",
  );
  const spoof = (ip: string) =>
    new Request("http://localhost/api/x", { headers: { "x-forwarded-for": ip } });
  assertEquals((await GET(spoof("1.1.1.1"), ctx())).status, 200);
  assertEquals((await GET(spoof("2.2.2.2"), ctx())).status, 200);
  // Third call: a different forged header must NOT open a fresh bucket (untrusted → socket peer).
  const err = await rejects(GET(spoof("3.3.3.3"), ctx()));
  assert(isApiError(err));
  assertEquals([err.status, err.code], [429, "rate_limited"]);
  const retry = Number(new Headers(err.headers).get("retry-after"));
  assert(retry >= 1 && retry <= 60);
  assertEquals(err.data, { retryAfter: retry });
});

Deno.test("rateLimit: with trustForwardedHeaders the LAST x-forwarded-for hop is the key", async () => {
  const store = inMemoryRateLimitStore();
  const GET = createApi()
    .use(rateLimit({ max: 1, windowMs: 60_000, store, trustForwardedHeaders: true }))
    .define({}, () => "ok");
  const req = (xff: string) =>
    new Request("http://localhost/api/x", { headers: { "x-forwarded-for": xff } });
  assertEquals((await GET(req("evil, 9.9.9.9"), ctx())).status, 200);
  // Same proxy-appended hop, different client-supplied first hop → same bucket → limited.
  const err = await rejects(GET(req("other, 9.9.9.9"), ctx()));
  assertEquals(err.status, 429);
  // A different last hop is a different client.
  assertEquals((await GET(req("evil, 8.8.8.8"), ctx())).status, 200);
});

// --- through handleApi: the redacted-500 path for DEFINED routes -----------------

function viaHandleApi(mod: ApiModule, request: Request): Promise<Response> {
  const match: ApiMatch = {
    route: {
      kind: "api",
      filePath: "route.ts",
      pattern: parsePattern("/api/x"),
      routePath: "/api/x",
    },
    params: {},
  };
  return handleApi(match, request, () => Promise.resolve(mod), {});
}

Deno.test("handleApi: an unknown throw in a defineApi route is a redacted JSON 500 in prod, real in dev", async () => {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  const errors = console.error;
  console.error = () => {};
  try {
    const GET = defineApi({}, () => {
      throw new Error("db password = hunter2");
    });
    g.__denextDev = false;
    const prod = await viaHandleApi({ GET }, new Request("http://localhost/api/x"));
    assertEquals(prod.status, 500);
    const body = await prod.json();
    assertEquals(body.error.code, "internal");
    assertEquals(body.error.message, "Internal Server Error");
    assert(typeof body.error.digest === "string" && body.error.digest.length === 16);
    g.__denextDev = true;
    const dev = await viaHandleApi({ GET }, new Request("http://localhost/api/x"));
    assertEquals((await dev.json()).error.message, "db password = hunter2");
  } finally {
    g.__denextDev = prev;
    console.error = errors;
  }
});

Deno.test("handleApi: a defineApi `maxBodyBytes` overrides the module and app caps", async () => {
  const POST = defineApi({ body: strings("t"), maxBodyBytes: 8 }, ({ body }) => body.t);
  const small = await viaHandleApi({ POST }, post({ t: "x" }));
  assertEquals(small.status, 413); // 8 bytes is smaller than `{"t":"x"}`
  const lifted = defineApi({ body: strings("t"), maxBodyBytes: false }, ({ body }) => body.t);
  const big = await viaHandleApi({ POST: lifted }, post({ t: "y".repeat(2 * 1024 * 1024) }));
  assertEquals(big.status, 200);
});

Deno.test("handleApi: an ApiError from defineApi middleware is its envelope", async () => {
  const GET = createApi().use(() => {
    throw new ApiError(402, "payment_required", { message: "pay up" });
  }).define({}, () => "unreachable");
  const res = await viaHandleApi({ GET }, new Request("http://localhost/api/x"));
  assertEquals(res.status, 402);
  assertEquals((await res.json()).error, {
    code: "payment_required",
    status: 402,
    message: "pay up",
  });
});

Deno.test("defineApi: a codec-flagged body is decoded before the schema sees it", async () => {
  const isDate: StandardSchemaV1<{ when: Date }> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v) =>
        (v as { when?: unknown })?.when instanceof Date
          ? { value: v as { when: Date } }
          : { issues: [{ message: "when must be a Date", path: ["when"] }] },
    },
  };
  const POST = defineApi({ body: isDate }, ({ body }) => body.when.getTime());
  const res = await POST(
    post({ when: { $: "D", v: "1970-01-01T00:00:00.005Z" } }, { "x-denext-wire": "1" }),
    ctx(),
  );
  assertEquals([res.status, await res.json()], [200, 5]);
  // Unflagged, the same JSON is a plain object → the schema rejects it.
  const plain = await rejects(POST(post({ when: { $: "D", v: "x" } }), ctx()));
  assertEquals([plain.status, plain.code], [400, "validation"]);
});
