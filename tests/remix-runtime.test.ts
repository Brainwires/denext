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
  json,
  redirect,
  remixMeta,
  RemixRoute,
  runActionResponse,
  runLoader,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "../src/compat/remix/server.ts";
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

Deno.test("shouldRevalidate: a route whose data was NOT echoed (too large) still revalidates", async () => {
  let loaderCalls = 0;
  const req = new Request("http://x/new", {
    // `routes/big` is offered but its data isn't echoed (would exceed the budget) → must load.
    headers: {
      [REVALIDATE_HEADER]: "routes/big",
      [LOADER_DATA_HEADER]: "{}",
      [FROM_HEADER]: "/old",
    },
  });
  const vnode = await runWithContext(
    createRequestContext(req),
    () =>
      RemixRoute({
        id: "routes/big",
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
