import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  actionEndpoint,
  clientActionStub,
  decodeActionArgs,
  encodeActionArgs,
  getServerAction,
  isServerAction,
  serverAction,
  setActionRefreshHandler,
  tagServerExports,
  tagServerModules,
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

Deno.test("a malformed action id (bad percent-escape) is a 404, not a 500 (Part C)", async () => {
  // `%ZZ` is not a valid percent-escape — decodeURIComponent throws URIError.
  // It must be treated as a miss (unknown action), never an unhandled 500.
  const req = new Request("http://localhost/_denext/action/%ZZ", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "x-denext-action": "1" },
    body: JSON.stringify({ args: [] }),
  });
  const res = await dispatch(req);
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

// ---- "use server" module auto-registration --------------------------------

Deno.test("tagServerExports registers each exported function as moduleId#exportName", () => {
  const mod = {
    createNote: (t: string) => `created:${t}`,
    deleteNote: (id: number) => `deleted:${id}`,
    NOT_A_FN: 42, // non-functions are ignored
  };
  tagServerExports(mod, "app/actions.ts");
  const create = getServerAction("app/actions.ts#createNote");
  const del = getServerAction("app/actions.ts#deleteNote");
  assert(create, "createNote is registered under its module-qualified id");
  assert(del, "deleteNote is registered");
  assertEquals(create!("hi"), "created:hi");
  assertEquals(getServerAction("app/actions.ts#NOT_A_FN"), undefined, "non-fns are skipped");
});

Deno.test("tagServerExports tags each function in place (callable + isServerAction)", () => {
  const save = (x: number) => x + 1;
  const mod = { save };
  tagServerExports(mod, "mod/b.ts");
  assertEquals(isServerAction(save), true, "the exported function is tagged in place");
  assertEquals((save as { denextActionId?: string }).denextActionId, "mod/b.ts#save");
  assertEquals(save(2), 3, "tagging does not break the function");
  // The tag is non-enumerable so it doesn't leak into serialization/iteration.
  assert(!Object.keys(save).includes("denextActionId"), "the id tag is non-enumerable");
});

Deno.test("tagServerExports skips a function that is already a server action", () => {
  const existing = serverAction("preexisting_ref", () => "keep");
  // Re-tagging under a different module id must NOT overwrite the existing id.
  tagServerExports({ existing }, "other/mod.ts");
  assertEquals(existing.denextActionId, "preexisting_ref", "the original id is preserved");
  assertEquals(
    getServerAction("other/mod.ts#existing"),
    undefined,
    "no second registration for an already-tagged action",
  );
});

Deno.test("tagServerModules imports + registers a module's exports once per process", async () => {
  const urlA = "data:text/javascript,export function alpha(){return 'A'}";
  const urlB = "data:text/javascript,export function beta(){return 'B'}";
  await tagServerModules([["mod/dedup", { url: urlA }]]);
  assert(getServerAction("mod/dedup#alpha"), "the first module's export is registered");
  // A second call for the SAME module id is skipped (imported at most once) — so a
  // different url's exports are not registered under the already-tagged id.
  await tagServerModules([["mod/dedup", { url: urlB }]]);
  assertEquals(
    getServerAction("mod/dedup#beta"),
    undefined,
    "the module id is tagged once; the second call is a no-op",
  );
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

// ---- Client dispatch: read-your-writes refresh (Live Server Components stage 4)

/** Run `body` with `globalThis.fetch` stubbed to return `data` as JSON, then restore. */
async function withFetch(
  data: unknown,
  body: (urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: URL | RequestInfo) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  try {
    await body(urls);
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("client dispatch: an action reporting updatedTags triggers a route refresh", async () => {
  let refreshed = 0;
  setActionRefreshHandler(() => refreshed++);
  try {
    await withFetch({ result: "ok", updatedTags: ["orders"] }, async () => {
      const stub = clientActionStub<[], string>("live#save");
      const result = await stub();
      assertEquals(result, "ok");
      assertEquals(refreshed, 1, "updatedTags refreshes the current route");
    });
  } finally {
    setActionRefreshHandler(() => {});
  }
});

Deno.test("client dispatch: an action reporting refresh:true triggers a route refresh", async () => {
  let refreshed = 0;
  setActionRefreshHandler(() => refreshed++);
  try {
    await withFetch({ result: null, refresh: true }, async () => {
      await clientActionStub<[], null>("live#touch")();
      assertEquals(refreshed, 1);
    });
  } finally {
    setActionRefreshHandler(() => {});
  }
});

Deno.test("client dispatch: a plain result does not refresh", async () => {
  let refreshed = 0;
  setActionRefreshHandler(() => refreshed++);
  try {
    await withFetch({ result: 42 }, async () => {
      const value = await clientActionStub<[], number>("live#read")();
      assertEquals(value, 42);
      assertEquals(refreshed, 0, "no updatedTags/refresh means no refresh");
    });
  } finally {
    setActionRefreshHandler(() => {});
  }
});
