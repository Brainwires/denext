// Fresh's partial navigation (`denext/fresh/partial`) driven without a browser, in a child
// process of its own (tests/fresh-partial-nav.test.ts): a stand-in `document` / `location` /
// `history` / `fetch` takes the document listeners the regions install, and each scenario
// dispatches the event a browser would (a button click, a link click that denext's own
// navigation hands to the soft-nav blocker, a GET and a POST form) and reports what was fetched,
// pushed and rendered. The real-browser run is tests/e2e/fresh-partials.e2e.test.ts.

import { h } from "../../src/jsx/jsx-runtime.ts";
import type { VNode } from "../../src/jsx/types.ts";
import { render } from "../../src/testing/mod.ts";
import { navigate } from "../../src/client/navigation.ts";
import { setFlightParser } from "../../src/client/flight-nav.ts";
import { Partial } from "../../src/compat/fresh/partial.ts";

const ORIGIN = "http://app.test";

/** A stand-in element: attributes, a parent, and the `closest()` selectors the code asks. */
class El {
  parent: El | null = null;
  attrs: Record<string, string>;
  constructor(readonly tagName: string, attrs: Record<string, string> = {}, parent?: El) {
    this.attrs = attrs;
    this.parent = parent ?? null;
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  listeners: Record<string, (() => void)[]> = {};
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  closest(selector: string): El | null {
    const attr = /^\[(.+)\]$/.exec(selector)?.[1];
    const matches = attr ? this.hasAttribute(attr) : this.tagName === selector;
    return matches ? this : this.parent?.closest(selector) ?? null;
  }
  get href(): string {
    return new URL(this.attrs.href ?? "", ORIGIN + "/").href;
  }
  get type(): string {
    return this.attrs.type ?? "submit";
  }
  form: El | null = null;
}

/** A stand-in `<form>` (the code checks `instanceof HTMLFormElement`). */
class FormEl extends El {
  constructor(attrs: Record<string, string>, readonly fields: [string, string][], parent: El) {
    super("form", attrs, parent);
  }
  get method(): string {
    return this.attrs.method ?? "get";
  }
  get action(): string {
    return new URL(this.attrs.action ?? "", ORIGIN + "/").href;
  }
}

type Listener = (e: unknown) => void;

/** What one scenario observed. */
export interface PartialNavReport {
  fetched: { url: string; method: string; body: string | null; nav: string | null }[];
  pushed: string[];
  replaced: string[];
  html: string[];
  title: string;
  assigned: string[];
  ignored: number;
  /** Every request made to another origin (an `f-partial` naming one must never be fetched). */
  foreign: string[];
  /** What denext's own navigation fetched for a link whose foreign `f-partial` was declined. */
  declined: string[];
}

/** Run every scenario and report what happened. */
// fallow-ignore-next-line unused-export -- imported by the child process tests/fresh-partial-nav.test.ts starts
export async function runPartialNavScenarios(): Promise<PartialNavReport> {
  const listeners: { type: string; fn: Listener; capture: boolean }[] = [];
  const report: PartialNavReport = {
    fetched: [],
    pushed: [],
    replaced: [],
    html: [],
    title: "",
    assigned: [],
    ignored: 0,
    foreign: [],
    declined: [],
  };
  const loc = { href: ORIGIN + "/", origin: ORIGIN, pathname: "/", search: "", hash: "" };
  const g = globalThis as Record<string, unknown>;
  const fakeDocument = {
    title: "",
    addEventListener: (type: string, fn: Listener, capture?: boolean) =>
      listeners.push({ type, fn, capture: capture === true }),
  };
  g.document = fakeDocument;
  g.location = new Proxy(loc, {
    set(target, key, value) {
      if (key === "href") report.assigned.push(String(value));
      (target as Record<string | symbol, unknown>)[key] = value;
      return true;
    },
  });
  const fakeHistory = {
    state: null as unknown,
    pushState: (state: unknown, _t: string, url: string) => {
      report.pushed.push(url);
      fakeHistory.state = state;
      loc.href = new URL(url, loc.href).href;
    },
    replaceState: (state: unknown, _t: string, url: string) => {
      report.replaced.push(url);
      fakeHistory.state = state;
      loc.href = new URL(url, loc.href).href;
    },
  };
  g.history = fakeHistory;
  g.scrollTo = () => {};
  g.HTMLFormElement = FormEl;
  const RealFormData = FormData;
  g.FormData = function (form: FormEl) {
    const data = new RealFormData();
    for (const [k, v] of form.fields) data.append(k, v);
    return data;
  };

  // Each answer: the partials a URL's page renders, as its parsed Flight tree.
  const trees: Record<string, VNode> = {
    "/parts/recipe": h(Partial, { name: "recipe" }, "Lemonade"),
    "/parts/more": h("div", null, h(Partial, { name: "list", mode: "append", key: "two" }, "+two")),
    "/search": h(Partial, { name: "recipe" }, "found"),
    "/save": h(Partial, { name: "list", mode: "prepend" }, "saved+"),
  };
  setFlightParser((flight) => trees[flight as string]);
  g.fetch = (input: URL, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.origin !== ORIGIN) report.foreign.push(url.href);
    const headers = new Headers(init.headers);
    const body = init.body instanceof RealFormData ? [...init.body].join("&") : null;
    report.fetched.push({
      url: url.pathname + url.search,
      method: (init.method ?? "get").toLowerCase(),
      body,
      nav: headers.get("x-denext-nav"),
    });
    const tree = url.pathname in trees ? url.pathname : null;
    const res = tree
      ? new Response(JSON.stringify({ flight: tree, title: "Answered" }), {
        headers: { "x-denext-flight": "1" },
      })
      : new Response("<p>no partials</p>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/moved") {
      Object.defineProperty(res, "redirected", { value: true });
      Object.defineProperty(res, "url", { value: ORIGIN + "/landed?fresh-partial=true" });
    }
    return Promise.resolve(res);
  };

