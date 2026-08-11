import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  actionEndpoint,
  decodeActionArgs,
  encodeActionArgs,
  isServerAction,
  serverAction,
} from "../src/runtime/server-action.ts";
import { handleAction } from "../src/server/action-handler.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";
import { redirect } from "../src/runtime/error-boundary.ts";
import { clientOnly, isServer, serverOnly } from "../src/runtime/environment.ts";

// In Deno (no `document`), serverAction registers + runs the handler directly.

function actionRequest(
  id: string,
  init: { headers?: Record<string, string>; body?: BodyInit; json?: unknown } = {},
): Request {
  const headers: Record<string, string> = {
    host: "localhost",
    ...init.headers,
  };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  return new Request(`http://localhost${actionEndpoint(id)}`, {
    method: "POST",
    headers,
    body,
  });
}

/** Run handleAction inside a request context, like the app does. */
function dispatch(
  request: Request,
  opts?: Parameters<typeof handleAction>[1],
): Promise<Response> {
  return runWithContext(
    createRequestContext(request),
    () => handleAction(request, opts),
  );
}

// ---- SECURITY: CSRF / same-origin -----------------------------------------

Deno.test("action rejects a cross-origin Origin (CSRF)", async () => {
  serverAction("sec_a", () => "ok");
  const res = await dispatch(actionRequest("sec_a", {
    headers: { origin: "http://evil.example", "x-denext-action": "1" },
    json: { args: [] },
  }));
  assertEquals(res.status, 403);
});

Deno.test("action rejects when neither Origin nor Referer is present", async () => {
  serverAction("sec_b", () => "ok");
  const res = await dispatch(actionRequest("sec_b", {
    headers: { "x-denext-action": "1" },
    json: { args: [] },
  }));
  assertEquals(res.status, 403);
});

Deno.test("action accepts a same-origin Origin", async () => {
  serverAction("sec_c", () => "ok");
  const res = await dispatch(actionRequest("sec_c", {
    headers: { origin: "http://localhost", "x-denext-action": "1" },
    json: { args: [] },
  }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).result, "ok");
});

Deno.test("action accepts a same-origin Referer when Origin is absent", async () => {
  serverAction("sec_d", () => "ok");
  const res = await dispatch(actionRequest("sec_d", {
    headers: { referer: "http://localhost/page", "x-denext-action": "1" },
    json: { args: [] },
  }));
  assertEquals(res.status, 200);
});

Deno.test("action rejects an http Origin for an https app (scheme downgrade)", async () => {
  serverAction("sec_scheme", () => "ok");
  const res = await dispatch(
    actionRequest("sec_scheme", {
      headers: { origin: "http://localhost", "x-denext-action": "1" },
      json: { args: [] },
    }),
    { canonicalOrigin: "https://localhost" },
  );
  assertEquals(res.status, 403);
});

Deno.test("action accepts a matching https Origin under canonicalOrigin", async () => {
  serverAction("sec_scheme_ok", () => "ok");
  const res = await dispatch(
    actionRequest("sec_scheme_ok", {
      headers: { origin: "https://localhost", "x-denext-action": "1" },
      json: { args: [] },
    }),
    { canonicalOrigin: "https://localhost" },
  );
  assertEquals(res.status, 200);
});

Deno.test("action allows a bare-host allowedOrigins entry regardless of scheme", async () => {
  serverAction("sec_bare", () => "ok");
  const res = await dispatch(
    actionRequest("sec_bare", {
      headers: { origin: "http://cdn.example.com", "x-denext-action": "1" },
      json: { args: [] },
    }),
    { allowedOrigins: ["cdn.example.com"] },
  );
  assertEquals(res.status, 200);
});

Deno.test("action rejects an oversized request body (413, via Content-Length)", async () => {
  serverAction("sec_big", () => "ok");
  // A real body larger than the cap; the runtime sets Content-Length from it.
  const res = await dispatch(
    actionRequest("sec_big", {
      headers: { origin: "http://localhost", "x-denext-action": "1" },
      json: { args: ["x".repeat(4096)] },
    }),
    { maxBodyBytes: 1024 },
  );
  assertEquals(res.status, 413);
});

Deno.test("action hard-caps a chunked body with no Content-Length (413)", async () => {
  serverAction("sec_chunk", (s: string) => s.length);
  // A streaming body has no Content-Length, so the declared fast-path is skipped
  // and the byte-limiter must catch the overflow.
  const payload = new TextEncoder().encode(JSON.stringify({ args: ["x".repeat(4096)] }));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(payload);
      c.close();
    },
  });
  const req = new Request(`http://localhost${actionEndpoint("sec_chunk")}`, {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "x-denext-action": "1",
      "content-type": "application/json",
    },
    body: stream,
    // deno-lint-ignore no-explicit-any
    ...({ duplex: "half" } as any),
  });
  const res = await dispatch(req, { maxBodyBytes: 512 });
  assertEquals(res.status, 413); // buffered read hit the cap → payload too large
});

