// The `denext/remix` compat runtime — the layer that lets a migrated Remix app run on
// denext. These tests render the runtime through denext's own SSR (`renderToString`) to
// prove the data model works end-to-end: a loader runs, its data reaches `useLoaderData`,
// `useMatches` sees the chain, `<Link>` maps `to`→`href`, and the server helpers
// (`json`/`redirect`/`runLoader`/`remixMeta`) behave.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { h } from "../mod.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  findLoaderData,
  formActionAttr,
  isRouteErrorResponse,
  Link,
  RemixErrorProvider,
  RemixRouteProvider,
  useCatch,
  useLoaderData,
  useMatches,
  useParams,
} from "../src/compat/remix/client.ts";
import {
  createCookie,
  createCookieSessionStorage,
  createMemorySessionStorage,
  createSession,
  data,
  isCookie,
  isSession,
  json,
  type LoaderFunctionArgs,
  redirect,
  remixMeta,
  RemixRoute,
  replace,
  runActionResponse,
  runLoader,
  runLoaderOnce,
  runLoaderResponse,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "../src/compat/remix/server.ts";
import { isRedirect } from "../src/runtime/error-boundary.ts";
import { serverAction } from "../src/runtime/server-action.ts";
import { registerServerMatch } from "../src/compat/remix/matches-server.ts";
import {
  FROM_HEADER,
  LOADER_DATA_HEADER,
  PARAMS_HEADER,
  REVALIDATE_HEADER,
  type ShouldRevalidateArgs,
} from "../src/compat/remix/revalidation.ts";
import {
  createRequestContext,
  currentContext,
  runWithContext,
} from "../src/server/request-context.ts";
import { clearLoadContext, defineLoadContext } from "../src/compat/remix/load-context.ts";
import { remixPath, remixServerBuild } from "../src/compat/remix/server-build.ts";
import { resolveRoutePath } from "../src/compat/remix/route-path.ts";
import { applyDocumentAttrs } from "../src/compat/remix/document.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

Deno.test("useLoaderData reads the data the provider threads across the boundary", async () => {
  function Child() {
    const data = useLoaderData<{ message: string }>();
    const params = useParams();
    return h("p", null, `${data.message} @ ${params.city ?? "-"}`);
  }
  const tree = h(RemixRouteProvider, {
    id: "concerts/[city]:page",
    loaderData: { message: "Welcome" },
    params: { city: "berlin" },
    children: h(Child, null),
  });
  const html = await renderToString(tree);
  assertStringIncludes(html, "Welcome @ berlin");
});

Deno.test("useMatches exposes the route chain (outermost first)", async () => {
  function Leaf() {
    const matches = useMatches();
    return h("p", null, matches.map((m) => m.id).join(" / "));
  }
  const tree = h(RemixRouteProvider, {
    id: "root:layout",
    loaderData: null,
    params: {},
    children: h(RemixRouteProvider, {
      id: "concerts:page",
      loaderData: null,
      params: {},
      children: h(Leaf, null),
    }),
  });
  const html = await renderToString(tree);
  assertStringIncludes(html, "root:layout / concerts:page");
});

Deno.test("useMatches resolves the ancestor chain from the render-scoped store when context is missing", async () => {
  // The streaming Flight renderer can render a nested route WITHOUT the ancestor
  // RemixRouteProvider's context (the Flight-children serialization pass). The server
  // wrappers register each match in a request-scoped store; `useMatches` reads it so an
  // ancestor read (`useRouteLoaderData("root")` / `useUser`) resolves instead of crashing.
  function Leaf() {
    const matches = useMatches();
    const root = matches.find((m) => m.id === "root");
    return h(
      "p",
      null,
      `${matches.map((m) => m.id).join(" / ")} :: ${(root?.data as { u: string })?.u}`,
    );
  }
  const request = new Request("http://localhost/notes");
  const html = await runWithContext(createRequestContext(request), async () => {
    registerServerMatch({
      id: "root",
      pathname: "/notes",
      params: {},
      data: { u: "ada" },
      handle: undefined,
    });
    registerServerMatch({
      id: "routes/notes",
      pathname: "/notes",
      params: {},
      data: {},
      handle: undefined,
    });
    // Leaf renders with EMPTY React context (no provider chain) — the store must supply it.
    return await renderToString(h(Leaf, null));
  });
  assertStringIncludes(html, "root / routes/notes :: ada");
});

const Probe = (p: { loaderData: unknown }) => h("p", null, JSON.stringify(p.loaderData));

Deno.test("shouldRevalidate: a client revalidation SKIPS the loader, reusing the echoed prior data", async () => {
  let loaderCalls = 0;
  const opts = {
    id: "root",
    loader: () => {
      loaderCalls++;
      return { fresh: true };
    },
    Route: Probe,
    params: {},
    shouldRevalidate: (_a: ShouldRevalidateArgs) => false, // opt out
  };
  // A client revalidation echoing prior data for `root`.
  const req = new Request("http://x/notes", {
    headers: {
      [REVALIDATE_HEADER]: "root,routes/notes",
      [LOADER_DATA_HEADER]: JSON.stringify({ root: { user: "ada" } }),
      [FROM_HEADER]: "/notes",
      [PARAMS_HEADER]: "{}",
    },
  });
  const vnode = await runWithContext(createRequestContext(req), () => RemixRoute(opts));
  assertEquals(vnode.props.loaderData, { user: "ada" }, "the echoed prior data is reused");
  assertEquals(loaderCalls, 0, "the loader's work is skipped when shouldRevalidate opts out");
});

Deno.test("shouldRevalidate: the loader RUNS when it returns true, or on a non-revalidation request", async () => {
  let loaderCalls = 0;
  const base = {
    id: "root",
    loader: () => {
      loaderCalls++;
      return { fresh: true };
    },
    Route: Probe,
    params: {},
  };

  // (a) shouldRevalidate returns true → loader runs even with echoed data present.
  const req = new Request("http://x/notes", {
    headers: {
      [REVALIDATE_HEADER]: "root",
      [LOADER_DATA_HEADER]: JSON.stringify({ root: { old: 1 } }),
    },
  });
  const v1 = await runWithContext(
    createRequestContext(req),
    () => RemixRoute({ ...base, shouldRevalidate: () => true }),
  );
  assertEquals(v1.props.loaderData, { fresh: true });
  assertEquals(loaderCalls, 1);

  // (b) No revalidation header (first paint / hard nav) → loader always runs, even opting out.
  const plain = new Request("http://x/notes");
  const v2 = await runWithContext(
    createRequestContext(plain),
    () => RemixRoute({ ...base, shouldRevalidate: () => false }),
  );
  assertEquals(v2.props.loaderData, { fresh: true });
  assertEquals(loaderCalls, 2, "no header means always revalidate — never stale");
});

Deno.test("shouldRevalidate: a route the client didn't echo data for still revalidates", async () => {
  let loaderCalls = 0;
  const req = new Request("http://x/new", {
    // `routes/new` is a freshly-entered route (no prior client data) → not in the echo → must load.
    headers: {
      [REVALIDATE_HEADER]: "root",
      [LOADER_DATA_HEADER]: "{}",
      [FROM_HEADER]: "/old",
    },
  });
  const vnode = await runWithContext(
    createRequestContext(req),
    () =>
      RemixRoute({
        id: "routes/new",
        loader: () => {
          loaderCalls++;
          return { n: 1 };
        },
        Route: Probe,
        params: {},
        shouldRevalidate: () => false,
      }),
  );
  assertEquals(vnode.props.loaderData, { n: 1 });
  assertEquals(loaderCalls, 1);
});

Deno.test("shouldRevalidate: the echo can arrive via the soft-nav POST body (over-large data)", async () => {
  let loaderCalls = 0;
  // A large echo travels in the POST body (stashed as ctx.softNavBody) instead of a header.
  const ctx = createRequestContext(new Request("http://x/notes", { method: "POST" }));
  ctx.softNavBody = { from: "/notes", params: {}, data: { root: { big: "kept" } } };
  const vnode = await runWithContext(
    ctx,
    () =>
      RemixRoute({
        id: "root",
        loader: () => {
          loaderCalls++;
          return { fresh: true };
        },
        Route: Probe,
        params: {},
        shouldRevalidate: () => false,
      }),
  );
  assertEquals(
    vnode.props.loaderData,
    { big: "kept" },
    "body echo is used, unbounded by header size",
  );
  assertEquals(loaderCalls, 0);
});

Deno.test("Link maps Remix `to` to denext `href`", async () => {
  const html = await renderToString(h(Link, { to: "/about" }, "About"));
  assertStringIncludes(html, `href="/about"`);
  assertStringIncludes(html, "About");
});

Deno.test("useCatch (v1 CatchBoundary) reads a thrown Response from the error provider", async () => {
  // A migrated v1 CatchBoundary uses `useCatch()`; error.tsx wraps it in RemixErrorProvider
  // with the caught value. A thrown-Response error is a route-error-response → useCatch shapes it.
  const CatchBoundary = () => {
    const caught = useCatch();
    return h("p", null, caught ? `${caught.status} ${caught.statusText}` : "no-catch");
  };
  const caughtResponse = {
    __remixErrorResponse: true as const,
    status: 404,
    statusText: "Not Found",
    data: { message: "gone" },
  };
  const html = await renderToString(
    h(RemixErrorProvider, { error: caughtResponse }, h(CatchBoundary, null)),
  );
  assertStringIncludes(html, "404 Not Found");
});

Deno.test("useCatch returns undefined for a plain (non-Response) error", async () => {
  const CatchBoundary = () => {
    const caught = useCatch();
    return h("p", null, caught ? "caught" : "no-catch");
  };
  const html = await renderToString(
    h(RemixErrorProvider, { error: new Error("boom") }, h(CatchBoundary, null)),
  );
  assertStringIncludes(html, "no-catch");
});

Deno.test("RemixRoute runs the loader and threads its data into the client boundary", async () => {
  function Page() {
    const data = useLoaderData<{ n: number }>();
    return h("span", null, `n=${data.n}`);
  }
  // The generated `page.client.tsx` default: a boundary that receives loaderData as a prop
  // and composes the provider + user component (so the data crosses the Flight boundary).
  const Route = (props: { id: string; loaderData: unknown; params: Record<string, string> }) =>
    h(RemixRouteProvider, { ...props, children: h(Page, null) });
  const loader = () => json({ n: 42 });
  const vnode = await RemixRoute({ id: "x:page", loader, Route, params: {} });
  const html = await renderToString(vnode);
  assertStringIncludes(html, "n=42");
});

Deno.test("runLoader unwraps json() and honors a redirect()", async () => {
  // A plain value passes through.
  assertEquals(await runLoader(() => ({ a: 1 }), {}), { a: 1 });
  // json() is unwrapped to its parsed body.
  assertEquals(await runLoader(() => json({ b: 2 }), {}), { b: 2 });
  // A returned redirect() throws denext's control-flow signal.
  await assertRejects(() => runLoader(() => redirect("/login"), {}));
});

Deno.test("Form's DOM action is the endpoint URL string, never the Server-Action ref", () => {
  // Regression: handing denext a *function*-valued `action` makes its reconciler
  // wire the native React-19 form-action handler, which runs the action OUTSIDE
  // Remix's submit lifecycle (bypassing useActionData/useNavigation/revalidation).
  // The <Form> must expose only the endpoint URL string; it drives the real submit
  // through its own onSubmit (runRouteAction).
  const action = serverAction("remix:x/y:page#action", (_fd: FormData) => Promise.resolve(null));

  const attr = formActionAttr(action, undefined, false);
  assert(typeof attr === "string", "action attribute must be a string, not the ref function");
  assertStringIncludes(attr, "/_denext/action/");
  assertStringIncludes(attr, encodeURIComponent("remix:x/y:page#action"));

  // GET forms never bind the route action (they soft-navigate), so a bound action
  // is ignored and the caller's action passes through.
  assertEquals(formActionAttr(action, "/search", true), "/search");
  // An explicit `action` (a cross-route resource/action URL) is honored as-is, even
  // when the current route has its own Server Action.
  assertEquals(formActionAttr(action, "/api/thing", false), "/api/thing");
  // No bound action → the caller's `action` passes through untouched.
  assertEquals(formActionAttr(undefined, "/custom", false), "/custom");
  assertEquals(formActionAttr(undefined, undefined, false), undefined);
});

Deno.test("findLoaderData extracts a route's loader data from its Flight payload", () => {
  // The shape denext serves for a migrated Remix route: a client boundary carrying
  // loaderData as a prop, nested in the Flight array-of-arrays.
  const payload = [[{
    $: "c",
    i: "concerts/[city]:page#default",
    p: { id: "concerts/[city]:page", loaderData: { city: "berlin", available: true }, params: {} },
    c: [],
  }]];
  assertEquals(findLoaderData(payload), { city: "berlin", available: true });

  // A host-only payload (a static route, no client boundary) yields undefined.
  assertEquals(findLoaderData([[{ $: "h", t: "main", c: ["hi"] }]]), undefined);
  // The FIRST boundary's data wins (outermost route in the chain).
  const nested = [[{
    $: "c",
    p: { loaderData: { root: true } },
    c: [{ $: "c", p: { loaderData: { leaf: true } }, c: [] }],
  }]];
  assertEquals(findLoaderData(nested), { root: true });
});

Deno.test("a loader/action Response's Set-Cookie is forwarded onto the outgoing response", async () => {
  // The canonical Remix login: commit the session and redirect with a Set-Cookie. denext
  // converts the Response to a redirect signal / JSON, so the cookie must be lifted onto
  // the request's outgoing headers or it would be lost.
  const request = new Request("http://localhost/login", { method: "POST" });
  await runWithContext(createRequestContext(request), async () => {
    // json() carrying a Set-Cookie (a non-redirect commit).
    await runLoader(
      () => json({ ok: true }, { headers: { "Set-Cookie": "__s=abc123; Path=/; HttpOnly" } }),
      {},
    );
    // redirect() carrying a Set-Cookie (the login pattern) — the redirect throws, but the
    // cookie is forwarded first.
    await assertRejects(() =>
      runLoader(() => redirect("/home", { headers: { "Set-Cookie": "__s2=xyz; Path=/" } }), {})
    );
    const setCookies = currentContext()!.outgoingHeaders.getSetCookie();
    assert(setCookies.some((c) => c.startsWith("__s=abc123")), "json() Set-Cookie forwarded");
    assert(setCookies.some((c) => c.startsWith("__s2=xyz")), "redirect() Set-Cookie forwarded");
  });
});

Deno.test("runActionResponse runs a page action with its URL params, and passes a redirect through", async () => {
  // The generated page-action `route.ts` calls runActionResponse(data.action, request,
  // ctx.params): a POST to a page URL runs the action with the route's matched params,
  // so cross-route `fetcher.submit`/`<Form action>` to a page (and the no-JS post) work.
  const action = (
    { request, params }: { request: Request; params: Record<string, string> },
  ) => ({ city: params.city, method: request.method });
  const res = await runActionResponse(
    action as never,
    new Request("http://localhost/concerts/berlin", { method: "POST" }),
    { city: "berlin" },
  );
  assertEquals(await res.json(), { city: "berlin", method: "POST" });

  // A redirecting action (the login pattern) returns its Response as-is — the client
  // fetch follows it and soft-navigates.
  const r2 = await runActionResponse(
    (() => redirect("/dashboard")) as never,
    new Request("http://localhost/login", { method: "POST" }),
  );
  assertEquals(r2.status, 302);
  assertEquals(r2.headers.get("location"), "/dashboard");

  // No action bound → 405 (the method the page's route.ts wouldn't have emitted).
  const r3 = await runActionResponse(
    undefined,
    new Request("http://localhost/x", { method: "POST" }),
  );
  assertEquals(r3.status, 405);
});

Deno.test("a loader/action that THROWS a redirect/Response is honored (the requireUserId pattern)", async () => {
  // Remix uses thrown Responses as control flow: `throw redirect(url)` (every auth guard)
  // and `throw json()/new Response()` for errors. A page loader's thrown redirect must
  // become denext's redirect signal (a reject), not an unhandled 500.
  await assertRejects(() =>
    runLoader(() => {
      throw redirect("/login?redirectTo=%2Fnotes");
    }, {})
  );
  // A thrown non-redirect Response becomes a Remix route-error-response (for ErrorBoundary).
  const routeErr = await runLoader(() => {
    throw json({ message: "nope" }, { status: 404 });
  }, {}).then(() => null, (e) => e);
  assert(isRouteErrorResponse(routeErr), "thrown non-redirect Response → route error response");
  assertEquals(routeErr.status, 404);
  assertEquals((routeErr.data as { message: string }).message, "nope");

  // A resource route (route.ts) returns a thrown redirect/Response AS the response.
  const res = await runActionResponse(() => {
    throw redirect("/", { headers: { "Set-Cookie": "__session=; Max-Age=0" } });
  }, new Request("http://localhost/logout", { method: "POST" }));
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/");
});

Deno.test("createCookie signs and round-trips a value; tampering fails", async () => {
  const cookie = createCookie("sess", { secrets: ["a-long-enough-test-secret-000000000"] });
  const setCookie = await cookie.serialize({ userId: 42 });
  assertStringIncludes(setCookie, "sess=");
  assertStringIncludes(setCookie, "HttpOnly");
  assertStringIncludes(setCookie, "Path=/");

  const header = setCookie.split(";")[0]; // "sess=<encoded>.<sig>"
  assertEquals(await cookie.parse(header), { userId: 42 });
  // Corrupting the signature fails verification → null (no silent trust).
  assertEquals(await cookie.parse(header.slice(0, -3) + "zzz"), null);
  assertEquals(await cookie.parse(null), null);
});

Deno.test("createCookieSessionStorage stores + reads session data, flash is read-once", async () => {
  const storage = createCookieSessionStorage({
    cookie: { name: "__session", secrets: ["another-long-enough-secret-00000000"] },
  });
  const session = await storage.getSession();
  session.set("userId", "u1");
  session.flash("notice", "welcome");
  const header = (await storage.commitSession(session)).split(";")[0];

  const restored = await storage.getSession(header);
  assertEquals(restored.get("userId"), "u1");
  assertEquals(restored.get("notice"), "welcome"); // flash present once…
  assertEquals(restored.get("notice"), undefined); // …then cleared
});

Deno.test("createMemorySessionStorage keeps the id in the cookie and data server-side", async () => {
  const storage = createMemorySessionStorage({
    cookie: { name: "sid", secrets: ["yet-another-long-enough-secret-0000"] },
  });
  const s = await storage.getSession();
  s.set("cart", [1, 2, 3]);
  const header = (await storage.commitSession(s)).split(";")[0];

  const restored = await storage.getSession(header);
  assertEquals(restored.get("cart"), [1, 2, 3]);
  assert(restored.id.length > 0, "server-side session carries an id");
  // Destroy expires the cookie and drops the record.
  const destroy = await storage.destroySession(restored);
  assertStringIncludes(destroy, "Expires=Thu, 01 Jan 1970");
  assertEquals((await storage.getSession(header)).get("cart"), undefined);
});

Deno.test("createSession / isSession / isCookie (standalone factory + type guards)", () => {
  const s = createSession({ userId: "u1" }, "sid-1");
  assertEquals(s.id, "sid-1");
  assertEquals(s.get("userId"), "u1");
  s.set("cart", [1]);
  assertEquals(s.get("cart"), [1]);
  s.flash("msg", "hi");
  assertEquals(s.get("msg"), "hi"); // read-once
  assertEquals(s.get("msg"), undefined); // gone after the read

  // Type guards distinguish a real session/cookie from a lookalike.
  assert(isSession(s));
  assert(!isSession({ get() {}, set() {} })); // missing id/flash/…
  assert(!isSession(null));
  assert(isCookie(createCookie("c")));
  assert(!isCookie({ name: "c" })); // no serialize()
});

Deno.test("data(): a resource loader returns the value as JSON with the requested status + headers", async () => {
  const loader = () =>
    data({ ok: false }, { status: 422, headers: { "Cache-Control": "no-store" } });
  const res = await runLoaderResponse(loader, new Request("http://localhost/api"));
  assertEquals(res.status, 422);
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assertEquals(await res.json(), { ok: false });
});

Deno.test("data(): a page loader passes the value through and applies status + headers to the response", async () => {
  const loader = () => data({ title: "Hi" }, { status: 201, headers: { "X-Loader": "1" } });
  const ctx = createRequestContext(new Request("http://localhost/"));
  const value = await runWithContext(ctx, () => runLoader(loader, {}));
  // The VALUE reaches useLoaderData unchanged (not a JSON Response), and the init lands on
  // the request context for `finalize` to apply to the outgoing response.
  assertEquals(value, { title: "Hi" });
  assertEquals(ctx.responseStatus, 201);
  assertEquals(ctx.outgoingHeaders.get("X-Loader"), "1");
});

Deno.test("replace(): a loader/action redirect is marked as a history-replace soft nav", async () => {
  // A returned replace() from a page loader surfaces as denext's redirect signal, carrying
  // the `replace` history mode (the action handler threads it to the client's location.replace).
  const ctx = createRequestContext(new Request("http://localhost/"));
  let thrown: unknown;
  try {
    await runWithContext(ctx, () => runLoader(() => replace("/dashboard"), {}));
  } catch (e) {
    thrown = e;
  }
  assert(isRedirect(thrown), "replace() throws denext's redirect signal");
  assertEquals((thrown as { url: string }).url, "/dashboard");
  assertEquals((thrown as { redirectType?: string }).redirectType, "replace");

  // As a resource-route Response, it's a normal HTTP redirect with the mode marker.
  const res = await runActionResponse(
    () => replace("/x", 303),
    new Request("http://localhost/", {
      method: "POST",
    }),
  );
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("Location"), "/x");
});

