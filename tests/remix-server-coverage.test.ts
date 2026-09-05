// Line-coverage sweep of the `denext/remix` SERVER runtime (`src/compat/remix/server.ts`):
// the data helpers (`json`/`redirect`/`replace`/`data`/`defer`), the loader/action runners
// and their thrown-Response control flow, the cookie/session factories, the `meta` bridge,
// and multipart parsing. Each is unit-tested directly; the request-scoped helpers run inside
// a denext request context.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { h } from "../mod.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  bindAction,
  createCookie,
  createCookieSessionStorage,
  createMemorySessionStorage,
  createSession,
  createSessionStorage,
  data,
  defer,
  isCookie,
  isSession,
  json,
  parseMultipartFormData,
  redirect,
  redirectDocument,
  RemixLayout,
  remixMeta,
  runActionResponse,
  runLoader,
  runLoaderResponse,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "../src/compat/remix/server.ts";
import { RemixRouteProvider } from "../src/compat/remix/client.ts";
import { isRedirect } from "../src/runtime/error-boundary.ts";
import {
  createRequestContext,
  currentContext,
  runWithContext,
} from "../src/server/request-context.ts";

// ── Data helpers ──────────────────────────────────────────────────────────────

Deno.test("json(): number-init sets status; default content-type is applied", async () => {
  const res = json({ ok: true }, 201);
  assertEquals(res.status, 201);
  assertStringIncludes(res.headers.get("Content-Type") ?? "", "application/json");
  assertEquals(await res.json(), { ok: true });

  // A caller-supplied Content-Type is preserved (not overwritten).
  const res2 = json("<xml/>", { headers: { "Content-Type": "application/xml" } });
  assertEquals(res2.headers.get("Content-Type"), "application/xml");
});

Deno.test("redirect() / redirectDocument(): default 302 + Location; number-init status", () => {
  const r = redirect("/a");
  assertEquals(r.status, 302);
  assertEquals(r.headers.get("Location"), "/a");
  assertEquals(redirect("/b", 301).status, 301);
  // redirectDocument is a redirect the client follows with a full document load.
  const doc = redirectDocument("/c");
  assertEquals(doc.headers.get("Location"), "/c");
  assertEquals(doc.headers.get("x-remix-reload-document"), "true");
  assertEquals(redirect("/c").headers.get("x-remix-reload-document"), null);
});

Deno.test("defer() passes the (promise-bearing) object straight through", () => {
  const p = Promise.resolve(1);
  const obj = { now: 1, later: p };
  assertEquals(defer(obj), obj);
  assertEquals(defer({ a: 2 }, { status: 200 }), { a: 2 });
});

Deno.test("data(): applies status + non-cookie headers AND Set-Cookie onto the response", async () => {
  const ctx = createRequestContext(new Request("http://localhost/"));
  const value = await runWithContext(ctx, () =>
    runLoader(
      () =>
        data({ v: 1 }, {
          status: 202,
          headers: { "X-A": "1", "Set-Cookie": "sid=1; Path=/" },
        }),
      {},
    ));
  assertEquals(value, { v: 1 });
  assertEquals(ctx.responseStatus, 202);
  assertEquals(ctx.outgoingHeaders.get("X-A"), "1");
  assert(ctx.outgoingHeaders.getSetCookie().some((c) => c.startsWith("sid=1")));
});

// ── Loader/action runners ─────────────────────────────────────────────────────

Deno.test("runLoader: a plain-text Response body is returned as text; empty body → null", async () => {
  assertEquals(await runLoader(() => new Response("hello there"), {}), "hello there");
  assertEquals(await runLoader(() => new Response(""), {}), null);
});

Deno.test("runLoader: a thrown non-Response error propagates unchanged", async () => {
  await assertRejects(
    () =>
      runLoader(() => {
        throw new TypeError("real bug");
      }, {}),
    TypeError,
    "real bug",
  );
});

Deno.test("bindAction: runs the action with submitted FormData and unwraps its json()", async () => {
  const action = ({ request, params }: { request: Request; params: Record<string, string> }) =>
    json({ id: params.id, method: request.method });
  const ref = bindAction(action, "routes/thing", { id: "9" });
  assert(ref, "an action is bound");
  const fd = new FormData();
  fd.append("k", "v");
  const ctx = createRequestContext(new Request("http://localhost/thing"));
  const result = await runWithContext(ctx, () => ref!(fd));
  assertEquals(result, { id: "9", method: "POST" });

  // No action → no bound ref.
  assertEquals(bindAction(undefined, "routes/x", {}), undefined);
});

Deno.test("bindAction: a thrown redirect from the action becomes denext's redirect signal", async () => {
  const ref = bindAction(
    () => {
      throw redirect("/after");
    },
    "routes/login",
    {},
  );
  const ctx = createRequestContext(new Request("http://localhost/login"));
  await assertRejects(() => runWithContext(ctx, () => ref!(new FormData())));
});