Deno.test("action aborts a stalled (trickled/never-closed) body with 408", async () => {
  serverAction("sec_stall", (s: string) => s.length);
  // Send an opening byte, then go silent forever (never enqueue more, never close).
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("{"));
    },
  });
  const req = new Request(`http://localhost${actionEndpoint("sec_stall")}`, {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "x-denext-action": "1",
      "content-type": "application/json",
    },
    body: stream,
    // deno-lint-ignore no-explicit-any
    ...({ duplex: "half" } as any),
  });
  // A short idle deadline so the test doesn't wait the 30s default.
  const res = await dispatch(req, { bodyIdleTimeoutMs: 50 });
  assertEquals(res.status, 408); // idle body aborted, not left pinning the handler
});

Deno.test("action honors an allowedOrigins entry for a proxied host", async () => {
  serverAction("sec_e", () => "ok");
  const res = await dispatch(
    actionRequest("sec_e", {
      headers: { origin: "https://app.example.com", "x-denext-action": "1" },
      json: { args: [] },
    }),
    { allowedOrigins: ["https://app.example.com"] },
  );
  assertEquals(res.status, 200);
});

// ---- SECURITY: no leakage / bounded dispatch -------------------------------

Deno.test("unknown action id returns 404 without detail", async () => {
  const res = await dispatch(actionRequest("does_not_exist", {
    headers: { origin: "http://localhost", "x-denext-action": "1" },
    json: { args: [] },
  }));
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "unknown action");
});

Deno.test("a throwing action does not leak the error message", async () => {
  serverAction("sec_throw", () => {
    throw new Error("SECRET internal detail: db password = hunter2");
  });
  const res = await dispatch(actionRequest("sec_throw", {
    headers: { origin: "http://localhost", "x-denext-action": "1" },
    json: { args: [] },
  }));
  assertEquals(res.status, 500);
  const text = await res.text();
  assertStringIncludes(text, "server action failed");
  assert(!text.includes("SECRET"));
  assert(!text.includes("hunter2"));
});

// ---- Functional: dispatch + args ------------------------------------------

Deno.test("server action runs directly on the server and returns its result", async () => {
  const add = serverAction("fn_add", (a: number, b: number) => a + b);
  assertEquals(isServerAction(add), true);
  assertEquals(await add(2, 3), 5);
});

Deno.test("JSON args round-trip through the endpoint", async () => {
  serverAction("fn_echo", (x: unknown) => ({ got: x }));
  const res = await dispatch(actionRequest("fn_echo", {
    headers: { origin: "http://localhost", "x-denext-action": "1" },
    json: { args: [{ hello: "world" }] },
  }));
  assertEquals((await res.json()).result, { got: { hello: "world" } });
});

Deno.test("encode/decode round-trips a FormData arg with a leading state arg", async () => {
  const fd = new FormData();
  fd.set("name", "Ada");
  const { body, headers } = encodeActionArgs([{ count: 1 }, fd]);
  const req = new Request("http://localhost/x", { method: "POST", headers, body });
  const args = await decodeActionArgs(req);
  assertEquals(args[0], { count: 1 });
  assert(args[1] instanceof FormData);
  assertEquals((args[1] as FormData).get("name"), "Ada");
});

Deno.test("action redirect() returns a redirect payload to the client", async () => {
  serverAction("fn_redirect", () => redirect("/done"));
  const res = await dispatch(actionRequest("fn_redirect", {
    headers: { origin: "http://localhost", "x-denext-action": "1" },
    json: { args: [] },
  }));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).redirect, "/done");
});

Deno.test("no-JS form post redirects (303) back to the referring page", async () => {
  serverAction("fn_form", (fd: FormData) => ({ name: fd.get("name") }));
  const fd = new FormData();
  fd.set("name", "Ada");
  const req = actionRequest("fn_form", {
    headers: { origin: "http://localhost", referer: "http://localhost/signup" },
    body: fd,
  });
  const res = await dispatch(req);
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("location"), "/signup");
});

// ---- SSR progressive enhancement ------------------------------------------

Deno.test("a <form action={serverAction}> renders the endpoint + method=post", async () => {
  const save = serverAction("fn_ssr", (fd: FormData) => fd.get("q"));
  const html = await renderToString(
    h("form", { action: save }, h("input", { name: "q" })),
  );
  assertStringIncludes(html, `action="/_denext/action/fn_ssr"`);
  assertStringIncludes(html, `method="post"`);
});

// ---- Client/server boundary guards ----------------------------------------

Deno.test("serverOnly() passes on the server; clientOnly() throws", () => {
  assertEquals(isServer(), true);
  serverOnly(); // no throw on the server
  let threw = false;
  try {
    clientOnly("Widget");
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "client-only");
  }
  assertEquals(threw, true);
});