Deno.test("unstable_parseMultipartFormData buffers file parts via the memory handler", async () => {
  const body = new FormData();
  body.append("name", "Ada");
  body.append("avatar", new File(["PNGDATA"], "a.png", { type: "image/png" }));
  const request = new Request("http://localhost/upload", { method: "POST", body });

  const form = await unstable_parseMultipartFormData(request, unstable_createMemoryUploadHandler());
  assertEquals(form.get("name"), "Ada");
  const file = form.get("avatar") as File;
  assert(file instanceof File, "file part became a File");
  assertEquals(file.name, "a.png");
  assertEquals(await file.text(), "PNGDATA");
});

Deno.test("remixMeta maps Remix descriptors to denext Metadata", async () => {
  const meta = () => [
    { title: "Concerts" },
    { name: "description", content: "All shows" },
    { property: "og:type", content: "website" },
  ];
  const gen = remixMeta(meta, undefined)!;
  const md = await gen({ params: {}, searchParams: new URLSearchParams() });
  assertEquals(md.title, "Concerts");
  assertEquals(md.description, "All shows");
  assert(md.meta?.["og:type"] === "website");
});

Deno.test("denext/remix (the @remix-run/react surface) re-exports the isomorphic data helpers", async () => {
  const client = await import("../src/compat/remix/mod.ts");
  const server = await import("../src/compat/remix/server.ts");
  // `@remix-run/react` re-exports these; an action module may import `redirect` from it.
  assertEquals(client.redirect, server.redirect);
  assertEquals(client.json, server.json);
  assertEquals(client.data, server.data);
  assertEquals(client.replace, server.replace);
  assertEquals(client.redirectDocument, server.redirectDocument);
  const res = client.redirect("/login", 303);
  assertEquals(res.status, 303);
  assertEquals(res.headers.get("Location"), "/login");
  assertEquals(client.data({ ok: true }, 201).init?.status, 201);
});

