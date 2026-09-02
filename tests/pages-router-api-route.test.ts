// Coverage for @denext/pages-router's API-route adapter (`runApiRoute`), which maps a Web
// `Request` onto Next's imperative `(req, res)` handler contract and collects the `res`
// calls into a `Response`. Drives the public function directly with representative
// handlers — buffered + streaming, body parsing, multipart, redirects, and error paths.

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ApiModule,
  type ApiRequest,
  type ApiResponse,
  runApiRoute,
} from "../packages/pages-router/src/api.ts";

const NO_PARAMS: Record<string, string> = {};

/** Invoke a handler as an API route and return its Response. */
function call(
  handler: (req: ApiRequest, res: ApiResponse) => unknown,
  request: Request,
  config?: ApiModule["config"],
  params: Record<string, string> = NO_PARAMS,
): Promise<Response> {
  const mod: ApiModule = { default: handler, config };
  return runApiRoute(mod, request, params, new URL(request.url));
}

Deno.test("runApiRoute: 500 when the module has no default export", async () => {
  const res = await runApiRoute(
    { default: undefined as unknown as ApiModule["default"] },
    new Request("http://x/api/x"),
    NO_PARAMS,
    new URL("http://x/api/x"),
  );
  assertEquals(res.status, 500);
  assertStringIncludes(await res.text(), "no default export");
});

Deno.test("runApiRoute: JSON handler — status, body, content-type, query, cookies, headers", async () => {
  const res = await call(
    (req, res) => {
      // Route params + search params merge into query; cookies + headers parsed.
      res.setHeader("x-custom", "1");
      res.status(201).json({
        method: req.method,
        id: req.query.id,
        q: req.query.q,
        cookie: req.cookies.session,
        ua: req.headers["x-agent"],
      });
    },
    new Request("http://x/api/item?q=hi", {
      headers: { cookie: "session=abc", "x-agent": "test" },
    }),
    undefined,
    { id: "42" },
  );
  assertEquals(res.status, 201);
  assertEquals(res.headers.get("x-custom"), "1");
  assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
  const body = await res.json();
  assertEquals(body, { method: "GET", id: "42", q: "hi", cookie: "abc", ua: "test" });
});

Deno.test("runApiRoute: parses a JSON request body on POST", async () => {
  const res = await call(
    (req, res) => res.json({ got: req.body }),
    new Request("http://x/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    }),
  );
  assertEquals((await res.json()).got, { hello: "world" });
});

Deno.test("runApiRoute: parses urlencoded and multipart form bodies", async () => {
  const urlenc = await call(
    (req, res) => res.json(req.body),
    new Request("http://x/api/form", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&b=two",
    }),
  );
  assertEquals(await urlenc.json(), { a: "1", b: "two" });

  const fd = new FormData();
  fd.set("name", "ada");
  const multipart = await call(
    (req, res) => res.json({ name: (req.body as Record<string, unknown>)?.name }),
    new Request("http://x/api/upload", { method: "POST", body: fd }),
  );
  assertEquals((await multipart.json()).name, "ada");
});

Deno.test("runApiRoute: send/end/getHeader and a text response", async () => {
  const res = await call((_req, res) => {
    res.setHeader("content-type", "text/plain");
    assertEquals(res.getHeader("content-type"), "text/plain");
    res.status(200).send("plain text");
  }, new Request("http://x/api/text"));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "plain text");
});

Deno.test("runApiRoute: res.redirect with a url, and with an explicit status", async () => {
  const a = await call((_req, res) => res.redirect("/login"), new Request("http://x/api/r"));
  assertEquals(a.status, 307);
  assertEquals(a.headers.get("location"), "/login");

  const b = await call(
    (_req, res) => res.redirect(301, "/perm"),
    new Request("http://x/api/r"),
  );
  assertEquals(b.status, 301);
  assertEquals(b.headers.get("location"), "/perm");
});

Deno.test("runApiRoute: a streaming handler (res.write) returns a streamed body", async () => {
  const res = await call((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: one\n\n");
    res.write("data: two\n\n");
    res.end();
  }, new Request("http://x/api/stream"));
  assertEquals(res.status, 200);
  const text = await res.text();
  assertStringIncludes(text, "data: one");
  assertStringIncludes(text, "data: two");
});

Deno.test("runApiRoute: an unhandled throw before output surfaces a 500", async () => {
  const res = await call(() => {
    throw new Error("boom");
  }, new Request("http://x/api/boom"));
  assertEquals(res.status, 500);
  assertStringIncludes(await res.text(), "Internal Server Error");
});

Deno.test("runApiRoute: a handler that sets a >= 400 status keeps it", async () => {
  const res = await call((_req, res) => {
    res.status(422).json({ error: "unprocessable" });
  }, new Request("http://x/api/bad"));
  assertEquals(res.status, 422);
  assertEquals((await res.json()).error, "unprocessable");
});

Deno.test("runApiRoute: bodyParser sizeLimit rejects an oversized body with 413", async () => {
  const big = "x".repeat(2000);
  const res = await call(
    (req, res) => res.json({ len: String(req.body).length }),
    new Request("http://x/api/big", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: big,
    }),
    { api: { bodyParser: { sizeLimit: "1kb" } } },
  );
  assertEquals(res.status, 413);
});

Deno.test("runApiRoute: bodyParser:false hands back the raw bytes (webhook signatures)", async () => {
  const res = await call(
    (req, res) => {
      // Raw, unparsed bytes — decode them ourselves to prove nothing pre-parsed them.
      const raw = req.body as Uint8Array;
      res.json({ isBytes: raw instanceof Uint8Array, text: new TextDecoder().decode(raw) });
    },
    new Request("http://x/api/raw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    }),
    { api: { bodyParser: false } },
  );
  const body = await res.json();
  assertEquals(body.isBytes, true);
  assertEquals(body.text, '{"a":1}');
});
