// The typed-API batch endpoint (src/server/api-batch-handler.ts + src/server/sub-request.ts),
// driven through createApp so every item takes the REAL pipeline — middleware included.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ApiModule } from "../src/server/types.ts";
import { API_BATCH_HEADER, API_BATCH_PATH } from "../src/runtime/api-batch-protocol.ts";
import { batchApp, ORIGIN } from "./helpers/batch-app.ts";

/** A well-formed batch POST (same-origin, marker, JSON) with `items`. */
function batchRequest(items: unknown, headers: Record<string, string> = {}, body?: string) {
  return new Request(`${ORIGIN}${API_BATCH_PATH}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "localhost",
      cookie: "session=abc",
      "content-type": "application/json",
      [API_BATCH_HEADER]: "1",
      ...headers,
    },
    body: body ?? JSON.stringify({ v: 1, items }),
  });
}

Deno.test("api batch: runs GET/HEAD items through the pipeline and returns each result", async () => {
  const app = batchApp();
  const res = await app(batchRequest([
    { id: 0, m: "GET", p: "/api/hello" },
    { id: 1, m: "GET", p: "/api/when" },
    { id: 2, m: "GET", p: "/api/boom" },
    { id: 3, m: "GET", p: "/api/nope" },
    { id: 4, m: "HEAD", p: "/api/hello" },
    { id: 5, m: "GET", p: "/api/echo?x=1&x=2" },
  ]));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-store");
  const { v, r } = await res.json();
  assertEquals(v, 1);
  assertEquals(r.length, 6);
  const byId = Object.fromEntries(r.map((x: { id: number }) => [x.id, x]));
  // A JSON item: raw text body + the header subset; the item's x-request-id is suffixed.
  assertEquals(byId[0].s, 200);
  const hello = JSON.parse(byId[0].t);
  assertEquals(hello.hello, "world");
  assert(String(hello.id).endsWith("#0"), `item request id is suffixed: ${hello.id}`);
  assertStringIncludes(byId[0].h["content-type"], "application/json");
  // A codec-tagged item carries `enc: 1` and the raw tagged text (decoded by the client).
  assertEquals(byId[1].enc, 1);
  assertEquals(JSON.parse(byId[1].t), { at: { $: "D", v: "1970-01-01T00:00:00.000Z" } });
  // A typed error is an ordinary result with the envelope as its text.
  assertEquals(byId[2].s, 409);
  assertEquals(JSON.parse(byId[2].t).error.code, "conflict");
  // An unmatched API path is a JSON 404 (never a page).
  assertEquals(byId[3].s, 404);
  assertEquals(JSON.parse(byId[3].t).error.code, "not_found");
  // HEAD: status, no body.
  assertEquals([byId[4].s, byId[4].t], [200, undefined]);
  // The query string and the batch's cookie reach the item.
  assertEquals(JSON.parse(byId[5].t), { q: "?x=1&x=2", cookie: "session=abc" });
});

Deno.test("api batch: refuses cross-origin, missing marker, wrong content-type, and nested batches", async () => {
  const app = batchApp();
  const items = [{ id: 0, m: "GET", p: "/api/hello" }];
  const noOrigin = new Request(`${ORIGIN}${API_BATCH_PATH}`, {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", [API_BATCH_HEADER]: "1" },
    body: JSON.stringify({ v: 1, items }),
  });
  assertEquals((await app(noOrigin)).status, 403);
  const cross = await app(batchRequest(items, { origin: "http://evil.example" }));
  assertEquals(cross.status, 403);
  const noMarker = await app(batchRequest(items, { [API_BATCH_HEADER]: "" }));
  assertEquals(noMarker.status, 400);
  const notJson = await app(batchRequest(items, { "content-type": "text/plain" }));
  assertEquals(notJson.status, 415);
  // A request carrying the sub-request marker never reaches the batch handler at all: the
  // pipeline treats it as API-only, so `/_denext/api-batch` is simply not a route for it.
  const nested = await app(batchRequest(items, { "x-denext-batch-item": "1" }));
  assertEquals(nested.status, 404);
  assertEquals((await nested.json()).error.code, "not_found");
});

Deno.test("api batch: a malformed batch or item fails the WHOLE batch (nothing runs)", async () => {
  let ran = 0;
  const app = batchApp({
    load: (_fp: string) =>
      Promise.resolve(
        {
          GET: () => {
            ran++;
            return new Response("x");
          },
        } satisfies ApiModule as unknown as Record<string, unknown>,
      ),
  });
  const bad: unknown[] = [
    [{ id: 0, m: "POST", p: "/api/hello" }], // mutations never batch
    [{ id: 0, m: "GET", p: "//evil.example/x" }], // protocol-relative escape
    [{ id: 0, m: "GET", p: "http://evil.example/x" }], // absolute URL
    [{ id: 0, m: "GET", p: "/_denext/action/abc" }], // reserved endpoints
    [{ id: 0, m: "GET", p: "/api/hello" }, { id: 0, m: "GET", p: "/api/hello" }], // dup id
    [{ id: 1.5, m: "GET", p: "/api/hello" }], // non-integer id
    [{ id: 0, m: "GET", p: "x".repeat(3000) }], // too long
    [], // empty
    Array.from({ length: 21 }, (_, i) => ({ id: i, m: "GET", p: "/api/hello" })), // > maxItems
  ];
  for (const items of bad) {
    const res = await app(batchRequest(items));
    assertEquals(res.status, 400, JSON.stringify(items).slice(0, 60));
  }
  assertEquals((await app(batchRequest(null, {}, "{not json"))).status, 400);
  assertEquals(
    (await app(batchRequest(null, {}, JSON.stringify({ v: 2, items: [] })))).status,
    400,
  );
  assertEquals(ran, 0, "no item may run when any item is malformed");
});

Deno.test("api batch: a declared over-cap body is a 413", async () => {
  const app = batchApp({ apiBatch: { maxBodyBytes: 32 } });
  const body = JSON.stringify({ v: 1, items: [{ id: 0, m: "GET", p: "/api/hello" }] });
  const res = await app(batchRequest(null, { "content-length": String(body.length) }, body));
  assertEquals(res.status, 413);
});

Deno.test("api batch: an aggregate response budget bounds the whole batch; an explicit `undefined` keeps a cap", async () => {
  // `{"secret":true}` is 15 bytes: the first item fits a 20-byte budget, the second does not.
  const app = batchApp({ apiBatch: { maxTotalResponseBytes: 20 } });
  const res = await app(batchRequest([
    { id: 0, m: "GET", p: "/api/secret" },
    { id: 1, m: "GET", p: "/api/secret" },
  ]));
  const { r } = await res.json();
  const byId = Object.fromEntries(r.map((x: { id: number }) => [x.id, x]));
  const over = [byId[0], byId[1]].filter((x) => x.s === 500 && x.t === "response too large");
  assertEquals(over.length, 1, "exactly one item exceeded the shared budget");
  // A config that spells a cap out as `undefined` must not lift it (object spread would).
  const loose = batchApp({ apiBatch: { maxItems: undefined } });
  const many = Array.from({ length: 21 }, (_, i) => ({ id: i, m: "GET", p: "/api/hello" }));
  assertEquals((await loose(batchRequest(many))).status, 400);
});

Deno.test("api batch: concurrent batches share one gate per app — overflow is a 503 item, nothing is lost", async () => {
  // concurrency 1, maxItems 1 → 1 slot + 4 waiters; 8 simultaneous single-item batches overflow.
  const app = batchApp({ apiBatch: { concurrency: 1, maxItems: 1 } });
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => app(batchRequest([{ id: 0, m: "GET", p: "/api/slow" }]))),
  );
  const results = await Promise.all(responses.map(async (r) => {
    assertEquals(r.status, 200, "the batch itself always answers");
    return (await r.json()).r[0] as { s: number; t?: string };
  }));
  const ok = results.filter((r) => r.s === 200).length;
  const shed = results.filter((r) => r.s === 503 && r.t === "overloaded").length;
  assertEquals(ok + shed, 8, "every item settled");
  assert(shed >= 1, "the shared gate shed at least one item");
  assert(ok >= 5, "the slot + waiters were all served");
});

Deno.test("api batch: `enabled: false` hides the endpoint", async () => {
  const app = batchApp({ apiBatch: { enabled: false } });
  assertEquals((await app(batchRequest([{ id: 0, m: "GET", p: "/api/hello" }]))).status, 404);
});

Deno.test("api batch: middleware on /api/* applies to every item exactly as to a direct call", async () => {
  const mw = (req: Request) => {
    if (new URL(req.url).pathname === "/api/secret" && !req.headers.get("authorization")) {
      return new Response("nope", { status: 401 });
    }
  };
  const app = batchApp({}, mw);
  const res = await app(batchRequest([
    { id: 0, m: "GET", p: "/api/secret" },
    { id: 1, m: "GET", p: "/api/hello" },
  ]));
  const { r } = await res.json();
  assertEquals(r.find((x: { id: number }) => x.id === 0).s, 401, "middleware guarded the item");
  assertEquals(r.find((x: { id: number }) => x.id === 1).s, 200);
  // A page path inside a batch is API-only: JSON 404, never an HTML render.
  const page = await app(batchRequest([{ id: 0, m: "GET", p: "/" }]));
  const pr = (await page.json()).r[0];
  assertEquals(pr.s, 404);
  assertStringIncludes(pr.h["content-type"], "application/json");
});

Deno.test("api batch: item Set-Cookies merge onto the batch response; a crashing item is a redacted 500 item", async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    const app = batchApp();
    const res = await app(batchRequest([
      { id: 0, m: "GET", p: "/api/cookie" },
      { id: 1, m: "GET", p: "/api/crash" },
    ]));
    assertEquals(res.status, 200);
    assertEquals(res.headers.getSetCookie(), ["seen=1; Path=/"]);
    const { r } = await res.json();
    const crash = r.find((x: { id: number }) => x.id === 1);
    assertEquals(crash.s, 500);
    assert(!JSON.stringify(crash).includes("hunter2"), "a plain handler's throw stays redacted");
    assert(crash.h["x-request-id"], "a 500 item still carries its correlation id");
  } finally {
    console.error = errors;
  }
});
