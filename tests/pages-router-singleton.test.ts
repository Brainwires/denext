// next/router parity additions: the `withRouter` HOC and the `Router` singleton
// (next/router's default export) that proxies the active client router.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  __setActiveRouter,
  type NextRouter,
  Router,
  withRouter,
  type WithRouterProps,
} from "../packages/pages-router/router.ts";

function mockRouter(over: Partial<NextRouter> = {}): NextRouter {
  return {
    route: "/mock",
    pathname: "/mock",
    query: { a: "1" },
    asPath: "/mock?a=1",
    basePath: "",
    isReady: true,
    push: () => Promise.resolve(true),
    replace: () => Promise.resolve(true),
    reload: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => Promise.resolve(),
    events: { on() {}, off() {}, emit() {} },
    ...over,
  };
}

Deno.test("withRouter injects a `router` prop", async () => {
  function Page(props: WithRouterProps & { label: string }) {
    return h("p", null, `${props.label}:${props.router.pathname}`);
  }
  const Wrapped = withRouter(Page);
  // No provider → useRouter falls back to a location-derived router (pathname "/").
  const html = await renderToString(h(Wrapped as never, { label: "hi" }));
  assertEquals(html, "<p>hi:/</p>");
});

Deno.test("Router singleton proxies the active client router", async () => {
  let pushed: string | null = null;
  __setActiveRouter(mockRouter({ push: (url) => (pushed = url, Promise.resolve(true)) }));
  try {
    assertEquals(Router.pathname, "/mock");
    assertEquals(Router.asPath, "/mock?a=1");
    assertEquals(Router.query, { a: "1" });
    assert(Router.router !== null, "Router.router is the active instance");
    await Router.push("/next");
    assertEquals(pushed, "/next");
    let ready = false;
    Router.ready(() => (ready = true));
    assert(ready, "Router.ready runs its callback");
  } finally {
    __setActiveRouter(null);
  }
  // With no active router, the singleton is null but still usable (location fallback).
  assertEquals(Router.router, null);
});