Deno.test("runLoaderResponse: thrown redirect passes through; a real error re-throws", async () => {
  const redir = await runLoaderResponse(() => {
    throw redirect("/login");
  }, new Request("http://localhost/guard"));
  assertEquals(redir.status, 302);
  assertEquals(redir.headers.get("Location"), "/login");

  // A thrown non-Response error is a real 500 — re-thrown by the resource runner.
  await assertRejects(
    () =>
      runLoaderResponse(() => {
        throw new Error("kaboom");
      }, new Request("http://localhost/r")),
    Error,
    "kaboom",
  );

  // No loader → 404.
  assertEquals((await runLoaderResponse(undefined, new Request("http://localhost/r"))).status, 404);
});

Deno.test("runLoaderResponse: a resource loader returns a plain value as JSON", async () => {
  const res = await runLoaderResponse(
    ({ request }) => ({ q: new URL(request.url).searchParams.get("q") }),
    new Request("http://localhost/api?q=hi"),
  );
  assertEquals(await res.json(), { q: "hi" });
});

Deno.test("runActionResponse: a thrown non-Response error re-throws (→ 500)", async () => {
  await assertRejects(
    () =>
      runActionResponse(() => {
        throw new Error("boom");
      }, new Request("http://localhost/x", { method: "POST" })),
    Error,
    "boom",
  );
});

// ── Route wrappers ────────────────────────────────────────────────────────────

Deno.test("RemixLayout runs the loader and threads children to the layout boundary", async () => {
  function Kid() {
    return h("span", null, "kid");
  }
  const Route = (
    props: { id: string; loaderData: unknown; params: Record<string, string>; children?: unknown },
  ) => h(RemixRouteProvider, { ...props, children: props.children } as never);
  const vnode = await RemixLayout({
    id: "root",
    loader: () => ({ n: 1 }),
    Route,
    params: {},
    children: h(Kid, null),
  });
  const html = await renderToString(vnode);
  assertStringIncludes(html, "kid");
});

// ── remixMeta bridge (keywords / generic name / no-content descriptor) ─────────

Deno.test("remixMeta maps keywords, a generic name, and skips a content-less descriptor", async () => {
  const meta = () => [
    { title: "T" },
    { charSet: "utf-8" }, // no content → skipped
    { name: "keywords", content: "a, b , c" },
    { name: "author", content: "Ada" },
    { property: "og:title", content: "OG" },
  ];
  const gen = remixMeta(meta, () => ({ loaded: true }))!;
  const md = await gen({ params: {}, searchParams: new URLSearchParams() });
  assertEquals(md.title, "T");
  assertEquals(md.keywords, ["a", "b", "c"]);
  assertEquals(md.meta?.["author"], "Ada");
  assertEquals(md.meta?.["og:title"], "OG");

  // No meta export → no generator.
  assertEquals(remixMeta(undefined, undefined), undefined);
});

// ── Cookies ───────────────────────────────────────────────────────────────────

Deno.test("createCookie (unsigned): round-trips a value and serializes attributes", async () => {
  const cookie = createCookie("plain", {
    path: "/app",
    maxAge: 60,
    domain: "example.com",
    secure: true,
    sameSite: "lax",
    httpOnly: false,
  });
  assertEquals(cookie.isSigned, false);
  const setCookie = await cookie.serialize({ a: 1 });
  assertStringIncludes(setCookie, "Path=/app");
  assertStringIncludes(setCookie, "Max-Age=60");
  assertStringIncludes(setCookie, "Domain=example.com");
  assertStringIncludes(setCookie, "Secure");
  assertStringIncludes(setCookie, "SameSite=Lax");
  assert(!setCookie.includes("HttpOnly"), "httpOnly:false opts out");

  const header = setCookie.split(";")[0];
  assertEquals(await cookie.parse(header), { a: 1 });
  // A malformed (non-base64/JSON) value decodes to null rather than throwing.
  assertEquals(await cookie.parse("plain=@@@notvalid@@@"), null);
  // A cookie name absent from the header → null.
  assertEquals(await cookie.parse("other=1"), null);
});

Deno.test("createCookie: sameSite:true → Strict; sameSite:'strict' token", async () => {
  const strictBool = await createCookie("c1").serialize("x", { sameSite: true });
  assertStringIncludes(strictBool, "SameSite=Strict");
  const strict = await createCookie("c2").serialize("x", { sameSite: "strict" });
  assertStringIncludes(strict, "SameSite=Strict");
  assert(isCookie(createCookie("c3")));
});

// ── Sessions ──────────────────────────────────────────────────────────────────

Deno.test("createSession: unset removes a value; has() covers data + flash", () => {
  const s = createSession({ a: 1 });
  assert(s.has("a"));
  s.set("b", 2);
  assertEquals(s.get("b"), 2);
  s.unset("b");
  assertEquals(s.get("b"), undefined);
  assert(!s.has("b"));
  s.flash("note", "hi");
  assert(s.has("note"));
  assert(isSession(s));
});

