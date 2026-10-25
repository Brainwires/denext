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
  g.history = {
    state: null,
    pushState: (_s: unknown, _t: string, url: string) => {
      report.pushed.push(url);
      loc.href = new URL(url, loc.href).href;
    },
    replaceState: (_s: unknown, _t: string, url: string) => {
      report.replaced.push(url);
      loc.href = new URL(url, loc.href).href;
    },
  };
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
  report.ignored = report.fetched.length - before;
  report.title = fakeDocument.title;
  return report;
}
