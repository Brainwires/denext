// The Pages Router browser runtime (`client-runtime.ts`) driven through the fake DOM:
// hydration bootstrap from `__NEXT_DATA__`, soft navigation (data fetch + chunk registry
// + history), shallow/redirect/not-found/failure/superseded outcomes, fallback-shell
// completion, prefetch, and link/popstate interception. No real browser, no bundling.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { flushSync, setDocument } from "../src/client/reconciler.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  bootstrapPages,
  navigate,
  prefetchRoute,
  queryFromSearch,
  registerPage,
} from "../packages/pages-router/src/client-runtime.ts";
import { Router } from "../packages/pages-router/router.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- browser globals ----------------------------------------------------------------

const calls = { assign: [] as string[], reload: 0, push: [] as string[], replace: [] as string[] };
const loc = { href: "http://app.test/", origin: "http://app.test" } as {
  href: string;
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  assign(href: string): void;
  reload(): void;
};
Object.defineProperties(loc, {
  pathname: { get: () => new URL(loc.href).pathname },
  search: { get: () => new URL(loc.href).search },
  hash: { get: () => new URL(loc.href).hash },
});
loc.assign = (href) => calls.assign.push(href);
loc.reload = () => calls.reload++;
(globalThis as Any).location = loc;
(globalThis as Any).history = {
  pushState: (_s: unknown, _t: string, url: string) => {
    calls.push.push(url);
    loc.href = new URL(url, loc.href).href;
  },
  replaceState: (_s: unknown, _t: string, url: string) => {
    calls.replace.push(url);
    loc.href = new URL(url, loc.href).href;
  },
  back() {},
  forward() {},
};
(globalThis as Any).scrollTo = () => {};

/** A queue of scripted fetch responses; each navigation consumes one. */
const responses: Array<() => Promise<Response>> = [];
const fetched: string[] = [];
(globalThis as Any).fetch = (url: string) => {
  fetched.push(url);
  const next = responses.shift();
  if (!next) throw new Error(`unexpected fetch ${url}`);
  return next();
};
const json = (body: unknown) => () => Promise.resolve(Response.json(body));

// ---- the server-rendered document ----------------------------------------------------

const { doc, container } = makeDom();
setDocument(doc as Any);
(globalThis as Any).document = doc;
const nextData = doc.createElement("script");
nextData.textContent = JSON.stringify({
  props: { pageProps: {} },
  page: "/",
  query: {},
  asPath: "/",
  isFallback: true, // a `fallback: true` shell: the runtime fetches the real props after boot
  basePath: "",
});
doc.register("__NEXT_DATA__", nextData);
const main = doc.createElement("main");
main.appendChild(doc.createTextNode("Home"));
container.appendChild(main);
doc.register("__next", container);

const Home = (props: Record<string, unknown>) => h("main", null, (props.title as string) ?? "Home");
const About = (props: Record<string, unknown>) => h("section", null, `About ${props.n ?? 0}`);
registerPage("/", Home);
registerPage("/about", About);

const flush = () => new Promise((r) => setTimeout(r, 0));
const events: string[] = [];

Deno.test("bootstrapPages hydrates __next from __NEXT_DATA__ and completes a fallback shell", async () => {
  responses.push(json({ page: "/", pageProps: { title: "Home!" }, query: {}, asPath: "/" }));
  bootstrapPages({ App: null });
  bootstrapPages({ App: null }); // idempotent
  assertEquals(doc.documentElement.getAttribute("data-denext-pages-hydrated"), "1");
  Router.events.on("routeChangeStart", (as: string) => events.push(`start ${as}`));
  Router.events.on("routeChangeComplete", (as: string) => events.push(`complete ${as}`));
  Router.events.on(
    "routeChangeError",
    (err: Error & { cancelled: boolean }) =>
      events.push(`error ${err.cancelled ? "cancelled" : "failed"}`),
  );
  await flush();
  flushSync();
  assertStringIncludes(
    container.textContent,
    "Home!",
    "the fallback shell re-rendered with real props",
  );
  assertEquals(Router.router?.isFallback, false);
});

Deno.test("navigate fetches the route's data, renders it, and pushes history", async () => {
  responses.push(json({ page: "/about", pageProps: { n: 7 }, query: {}, asPath: "/about" }));
  assertEquals(await navigate("/about", {}), true);
  flushSync();
  assertStringIncludes(container.textContent, "About 7");
  assertEquals(calls.push.at(-1), "/about");
  assert(fetched.at(-1)!.endsWith("/about"));
  assertEquals(Router.pathname, "/about");
  assertEquals(events.at(-2), "start /about");
  assertEquals(events.at(-1), "complete /about");
});

Deno.test("a shallow navigation on the same page swaps the query without a fetch", async () => {
  const before = fetched.length;
  assertEquals(await navigate("/about?tab=2", { shallow: true, replace: true }), true);
  assertEquals(fetched.length, before);
  assertEquals(calls.replace.at(-1), "/about?tab=2");
  assertEquals(Router.query, { tab: "2" });
});