  const screen = await render(
    h("main", null, [
      h("p", { key: "r" }, h(Partial, { name: "recipe" }, "start")),
      h("p", { key: "l" }, h(Partial, { name: "list" }, "one")),
    ]),
  );
  const settle = () => screen.act(() => new Promise((r) => setTimeout(r, 20)));
  const fire = async (type: string, event: Record<string, unknown>, capture = false) => {
    const e = { defaultPrevented: false, preventDefault() {}, ...event };
    for (const l of listeners) if (l.type === type && l.capture === capture) l.fn(e);
    await settle();
    report.html.push(screen.container.textContent ?? "");
    return e;
  };

  const nav = new El("div", { "f-client-nav": "" });
  const off = new El("div", { "f-client-nav": "false" }, nav);
  // A <button f-partial>: its partials, no history entry.
  await fire("click", {
    target: new El("button", { type: "button", "f-partial": "/parts/recipe" }, nav),
  });
  // A link: claimed in the capture phase, then denext's navigation asks the soft-nav blocker.
  const link = new El("a", { href: "/?page=2", "f-partial": "/parts/more" }, nav);
  const e = { target: link, defaultPrevented: false, preventDefault() {} };
  for (const l of listeners) if (l.type === "click" && l.capture) l.fn(e);
  report.html.push(screen.container.textContent ?? "");
  await navigate(link.href); // what denext's own link listener does next, in the same dispatch
  await settle();
  report.html.push(screen.container.textContent ?? "");
  // A GET form with an explicit action: its fields in the partial URL.
  const search = new FormEl({ action: "/search" }, [["q", "lemon"]], nav);
  await fire("submit", { target: search, submitter: null });
  // A POST form whose submitter names the partial URL.
  const save = new FormEl({ method: "post" }, [["n", "1"]], nav);
  const saveButton = new El("button", { "f-partial": "/save" }, save);
  await fire("submit", { target: save, submitter: saveButton });
  // A POST answered by a redirect with no partials: the browser follows it.
  await fire("submit", {
    target: new FormEl({ method: "post", action: "/moved" }, [], nav),
    submitter: null,
  });