Deno.test("remixMeta: meta() receives Remix `matches` (ancestor loader data) + location; loaders run once per request", async () => {
  const { runLoaderOnce } = await import("../src/compat/remix/server.ts");
  let layoutRuns = 0;
  const layoutLoader = () => {
    layoutRuns++;
    return { owner: "kody" };
  };
  const layoutMeta = remixMeta(undefined, layoutLoader, "routes/users+/$username_+/notes", {
    crumb: 1,
  })!;
  const pageMeta = remixMeta(
    ({ matches, location }) => {
      const notes = matches.find((m) => m.id === "routes/users+/$username_+/notes");
      return [{ title: `${(notes?.data as { owner: string }).owner} @ ${location.pathname}` }];
    },
    () => ({ page: true }),
    "routes/users+/$username_+/notes.index",
  )!;
  const request = new Request("http://localhost/users/kody/notes?x=1");
  const md = await runWithContext(createRequestContext(request), async () => {
    // Layout metadata resolves before the page's (outer → inner), as buildPageContext does.
    assertEquals(
      await layoutMeta({ params: { username: "kody" }, searchParams: new URLSearchParams() }),
      {},
    );
    const page = await pageMeta({
      params: { username: "kody" },
      searchParams: new URLSearchParams(),
    });
    // The render re-asks for the layout's data: the memoized result, not a second query.
    await runLoaderOnce("routes/users+/$username_+/notes", layoutLoader, { username: "kody" });
    return page;
  });
  assertEquals(md.title, "kody @ /users/kody/notes");
  assertEquals(layoutRuns, 1, "a loader runs once per request");
});