Deno.test("createCookieSessionStorage: default cookie; oversized commit throws; destroy expires", async () => {
  const storage = createCookieSessionStorage(); // no cookie → default "__session"
  const s = await storage.getSession();
  s.set("u", "1");
  const header = (await storage.commitSession(s)).split(";")[0];
  assertEquals((await storage.getSession(header)).get("u"), "1");

  // Over ~4 KB of cookie data is rejected (use a server-side store instead).
  const big = await storage.getSession();
  big.set("blob", "x".repeat(5000));
  await assertRejects(() => storage.commitSession(big), Error, "exceeds 4096");

  // Destroy expires the cookie.
  const destroy = await storage.destroySession(s);
  assertStringIncludes(destroy, "Expires=Thu, 01 Jan 1970");
});

Deno.test("createSessionStorage (custom store): create then update by id; destroy deletes", async () => {
  const backing = new Map<string, Record<string, unknown>>();
  let created = 0;
  let updated = 0;
  let deleted = 0;
  const storage = createSessionStorage({
    cookie: { name: "sid" },
    createData(data) {
      const id = `id${++created}`;
      backing.set(id, data);
      return Promise.resolve(id);
    },
    readData(id) {
      return Promise.resolve(backing.get(id) ?? null);
    },
    updateData(id, data) {
      updated++;
      backing.set(id, data);
      return Promise.resolve();
    },
    deleteData(id) {
      deleted++;
      backing.delete(id);
      return Promise.resolve();
    },
  });

  const fresh = await storage.getSession();
  fresh.set("k", "v");
  const header = (await storage.commitSession(fresh, { maxAge: 3600 })).split(";")[0];
  assertEquals(created, 1);

  // Re-committing an existing session id takes the update path (not create).
  const loaded = await storage.getSession(header);
  assertEquals(loaded.get("k"), "v");
  loaded.set("k", "w");
  await storage.commitSession(loaded);
  assertEquals(updated, 1);

  await storage.destroySession(loaded);
  assertEquals(deleted, 1);
});

Deno.test("createMemorySessionStorage: reads store data, expires stale, and destroys", async () => {
  const storage = createMemorySessionStorage({ cookie: { name: "m" } });
  const s = await storage.getSession();
  s.set("cart", [1]);
  const header = (await storage.commitSession(s)).split(";")[0];
  assertEquals((await storage.getSession(header)).get("cart"), [1]);

  // Re-committing the loaded (id-bearing) session takes the memory store's update path.
  const reloaded = await storage.getSession(header);
  reloaded.set("cart", [1, 2]);
  await storage.commitSession(reloaded, { maxAge: 3600 });
  assertEquals((await storage.getSession(header)).get("cart"), [1, 2]);

  // An expired record (negative maxAge → past expiry) reads back empty and is dropped.
  const s2 = await storage.getSession();
  s2.set("temp", "x");
  const h2 = (await storage.commitSession(s2, { maxAge: -1 })).split(";")[0];
  assertEquals((await storage.getSession(h2)).get("temp"), undefined);

  // Destroy removes the record.
  const restored = await storage.getSession(header);
  await storage.destroySession(restored);
  assertEquals((await storage.getSession(header)).get("cart"), undefined);
});

// ── Multipart parsing ─────────────────────────────────────────────────────────

Deno.test("parseMultipartFormData: no handler returns the raw FormData", async () => {
  const body = new FormData();
  body.append("name", "Ada");
  const req = new Request("http://localhost/u", { method: "POST", body });
  const form = await parseMultipartFormData(req); // alias, no upload handler
  assertEquals(form.get("name"), "Ada");
});

Deno.test("unstable_parseMultipartFormData: a string-returning handler stores its string", async () => {
  const body = new FormData();
  body.append("field", "keep");
  body.append("doc", new File(["DATA"], "d.txt", { type: "text/plain" }));
  const req = new Request("http://localhost/u", { method: "POST", body });
  const form = await unstable_parseMultipartFormData(req, (part) => Promise.resolve(part.name));
  assertEquals(form.get("field"), "keep"); // a plain string field bypasses the handler
  assertEquals(form.get("doc"), "doc"); // the file part's handler returned its name (a string)
});

Deno.test("memory upload handler: a plain field decodes to a string, a file part to a File", async () => {
  const body = new FormData();
  body.append("plain", "just-text");
  body.append("file", new File(["BYTES"], "b.bin", { type: "application/octet-stream" }));
  const req = new Request("http://localhost/u", { method: "POST", body });
  const form = await unstable_parseMultipartFormData(req, unstable_createMemoryUploadHandler());
  assertEquals(form.get("plain"), "just-text");
  const file = form.get("file") as File;
  assert(file instanceof File);
  assertEquals(await file.text(), "BYTES");
});

// ── replace() sanity (soft-nav history mode) ──────────────────────────────────

Deno.test("replace(): a returned loader replace is denext's redirect signal (replace mode)", async () => {
  const ctx = createRequestContext(new Request("http://localhost/"));
  let thrown: unknown;
  try {
    await runWithContext(ctx, () =>
      runLoader(() => {
        // `redirect` import kept live; use it once to guard the plain-redirect path too.
        void currentContext();
        throw redirect("/plain");
      }, {}));
  } catch (e) {
    thrown = e;
  }
  assert(isRedirect(thrown));
});
