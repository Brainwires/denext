// `denext/preact-iso`: preact-iso's router contract on denext — path matching (`exec`), the
// location provider and client navigation, `<Router>` / `<Route>` / `useRoute`, `lazy`,
// `ErrorBoundary`, `prerender` and `locationStub`.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render } from "../src/testing/mod.ts";
import {
  ErrorBoundary,
  exec,
  hydrate,
  lazy,
  LocationProvider,
  locationStub,
  prerender,
  Route,
  Router,
  useLocation,
  useRoute,
} from "../src/compat/preact/iso.ts";

Deno.test("exec: literals, params, optional, rest and wildcard segments", () => {
  assertEquals(exec("/user/7", "/user/:id")?.params, { id: "7" });
  assertEquals(exec("/user/7", "/user/:id")?.id, "7");
  assertEquals(exec("/user", "/user/:id"), undefined);
  assertEquals(exec("/user", "/user/:id?")?.params, { id: undefined } as never);
  assertEquals(exec("/a/b%20c/d", "/a/:rest+")?.params, { rest: "b c/d" });
  assertEquals(exec("/a", "/a/:rest*")?.params, { rest: undefined } as never);
  assertEquals(exec("/files/x/y", "/files/*")?.rest, "/x/y");
  assertEquals(exec("/other", "/user/:id"), undefined);
  assertEquals(exec("/", "/")?.params, {});
});

/** Stub the browser location and history the provider reads and writes. */
function stubBrowser(path: string): { pushed: string[] } {
  const pushed: string[] = [];
  const g = globalThis as Record<string, unknown>;
  g.location = {
    pathname: path.split("?")[0],
    search: path.includes("?") ? "?" + path.split("?")[1] : "",
    origin: "http://localhost",
  };
  g.history = {
    pushState: (_s: unknown, _t: string, url: string) => pushed.push(url),
    replaceState: (_s: unknown, _t: string, url: string) => pushed.push("replace:" + url),
    back: () => pushed.push("back"),
    forward: () => pushed.push("forward"),
  };
  return { pushed };
}

Deno.test("Router renders the matching route (else the default) and follows route()", async () => {
  const { pushed } = stubBrowser("/user/7?tab=a");
  let nav: ReturnType<typeof useLocation> | null = null;
  function User(props: { id: string }) {
    const r = useRoute();
    return h("p", null, `user ${props.id} ${r.params.id} ${r.query.tab}`);
  }
  function Home() {
    return h("p", null, "home");
  }
  function NotFound() {
    return h("p", null, "missing");
  }
  function Nav() {
    nav = useLocation();
    return null as never;
  }
  const changes: string[] = [];
  const screen = await render(
    h(
      LocationProvider,
      null,
      h(Nav, null),
      h(Router, { onRouteChange: (u: string) => changes.push(u) }, [
        h(Route, { path: "/", component: Home, key: "h" }),
        h(Route, { path: "/user/:id", component: User, key: "u" }),
        h(Route, { default: true, component: NotFound, key: "n" }),
      ] as never),
    ),
  );
  assertEquals(screen.html(), "<p>user 7 7 a</p>");
  assertEquals(nav!.path, "/user/7");
  await screen.act(() => nav!.route("/"));
  assertEquals(screen.html(), "<p>home</p>");
  await screen.act(() => nav!.route("/nope", true));
  assertEquals(screen.html(), "<p>missing</p>");
  nav!.back();
  nav!.forward();
  assertEquals(pushed, ["/", "replace:/nope", "back", "forward"]);
  assertEquals(changes.at(-1), "/nope");
  await screen.unmount();
});

Deno.test("lazy loads a module's default export (or the component), preload starts it", async () => {
  stubBrowser("/");
  const Page = lazy(() => Promise.resolve({ default: () => h("b", null, "lazy page") }));
  await Page.preload();
  const screen = await render(
    h(LocationProvider, null, h(Router, null, h(Route, { path: "/", component: Page }))),
  );
  await screen.act(() => new Promise((r) => setTimeout(r, 10)));
  assertEquals(screen.html(), "<b>lazy page</b>");
  await screen.unmount();
  const Bare = lazy(() => Promise.resolve(() => h("i", null, "bare")));
  assertEquals(typeof (await Bare.preload()), "object");
});

Deno.test("ErrorBoundary reports a render error and renders nothing in its place", async () => {
  const errors: unknown[] = [];
  function Boom(): never {
    throw new Error("boom");
  }
  const screen = await render(
    h(ErrorBoundary, { onError: (e: unknown) => errors.push(e) }, h(Boom, null)),
  );
  assertEquals(screen.html(), "");
  assertEquals((errors[0] as Error).message, "boom");
});

Deno.test("prerender returns the HTML and its links; locationStub; hydrate without a document", async () => {
  const App = (p: { name?: string }) =>
    h(
      "div",
      null,
      h("a", { href: "/a" }, p.name ?? "x"),
      h("a", { href: "/b", target: "_blank" }, "b"),
    );
  const out = await prerender(App as never, { props: { name: "n" } });
  assertStringIncludes(out.html, '<a href="/a">n</a>');
  assertStringIncludes(out.html, '<script type="isodata"></script>');
  assertEquals([...out.links], ["/a"]);
  assertEquals((await prerender(h(App, null))).links.size, 1);
  locationStub("/x/y?z=1");
  assertEquals(
    (globalThis as unknown as { location: { pathname: string } }).location.pathname,
    "/x/y",
  );
  hydrate(h("p", null));
});

Deno.test("a same-origin link click navigates on the client; others are left to the browser", async () => {
  const { pushed } = stubBrowser("/");
  let nav: ReturnType<typeof useLocation> | null = null;
  function Nav() {
    nav = useLocation();
    return null as never;
  }
  const screen = await render(h(LocationProvider, { scope: "/" }, h(Nav, null)));
  const link = (attrs: Record<string, unknown>) => ({
    nodeName: "A",
    href: `http://localhost${attrs.href}`,
    origin: "http://localhost",
    target: "",
    download: "",
    getAttribute: () => attrs.href,
    ...attrs,
  });
  const click = (target: unknown, init: Record<string, unknown> = {}) => {
    const e = new Event("click", { cancelable: true });
    Object.assign(e, {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    });
    Object.defineProperty(e, "composedPath", { value: () => [target] });
    dispatchEvent(e);
    return e.defaultPrevented;
  };
  await screen.act(() => {
    assertEquals(click(link({ href: "/about" })), true);
  });
  assertEquals(nav!.url, "/about");
  assertEquals(click(link({ href: "/x" }), { metaKey: true }), false);
  assertEquals(click(link({ href: "/x", target: "_blank" })), false);
  assertEquals(click(link({ href: "#top" })), false);
  assertEquals(click(link({ href: "/x", origin: "http://other" })), false);
  assertEquals(click({ nodeName: "DIV" }), false);
  await screen.act(() => {
    dispatchEvent(new Event("popstate"));
  });
  assertEquals(pushed, ["/about"]);
  await screen.unmount();
});