Deno.test("a thrown Remix Response reaches the boundary unredacted in production (isExposedError)", async () => {
  const { toClientError, isExposedError } = await import("../src/runtime/error-boundary.ts");
  const { runLoader } = await import("../src/compat/remix/server.ts");
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  g.__denextDev = false;
  try {
    let thrown: unknown;
    try {
      await runLoader(() => {
        throw new Response("Not found", { status: 404 });
      }, {});
    } catch (e) {
      thrown = e;
    }
    assert(isExposedError(thrown), "a RemixRouteErrorResponse is flagged for exposure");
    assertEquals(toClientError(thrown), thrown, "passed through, not replaced by a digest error");
    assertEquals((thrown as unknown as { status: number }).status, 404);
    assertEquals(toClientError(new Error("db dsn leaked")).message, "Internal Server Error");
  } finally {
    if (prev === undefined) delete g.__denextDev;
    else g.__denextDev = prev;
  }
});

Deno.test("remixMeta: a Remix links() export becomes <link> tags in the head (stylesheet ?url, icons)", async () => {
  const gen = remixMeta(
    () => [{ title: "Home" }],
    undefined,
    "root",
    undefined,
    () => [
      { rel: "stylesheet", href: "/_denext/client/assets/tailwind-abc.css" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg", crossOrigin: "anonymous" },
      { rel: "preload", href: "/sprite.svg", as: "image" },
    ],
  )!;
  const md = await gen({ params: {}, searchParams: new URLSearchParams() });
  assertEquals(md.title, "Home");
  assertStringIncludes(
    md.head ?? "",
    '<link rel="stylesheet" href="/_denext/client/assets/tailwind-abc.css">',
  );
  assertStringIncludes(md.head ?? "", 'crossorigin="anonymous"');
  assertStringIncludes(md.head ?? "", '<link rel="preload" href="/sprite.svg" as="image">');
  // links() alone (no meta) still yields the head.
  const only = remixMeta(
    undefined,
    undefined,
    undefined,
    undefined,
    () => [{ rel: "icon", href: "/i.png" }],
  )!;
  assertEquals(
    (await only({ params: {}, searchParams: new URLSearchParams() })).head,
    '<link rel="icon" href="/i.png">',
  );
});

Deno.test("route-path: a Remix route id + params → the pathname it matched; `to` resolves route-relative", async () => {
  const { remixRoutePathname, resolveRoutePath } = await import(
    "../src/compat/remix/route-path.ts"
  );
  assertEquals(remixRoutePathname("root", {}), "/");
  assertEquals(remixRoutePathname("routes/_index", {}), "/");
  assertEquals(remixRoutePathname("routes/users+/index", {}), "/users");
  assertEquals(
    remixRoutePathname("routes/users+/$username_+/notes", { username: "kody" }),
    "/users/kody/notes",
  );
  assertEquals(
    remixRoutePathname("routes/users+/$username_+/notes.$noteId_.edit", {
      username: "kody",
      noteId: "n1",
    }),
    "/users/kody/notes/n1/edit",
  );
  assertEquals(remixRoutePathname("routes/_auth+/login", {}), "/login");
  assertEquals(
    remixRoutePathname("routes/settings+/profile.two-factor.index", {}),
    "/settings/profile/two-factor",
  );
  assertEquals(remixRoutePathname("routes/_seo+/sitemap[.]xml", {}), "/sitemap.xml");
  assertEquals(remixRoutePathname("routes/files.$", { "*": "a/b" }), "/files/a/b");
  assertEquals(remixRoutePathname("routes/concerts.$city/route", { city: "sf" }), "/concerts/sf");
  // `<Link to="new">` in the notes layout → /users/kody/notes/new (not the URL's parent).
  assertEquals(resolveRoutePath("new", "/users/kody/notes"), "/users/kody/notes/new");
  assertEquals(resolveRoutePath("../edit", "/users/kody/notes/n1"), "/users/kody/notes/edit");
  assertEquals(resolveRoutePath("/abs", "/users/kody/notes"), "/abs");
  assertEquals(resolveRoutePath("?q=1", "/users"), "/users?q=1");
  assertEquals(resolveRoutePath("https://x.test/a", "/users"), "https://x.test/a");
  assertEquals(resolveRoutePath("new?x=1#h", "/n"), "/n/new?x=1#h");
});

Deno.test("document shell: DocumentHtml/DocumentBody record attributes for the server document", async () => {
  const { DocumentHtml, DocumentBody, DocumentHead } = await import("../src/compat/remix/mod.ts");
  await import("../src/compat/remix/server.ts"); // installs the request-context sink
  const { renderDocument } = await import("../src/server/document.ts");
  const request = new Request("http://localhost/");
  const ctx = createRequestContext(request);
  const html = await runWithContext(ctx, () =>
    renderToString(
      h(
        DocumentHtml,
        { lang: "fr", className: "dark h-full" } as never,
        h(DocumentHead, null, h("meta", { name: "robots", content: "noindex" })),
        h(DocumentBody, { className: "bg-background" } as never, h("main", null, "app")),
      ),
    ));
  assertEquals(html, '<meta name="robots" content="noindex"><main>app</main>');
  assertEquals(ctx.documentAttrs, {
    html: { lang: "fr", className: "dark h-full" },
    body: { className: "bg-background" },
  });
  const doc = renderDocument({
    bodyHtml: html,
    metadata: {},
    htmlAttrs: ctx.documentAttrs?.html,
    bodyAttrs: ctx.documentAttrs?.body,
  });
  assertStringIncludes(doc, '<html lang="fr" class="dark h-full">');
  assertStringIncludes(doc, '<body class="bg-background">');
});

Deno.test("defineLoadContext: loaders/actions receive the provider's context, computed once per request", async () => {
  let calls = 0;
  defineLoadContext(({ request }) => ({ n: ++calls, url: request.url }));
  try {
    const seen: unknown[] = [];
    const loader = ({ context }: LoaderFunctionArgs) => {
      seen.push(context);
      return { ok: true };
    };
    const request = new Request("http://localhost/a");
    await runWithContext(createRequestContext(request), async () => {
      await runLoader(loader, {});
      await runLoaderResponse(loader, request);
      await runActionResponse(loader, request);
    });
    assertEquals(seen.length, 3);
    assertEquals(seen[0], { n: 1, url: "http://localhost/a" });
    assertEquals(seen[1], seen[0], "one getLoadContext per request");
    assertEquals(seen[2], seen[0]);
    await runWithContext(createRequestContext(new Request("http://localhost/b")), async () => {
      await runLoader(loader, {});
    });
    assertEquals(seen[3], { n: 2, url: "http://localhost/b" }, "a new request → a new context");
  } finally {
    clearLoadContext();
  }
  const bare: unknown[] = [];
  await runLoader(({ context }: LoaderFunctionArgs) => void bare.push(context), {});
  assertEquals(bare, [{}], "no provider → an empty context");
});

Deno.test("remixServerBuild synthesizes a flat Remix ServerBuild from the manifest + route markers", async () => {
  const Comp = () => null;
  const manifest = {
    pages: [
      {
        kind: "page",
        pattern: [],
        routePath: "/",
        filePath: "/app/page.tsx",
        layoutChain: ["/app/layout.tsx"],
        layoutDepths: [0],
        loading: null,
        error: null,
        notFound: null,
        forbidden: null,
        unauthorized: null,
        templateChain: [],
      },
      {
        kind: "page",
        pattern: parsePattern("users/[username]/notes"),
        routePath: "/users/[username]/notes",
        filePath: "/app/users/[username]/notes/page.tsx",
        layoutChain: ["/app/layout.tsx", "/app/users/[username]/layout.tsx"],
        layoutDepths: [0, 2],
        loading: null,
        error: null,
        notFound: null,
        forbidden: null,
        unauthorized: null,
        templateChain: [],
      },
    ],
    api: [
      {
        kind: "api",
        pattern: parsePattern("sitemap.xml"),
        routePath: "/sitemap.xml",
        filePath: "/app/sitemap.xml/route.ts",
      },
      // A page's own POST handler shares the page's id — not a second route.
      {
        kind: "api",
        pattern: parsePattern("users/[username]/notes"),
        routePath: "/users/[username]/notes",
        filePath: "/app/users/[username]/notes/route.ts",
      },
    ],
    rootLayout: "/app/layout.tsx",
    rootNotFound: null,
    rootGlobalError: null,
  } as unknown as RouteManifest;
  const handle = { getSitemapEntries: () => null };
  const modules: Record<string, Record<string, unknown>> = {
    "/app/layout.tsx": { default: Comp, remixRoute: { id: "root", module: { loader: () => 1 } } },
    "/app/page.tsx": { default: Comp, remixRoute: { id: "routes/_index", module: {} } },
    "/app/users/[username]/layout.tsx": {
      default: Comp,
      remixRoute: { id: "routes/users+/$username", module: {} },
    },
    "/app/users/[username]/notes/page.tsx": {
      default: Comp,
      remixRoute: { id: "routes/users+/$username_+/notes", module: { handle } },
    },
    "/app/sitemap.xml/route.ts": {
      GET: () => null,
      remixRoute: { id: "routes/_seo+/sitemap[.]xml", module: { loader: () => 2 } },
    },
    "/app/users/[username]/notes/route.ts": {
      POST: () => null,
      remixRoute: { id: "routes/users+/$username_+/notes", module: { handle } },
    },
  };
  const ctx = createRequestContext(new Request("http://localhost/sitemap.xml"));
  ctx.routes = { manifest: () => manifest, load: (f) => Promise.resolve(modules[f]) };
  const build = await runWithContext(ctx, async () => {
    const first = await remixServerBuild();
    assert(first === await remixServerBuild(), "memoized per request");
    return first;
  });
  assertEquals(build.build, build, "`.build` aliases the build (the { error, build } shape)");
  assertEquals(build.error, undefined);
  assertEquals(
    Object.keys(build.routes).sort(),
    [
      "root",
      "routes/_index",
      "routes/_seo+/sitemap[.]xml",
      "routes/users+/$username",
      "routes/users+/$username_+/notes",
    ],
  );
  assertEquals(build.routes.root.path, "");
  assertEquals(typeof build.routes.root.module.loader, "function");
  const index = build.routes["routes/_index"];
  assertEquals(index.index, true);
  assertEquals(index.path, undefined);
  assertEquals(index.parentId, "root");
  assertEquals(index.module.default, Comp);
  const notes = build.routes["routes/users+/$username_+/notes"];
  assertEquals(notes.path, "users/:username/notes", "the full pattern, Remix-style");
  assertEquals(notes.module.handle, handle);
  assertEquals(notes.module.default, Comp);
  assertEquals(build.routes["routes/users+/$username"].path, "users/:username");
  const sitemap = build.routes["routes/_seo+/sitemap[.]xml"];
  assertEquals(sitemap.path, "sitemap.xml");
  assert(!("default" in sitemap.module), "a resource route has no component");
  assertEquals(typeof sitemap.module.loader, "function");
  // Outside a request (or without a registry): just the root.
  assertEquals(Object.keys((await remixServerBuild()).routes), ["root"]);
  assertEquals(remixPath(parsePattern("docs/[...slug]")), "docs/*");
});

Deno.test("runLoaderOnce memoizes a THROW too: two readers, one loader run, the same error", async () => {
  let runs = 0;
  const loader = () => {
    runs++;
    throw new Error("boom-once");
  };
  await runWithContext(createRequestContext(new Request("http://localhost/x")), async () => {
    const a = await runLoaderOnce("routes/x", loader, {}).catch((e: unknown) => e);
    const b = await runLoaderOnce("routes/x", loader, {}).catch((e: unknown) => e);
    assertEquals(runs, 1);
    assert(a instanceof Error && a === b, "the same rejection is re-raised");
  });
});

Deno.test("resolveRoutePath: `..` climbs without a trailing slash; an explicit trailing slash is kept; root stays /", () => {
  assertEquals(resolveRoutePath("..", "/users/kody/notes"), "/users/kody");
  assertEquals(resolveRoutePath("..", "/users"), "/");
  assertEquals(resolveRoutePath("../edit?x=1", "/a/b/c"), "/a/b/edit?x=1");
  assertEquals(resolveRoutePath("new/", "/notes"), "/notes/new/");
  assertEquals(resolveRoutePath(".", "/a/b"), "/a/b");
});

Deno.test("remixServerBuild never rejects: a failing manifest yields the root-only build (warned)", async () => {
  const ctx = createRequestContext(new Request("http://localhost/sitemap.xml"));
  ctx.routes = {
    manifest: () => {
      throw new Error("manifest exploded");
    },
    load: () => Promise.reject(new Error("no")),
  };
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
  try {
    const build = await runWithContext(ctx, () => remixServerBuild());
    assertEquals(Object.keys(build.routes), ["root"]);
    assert(warned.some((w) => w.includes("remixServerBuild failed")));
  } finally {
    console.warn = warn;
  }
});

Deno.test("applyDocumentAttrs: root attrs go through the attribute-name chokepoint (no on*, no tag breakouts)", () => {
  const set = new Map<string, string>();
  const removed: string[] = [];
  const el = {
    style: {} as Record<string, string>,
    setAttribute: (k: string, v: string) => void set.set(k, v),
    removeAttribute: (k: string) => void removed.push(k),
  } as unknown as Element;
  applyDocumentAttrs(el, {
    lang: "en",
    className: "dark h-full",
    style: { colorScheme: "dark" },
    onload: "alert(1)",
    'x"><script': "1",
    hidden: true,
    "data-old": null,
  });
  assertEquals(set.get("lang"), "en");
  assertEquals(set.get("class"), "dark h-full");
  assertEquals(set.get("hidden"), "");
  assertEquals((el as unknown as { style: Record<string, string> }).style.colorScheme, "dark");
  assertEquals(removed, ["data-old"]);
  assert(!set.has("onload"), "event-handler attributes never reach the DOM");
  assert(![...set.keys()].some((k) => k.includes("<")), "a breakout name is dropped");
});