Deno.test("a redirect from the data endpoint hard-navigates; notFound falls back to a load", async () => {
  responses.push(json({ redirect: { destination: "/elsewhere" } }));
  assertEquals(await navigate("/about", {}), false);
  assertEquals(calls.assign.at(-1), "/elsewhere");
  responses.push(json({ notFound: true }));
  assertEquals(await navigate("/missing", {}), false);
  assertEquals(calls.assign.at(-1), "/missing");
  assertEquals(events.at(-1), "error failed");
});

Deno.test("a failed fetch, a non-JSON response, and an unregistered chunk all fall back", async () => {
  responses.push(() => Promise.reject(new Error("offline")));
  assertEquals(await navigate("/about", {}), false);
  responses.push(() => Promise.resolve(new Response("<html>", { status: 200 })));
  assertEquals(await navigate("/about", {}), false);
  responses.push(json({ page: "/nowhere", pageProps: {}, query: {}, asPath: "/nowhere" }));
  assertEquals(await navigate("/nowhere", {}), false);
  assertEquals(calls.assign.slice(-3), ["/about", "/about", "/nowhere"]);
  // From a popstate the fallback reloads instead (no duplicate history entry).
  responses.push(() => Promise.reject(new Error("offline")));
  const reloads = calls.reload;
  assertEquals(await navigate("/about", { fromPop: true }), false);
  assertEquals(calls.reload, reloads + 1);
});

Deno.test("a superseded navigation is cancelled; the latest one wins", async () => {
  let releaseFirst!: () => void;
  responses.push(() =>
    new Promise<Response>((resolve) => {
      releaseFirst = () =>
        resolve(Response.json({ page: "/", pageProps: { title: "Old" }, query: {}, asPath: "/" }));
    })
  );
  responses.push(json({ page: "/about", pageProps: { n: 9 }, query: {}, asPath: "/about" }));
  const first = navigate("/", {});
  const second = navigate("/about", {});
  assertEquals(await second, true);
  releaseFirst();
  assertEquals(await first, false);
  assert(events.includes("error cancelled"));
  flushSync();
  assertStringIncludes(container.textContent, "About 9");
});

Deno.test("a cross-origin navigation hands off to the browser", async () => {
  assertEquals(await navigate("https://other.test/x", {}), true);
  assertEquals(calls.assign.at(-1), "https://other.test/x");
});

Deno.test("prefetchRoute warms the stylesheet once and never fetches data", async () => {
  responses.push(json({ page: "/about", entryUrl: null, cssUrl: "/_denext/pages/about.css" }));
  await prefetchRoute("/about");
  await prefetchRoute("/about"); // deduped: no second fetch
  const links = doc.querySelectorAll('link[rel="stylesheet"]');
  assertEquals(links.map((l) => (l as Any).href), ["/_denext/pages/about.css"]);
  await prefetchRoute("https://other.test/"); // cross-origin: ignored
  await prefetchRoute("::not a url::"); // unparsable: ignored
});

Deno.test("link clicks and popstate route through soft navigation", async () => {
  const anchor = {
    href: "http://app.test/about?from=link#top",
    getAttribute: (n: string) => (n === "href" ? "/about?from=link#top" : null),
    hasAttribute: () => false,
  };
  const target = { closest: () => anchor };
  responses.push(
    json({
      page: "/about",
      pageProps: { n: 3 },
      query: { from: "link" },
      asPath: "/about?from=link",
    }),
  );
  doc.dispatch("click", { target, button: 0, defaultPrevented: false });
  await flush();
  assertEquals(calls.push.at(-1), "/about?from=link#top");
  // A modified click, an external link, and a same-page hash link are left to the browser.
  const before = fetched.length;
  doc.dispatch("click", { target, button: 0, metaKey: true });
  doc.dispatch("click", {
    target: {
      closest: () => ({
        ...anchor,
        getAttribute: (n: string) => (n === "rel" ? "external" : "/x"),
      }),
    },
    button: 0,
  });
  doc.dispatch("click", {
    target: {
      closest: () => ({ ...anchor, getAttribute: (n: string) => (n === "href" ? "#top" : null) }),
    },
    button: 0,
  });
  assertEquals(fetched.length, before);
  responses.push(json({ page: "/", pageProps: { title: "Back" }, query: {}, asPath: "/" }));
  loc.href = "http://app.test/";
  globalThis.dispatchEvent(new Event("popstate"));
  await flush();
  flushSync();
  assertStringIncludes(container.textContent, "Back");
  assertEquals(calls.push.at(-1), "/about?from=link#top", "popstate does not push history");
});

Deno.test("queryFromSearch folds repeated keys into arrays", () => {
  assertEquals(queryFromSearch(new URLSearchParams("a=1&b=2&b=3")), { a: "1", b: ["2", "3"] });
});