  // What partial navigation leaves alone.
  const before = report.fetched.length;
  await fire("click", { target: new El("button", { "f-partial": "/parts/recipe" }, off) });
  await fire("click", { target: new El("button", { type: "button" }, nav) });
  await fire("click", {
    target: new El("button", { "f-partial": "/parts/recipe" }, nav),
    defaultPrevented: true,
  });
  await fire("click", { target: new El("span", {}, new El("a", { href: "/x" }, nav)) });
  await fire("submit", { target: new FormEl({}, [], nav), submitter: null }); // no explicit target
  await fire("submit", {
    target: new FormEl({ method: "dialog", action: "/x" }, [], nav),
    submitter: null,
  });
  await fire("click", { target: new El("a", { href: "#top" }, nav) }, true);
  // An `f-partial` naming another origin: never fetched (its answer would be swapped into the
  // page, and a form's fields sent there), so the browser does what it would without one.
  const evil = "https://evil.example/steal";
  await fire("click", { target: new El("button", { type: "button", "f-partial": evil }, nav) });
  await fire("submit", {
    target: new FormEl({ action: "/search", "f-partial": evil }, [["q", "x"]], nav),
    submitter: null,
  });
  const postForm = new FormEl({ method: "post", action: "/save" }, [["token", "t"]], nav);
  await fire("submit", {
    target: postForm,
    submitter: new El("button", { "f-partial": `${evil}?post` }, postForm),
  });
  report.ignored = report.fetched.length - before;
  // A link whose f-partial is foreign: the blocker declines it; denext's own navigation goes on.
  const mark = report.fetched.length;
  const foreignLink = new El("a", { href: "/?page=3", "f-partial": evil }, nav);
  const claim = { target: foreignLink, defaultPrevented: false, preventDefault() {} };
  for (const l of listeners) if (l.type === "click" && l.capture) l.fn(claim);
  await navigate(foreignLink.href).catch(() => {});
  await settle();
  report.declined = report.fetched.splice(mark).map((f) => f.url);
  report.title = fakeDocument.title;
  return report;
}

/** What the head, view-transition and back / forward scenarios observed. */
export interface PartialHistoryReport {
  /** The page head after a partial answer merged its own: `tag attr=value …` per element. */
  head: string[];
  /** The region's text while a new stylesheet loads, then once it has. */
  whileLoading: string;
  afterLoad: string;
  /** How many swaps ran in a view transition: one under `f-view-transition`, then still one. */
  transitions: number[];
  /** The page text after each history step. */
  steps: string[];
  /** What each pop claim answered. */
  claims: unknown[];
  /** The partial requests made. */
  fetched: string[];
}

/** Drive the head merge, the view transition and back / forward through a fake browser. */
// fallow-ignore-next-line unused-export -- imported by the child process tests/fresh-partial-nav.test.ts starts
export async function runPartialHistoryScenarios(): Promise<PartialHistoryReport> {
  const report: PartialHistoryReport = {
    head: [],
    whileLoading: "",
    afterLoad: "",
    transitions: [],
    steps: [],
    claims: [],
    fetched: [],
  };
  const listeners: { type: string; fn: Listener; capture: boolean }[] = [];
  const loc = { href: ORIGIN + "/", origin: ORIGIN, pathname: "/", search: "", hash: "" };
  const g = globalThis as Record<string, unknown>;
  const headChildren: El[] = [
    new El("meta", { name: "description", content: "old" }),
    new El("meta", { charset: "utf-8" }),
    new El("link", { rel: "stylesheet", href: "/a.css" }),
  ];
  let transitions = 0;
  g.document = {
    title: "",
    head: {
      querySelectorAll: (tag: string) => headChildren.filter((c) => c.tagName === tag),
      appendChild: (el: El) => headChildren.push(el),
    },
    createElement: (tag: string) => new El(tag),
    addEventListener: (type: string, fn: Listener, capture?: boolean) =>
      listeners.push({ type, fn, capture: capture === true }),
    startViewTransition: (update: () => void) => {
      transitions++;
      update();
      return { updateCallbackDone: Promise.resolve() };
    },
  };
  g.location = loc;
  const states: unknown[] = [];
  const fakeHistory = {
    state: null as unknown,
    pushState: (state: unknown, _t: string, url: string) => {
      fakeHistory.state = state;
      states.push(state);
      loc.href = new URL(url, loc.href).href;
    },
    replaceState: (state: unknown, _t: string, url: string) => {
      fakeHistory.state = state;
      states.push(state);
      loc.href = new URL(url, loc.href).href;
    },
  };
  g.history = fakeHistory;
  g.scrollTo = () => {};

  const meta = (attrs: Record<string, string>) => h("meta", attrs);
  const trees: Record<string, VNode> = {
    "/parts/styled": h("html", null, [
      h("head", { key: "h" }, [
        meta({ key: "1", name: "description", content: "new" }),
        meta({ key: "2", property: "og:title", content: "Styled" }),
        meta({ key: "3", charSet: "latin1" }),
        h("link", { key: "4", rel: "stylesheet", href: "/a.css" }),
        h("link", { key: "5", rel: "stylesheet", href: "/b.css", crossOrigin: "anonymous" }),
        h("link", { key: "6", rel: "icon", href: "/icon.png" }),
      ]),
      h("body", { key: "b" }, [
        h("svg", { key: "s" }, h("meta", { name: "in-svg", content: "x" })),
        h(Partial, { key: "p", name: "list" }, "styled"),
      ]),
    ]),
    "/parts/plain": h(Partial, { name: "list" }, "one"),
    "/parts/two": h(Partial, { name: "list", mode: "append", key: "two" }, "+two"),
    "/parts/three": h(Partial, { name: "list", mode: "append", key: "three" }, "+three"),
    "/": h(Partial, { name: "list", mode: "append", key: "f" }, "fetched"),
  };
  setFlightParser((flight) => trees[flight as string]);
  g.fetch = (input: URL) => {
    const url = new URL(input);
    report.fetched.push(url.pathname + url.search);
    const body = JSON.stringify({ flight: url.pathname, title: null });
    return Promise.resolve(new Response(body, { headers: { "x-denext-flight": "1" } }));
  };

  const screen = await render(h("main", null, h(Partial, { name: "list" }, "one")));
  const settle = () => screen.act(() => new Promise((r) => setTimeout(r, 20)));
  const text = () => screen.container.textContent ?? "";
  const click = async (target: El) => {
    const e = { target, defaultPrevented: false, preventDefault() {} };
    for (const l of listeners) if (l.type === "click" && !l.capture) l.fn(e);
    await settle();
  };

  // The head merge and the view transition: the swap waits for the new stylesheet.
  const nav = new El("div", { "f-client-nav": "" });
  const vt = new El("div", { "f-view-transition": "" }, nav);
  await click(new El("button", { type: "button", "f-partial": "/parts/styled" }, vt));
  report.whileLoading = text();
  for (const fn of headChildren.find((c) => c.attrs.href === "/b.css")?.listeners.load ?? []) {
    fn();
  }
  await settle();
  report.afterLoad = text();
  report.transitions.push(transitions);
  report.head = headChildren.map((c) =>
    [c.tagName, ...Object.entries(c.attrs).map(([k, v]) => `${k}=${v}`)].join(" ")
  );
  await click(new El("button", { type: "button", "f-partial": "/parts/plain" }, nav));
  report.transitions.push(transitions);

  // Back / forward: two links append to the region, then the pops walk the entries.
  const follow = async (href: string, partial: string) => {
    const link = new El("a", { href, "f-partial": partial }, nav);
    const e = { target: link, defaultPrevented: false, preventDefault() {} };
    for (const l of listeners) if (l.type === "click" && l.capture) l.fn(e);
    await navigate(link.href); // denext's own link listener, in the same dispatch
    await settle();
    report.steps.push(text());
  };
  await follow("/?page=2", "/parts/two");
  await follow("/?page=3", "/parts/three");
  const page2 = states[states.length - 2];
  const page3 = states[states.length - 1];
  const first = states.find((s) => s !== page2 && s !== page3);
  const pop = async (href: string, state: unknown) => {
    loc.href = ORIGIN + href;
    fakeHistory.state = state;
    const claim = g.__dnxPop as (href: string, event: unknown) => unknown;
    report.claims.push(claim(ORIGIN + href, { state }));
    await settle();
    report.steps.push(text());
  };
  await pop("/?page=2", page2); // back
  await pop("/", first); // back
  await pop("/?page=3", page3); // forward
  // A stack layout claiming after: it answers what this declines.
  g.__dnxPop = (href: string) => `next:${new URL(href).search}`;
  await pop("/#top", null);
  // An entry this page load holds no record of: fetched, its regions replaced.
  await pop("/?page=9", { denextFreshEntry: "gone" });
  return report;
}
