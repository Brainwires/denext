// DevTools panel panes, one module at a time over a bare context (tests/helpers/devtools-panel-ctx.ts):
// what each pane draws for the shapes its endpoint or the inspector can hand it, the empty and
// malformed ones included. The mounted panel's interactions are tests/devtools-panel.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { loadedTab, panelCtx } from "./helpers/devtools-panel-ctx.ts";
import type { FakeElement } from "./helpers/dom.ts";
import { renderLiveTab } from "../src/client/devtools-panel/live.ts";
import {
  records,
  refreshLiveViewsTab,
  renderLiveViewsTab,
  text as textOf,
} from "../src/client/devtools-panel/live-views.ts";
import { renderRenderModes } from "../src/client/devtools-panel/render-modes.ts";
import { agoLabel, renderCacheTab } from "../src/client/devtools-panel/cache.ts";
import { renderRoutesTab } from "../src/client/devtools-panel/routes.ts";
import { renderMvuTab, summarize } from "../src/client/devtools-panel/mvu.ts";
import { renderConsoleTab } from "../src/client/devtools-panel/console.ts";

/** Every element under `root`, in document order. */
function elements(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (node: FakeElement) => {
    for (const child of node.childNodes as unknown as FakeElement[]) {
      if (child.tagName === undefined) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * Run `fn` with `fetch` answering `payload` as JSON (recording each URL) and `AbortSignal.timeout`
 * a signal that never fires, so the dev reads leave no timer behind.
 */
async function withJsonFetch(
  payload: unknown,
  fn: (urls: string[]) => Promise<void> | void,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  const urls: string[] = [];
  globalThis.fetch = (input) => {
    urls.push(String(input));
    return Promise.resolve(Response.json(payload));
  };
  AbortSignal.timeout = () => new AbortController().signal;
  try {
    await fn(urls);
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
}

/** Let the stubbed fetch's promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── Live tab ─────────────────────────────────────────────────────────────────────────────────

Deno.test("Live pane: empty lists say what they mean", () => {
  const { ctx, detailPane } = panelCtx();
  ctx.state.live = loadedTab({});
  renderLiveTab(ctx);
  const text = detailPane.textContent;
  assertStringIncludes(text, "Connections · 0");
  assertStringIncludes(text, "no Live socket is open");
  assertStringIncludes(text, "Channel pushes · 0");
  assertStringIncludes(text, "no pushes yet");
  assertStringIncludes(text, "Cache entries written · 0");
  assertStringIncludes(text, "none yet");
});

Deno.test("Live pane: a socket with no subscriptions, no path and malformed fields", () => {
  const { ctx, detailPane } = panelCtx();
  ctx.state.live = loadedTab({
    connections: [
      { peer: "abcdefghijkl" }, // nothing subscribed, no path
      // Untrusted shapes: tags that are not a list, rooms that are not a list, no views count.
      { path: "/p", boundaries: [{ id: "L1", tags: "orders" }], rooms: "doc", views: 0 },
      { path: "/q", tags: [{ tags: ["a", "b"] }], views: 2 },
    ],
  });
  renderLiveTab(ctx);
  const text = detailPane.textContent;
  assertStringIncludes(text, "Connections · 3");
  assertStringIncludes(text, "/abcdefgh", "no path reads as /, the peer is cut to 8");
  assertStringIncludes(text, "no subscriptions");
  assertStringIncludes(text, "<Live> L1 ← ", "tags that are not a list read as none");
  assert(!text.includes("presence"), "rooms that are not a list are ignored");
  assert(!text.includes("0 live view"), "no views line for zero views");
  assertStringIncludes(text, "tags a, b");
  assertStringIncludes(text, "2 live view(s)");
});

Deno.test("Live pane: pushes and cache entries, newest first, with their kinds' defaults and colours", () => {
  const { ctx, detailPane } = panelCtx();
  const now = Date.now();
  ctx.state.live = loadedTab({
    channelPushes: [
      { kind: "revoke", channel: "chat", key: "k1", subscribers: 1, payload: null, at: now - 5000 },
      { channel: "news", key: "k2", subscribers: 3, payload: { n: 1 } }, // no kind, no time
    ],
    cacheEntries: [
      { kind: "page", key: "/a", tags: ["t"], bytes: 10, at: now - 3000 },
      { key: "data:x", tags: "not-a-list", bytes: 4 }, // no kind, no time
    ],
  });
  renderLiveTab(ctx);
  const html = detailPane.outerHTML;
  const text = detailPane.textContent;
  assertStringIncludes(text, "Channel pushes · 2");
  assert(text.indexOf("news / k2") < text.indexOf("chat / k1"), "the newest push is listed first");
  assertStringIncludes(text, "publish", "a push with no kind is a publish");
  assertStringIncludes(text, "revoke");
  assertStringIncludes(html, "#ff6b6b", "a revoke is drawn red");
  assertStringIncludes(text, "→ 3");
  assertStringIncludes(text, "5s ago");
  assertStringIncludes(text, "Cache entries written · 2");
  assert(text.indexOf("data:x") < text.indexOf("/a"), "the newest entry is listed first");
  assertStringIncludes(text, "data", "an entry with no kind is data");
  assertStringIncludes(html, "#f0b45b", "a data entry has its own colour");
  assertStringIncludes(text, " · 4 B", "tags that are not a list read as none");
  assertStringIncludes(text, "t · 10 B");
  assertStringIncludes(text, "3s ago");
});

Deno.test("Live pane: before the first read it says it is loading", () => {
  const { ctx, detailPane } = panelCtx();
  renderLiveTab(ctx);
  assertEquals(detailPane.textContent, "loading…");
});

// ── Live views tab ───────────────────────────────────────────────────────────────────────────

Deno.test("Live views pane: nothing mounted and no messages; untrusted entries are filtered", () => {
  const { ctx, detailPane } = panelCtx();
  ctx.state.liveViews = loadedTab({ views: "not a list", messages: [null, 3] });
  renderLiveViewsTab(ctx);
  const text = detailPane.textContent;
  assertStringIncludes(text, "Server-held views · 0");
  assertStringIncludes(text, "no live view is mounted");
  assertStringIncludes(text, "no messages yet");
});

Deno.test("Live views pane: a parked view with odd fields, and a message with no time", () => {
  const { ctx, detailPane } = panelCtx();
  ctx.state.liveViews = loadedTab({
    views: [{ view: "todo", state: "parked", rev: true, modelBytes: 3, iid: 42, model: [1] }],
    messages: [{ view: { not: "text" }, msgs: [{ type: "string(3)" }] }],
  });
  renderLiveViewsTab(ctx);
  const text = detailPane.textContent;
  const html = detailPane.outerHTML;
  assertStringIncludes(text, "parkedtodorev  · 3 B model42", "a non-text rev reads as empty");
  assertStringIncludes(html, "#f0b45b", "a parked view is amber");
  assertStringIncludes(text, "[1]");
  assertStringIncludes(text, '[{"type":"string(3)"}]');
  assert(!text.includes(" ago"), "a message with no time has no age");
  assertEquals(records(null), []);
  assertEquals(textOf(null), "");
});

Deno.test("Live views pane: an attached view and a timed message; the endpoint is read and its absence named", async () => {
  const { ctx, detailPane } = panelCtx();
  renderLiveViewsTab(ctx);
  assertEquals(detailPane.textContent, "loading…");
  await withJsonFetch({
    views: [{
      view: "counter",
      state: "attached",
      rev: 2,
      modelBytes: 9,
      iid: "abcdef0123",
      model: { n: 1 },
    }],
    messages: [{ view: "counter", msgs: [], at: Date.now() - 4000 }],
  }, async (urls) => {
    refreshLiveViewsTab(ctx);
    await settle();
    assertEquals(new URL(urls[0], "http://x").pathname, "/_denext/dev-live-views");
  });
  detailPane.replaceChildren();
  renderLiveViewsTab(ctx);
  const text = detailPane.textContent;
  assertStringIncludes(text, "attachedcounterrev 2 · 9 B modelabcdef01");
  assertStringIncludes(detailPane.outerHTML, "#5bd18b", "an attached view is green");
  assertStringIncludes(text, "4s ago");
  const empty = panelCtx();
  empty.ctx.state.liveViews = loadedTab(null);
  renderLiveViewsTab(empty.ctx);
  assertStringIncludes(empty.detailPane.textContent, "Server-held views · 0");
});

// ── Render-modes tab ─────────────────────────────────────────────────────────────────────────

/** An inspector API answering the render-modes tab's three reads. */
function modesApi(
  page: unknown,
  boundaries: unknown[],
  modes: unknown[],
): Record<string, unknown> {
  return {
    getPageRenderMode: () => page,
    getBoundaryTimings: () => boundaries,
    getRenderModes: () => modes,
  };
}

Deno.test("Render modes: a server-rendered page with nothing on the client says so", () => {
  const { ctx, detailPane } = panelCtx(modesApi(null, [], []));
  renderRenderModes(ctx);
  assertEquals(detailPane.textContent, "No client islands — this page is server-rendered HTML.");
});

Deno.test("Render modes: the page verdict, with and without its cache state", () => {
  const cached = panelCtx(modesApi({ mode: "static", cache: "HIT" }, [], []));
  renderRenderModes(cached.ctx);
  const text = cached.detailPane.textContent;
  assertStringIncludes(text, "Page");
  assertStringIncludes(text, "modestatic");
  assertStringIncludes(text, " · cache HIT");
  assertStringIncludes(text, "No client islands on this page.");

  const plain = panelCtx(modesApi({ mode: "dynamic" }, [], []));
  renderRenderModes(plain.ctx);
  assertStringIncludes(plain.detailPane.textContent, "modedynamic");
  assert(!plain.detailPane.textContent.includes("cache"), "no cache state, no cache line");
});

Deno.test("Render modes: the Suspense waterfall scales each bar and adds the reveal time", () => {
  const { ctx, detailPane } = panelCtx(
    modesApi(
      null,
      [{ id: "B1", ms: 40, revealAt: 12.6 }, { id: "B2", ms: 80, revealAt: null }],
      [],
    ),
  );
  renderRenderModes(ctx);
  const text = detailPane.textContent;
  assertStringIncludes(text, "Suspense boundaries (live waterfall)");
  assertStringIncludes(text, "40ms server");
  assertStringIncludes(text, "revealed @13ms");
  assertEquals(text.split("revealed").length, 2, "only the revealed boundary has a time");
  // The longest boundary draws the full bar; the other half of it.
  const bars = elements(detailPane).filter((e) => e.tagName === "DIV");
  // (`style.width` is a plain property on the in-memory DOM's style object.)
  assertEquals(bars.map((b) => (b.style as unknown as { width?: string }).width), ["35px", "70px"]);
  assert(!text.includes("No client islands"), "a streamed page is not called island-free");
});

Deno.test("Render modes: the island waterfall, each strategy with its parameter, id and time", () => {
  const { ctx, detailPane } = panelCtx(
    modesApi({ mode: "streamed" }, [{ id: "B1", ms: 5, revealAt: null }], [
      { strategy: "visible", param: "200px", id: "chart", hydratedAt: 31 },
      { strategy: "load", id: "island", hydratedAt: null },
    ]),
  );
  renderRenderModes(ctx);
  const text = detailPane.textContent;
  assertStringIncludes(text, "Client islands (hydration waterfall)");
  assertStringIncludes(text, "visible(200px)#chart31ms");
  assertStringIncludes(text, "load", "no parameter, no parentheses");
  assert(!text.includes("load("), text);
  assert(!text.includes("#island"), "the default island id is not shown");
  assert(!text.includes("No client islands"), text);
});

Deno.test("Render modes: islands alone lead with their own heading", () => {
  const { ctx, detailPane } = panelCtx(
    modesApi(null, [], [{ strategy: "idle", id: "w", hydratedAt: 2 }]),
  );
  renderRenderModes(ctx);
  // The first heading of the pane carries the first-heading style (no top margin).
  const first = detailPane.childNodes[0] as unknown as { textContent: string; outerHTML: string };
  assertEquals(first.textContent, "Client islands (hydration waterfall)");
  assertStringIncludes(detailPane.textContent, "idle#w2ms");
});

// ── Cache tab ────────────────────────────────────────────────────────────────────────────────

Deno.test("Cache pane: a payload of the wrong shape reads as zeros and no invalidations", () => {
  for (const payload of [null, "nope", { pageHits: "3", pageMisses: -1, pageSets: NaN }]) {
    const { ctx, detailPane } = panelCtx();
    ctx.state.cache = loadedTab(payload);
    renderCacheTab(ctx);
    const text = detailPane.textContent;
    assertStringIncludes(text, "0hits");
    assertStringIncludes(text, "0misses");
    assertStringIncludes(text, "—hit rate", "no reads, no rate");
    assertStringIncludes(text, "no invalidations yet");
  }
});

Deno.test("Cache pane: malformed invalidations are dropped; a kindless one is a tag, a timeless one has no age", () => {
  const { ctx, detailPane } = panelCtx();
  ctx.state.cache = loadedTab({
    pageHits: 1,
    recentInvalidations: [
      "not an object",
      { kind: "tag" }, // no value
      { value: "orders" }, // no kind, no time
      { kind: "path", value: "/old", at: Date.now() - 2 * 3600_000 },
    ],
  });
  renderCacheTab(ctx);
  const html = detailPane.outerHTML;
  const text = detailPane.textContent;
  assertStringIncludes(text, "100%hit rate");
  assertStringIncludes(text, "path/old2h ago");
  assertStringIncludes(text, "tagorders");
  assert(!/tagorders\d/.test(text), "no age for an invalidation with no time");
  assertStringIncludes(html, "#8aa2ff", "a path invalidation is blue");
  assertStringIncludes(html, "#f0b45b", "a tag invalidation is amber");
  assertEquals(text.split(" ago").length, 2, "only the timed invalidation has an age");
});

Deno.test("agoLabel: seconds, minutes and hours, never negative", () => {
  assertEquals(agoLabel(-500), "0s ago");
  assertEquals(agoLabel(0), "0s ago");
  assertEquals(agoLabel(59_000), "59s ago");
  assertEquals(agoLabel(61_000), "1m ago");
  assertEquals(agoLabel(3 * 3600_000 + 5), "3h ago");
});

// ── Routes tab ───────────────────────────────────────────────────────────────────────────────

Deno.test("Routes pane: nothing matched names the probed path", () => {
  const { ctx, detailPane } = panelCtx();
  ctx.state.routes = loadedTab(null);
  renderRoutesTab(ctx);
  assertStringIncludes(detailPane.textContent, "nothing renders at /");
  const unmatched = panelCtx();
  unmatched.ctx.state.routes = loadedTab({ path: "/nope", matched: false });
  renderRoutesTab(unmatched.ctx);
  assertStringIncludes(unmatched.detailPane.textContent, "nothing renders at /nope");
});

Deno.test("Routes pane: templates, slots, a client page and a static route; files open without an app dir", async () => {
  const { ctx, detailPane } = panelCtx();
  ctx.state.routes = loadedTab({
    path: "/shop",
    matched: true,
    page: {
      routePath: "/shop",
      file: "shop/page.tsx",
      boundary: "client",
      params: {},
      layouts: [{ file: "layout.tsx", boundary: "server" }],
      templates: [{ file: "shop/template.tsx", boundary: "server" }],
      boundaries: {},
      slots: [{ name: "modal", pages: 2 }],
    },
  });
  renderRoutesTab(ctx);
  const text = detailPane.textContent;
  assertStringIncludes(text, "template:shop/template.tsx");
  assertStringIncludes(text, "page:shop/page.tsxclient");
  assert(!text.includes("Params"), "a static route has no params section");
  assert(!text.includes("Boundaries"), "no boundary files, no section");
  assertStringIncludes(text, "@modal2 page(s)");
  assertStringIncludes(detailPane.outerHTML, "#f0b45b", "a client module's badge is amber");
  await withJsonFetch({}, async (urls) => {
    const link = elements(detailPane).find((e) => e.textContent === "shop/page.tsx")!;
    link.dispatch("click");
    await settle();
    assertEquals(urls.length, 1);
    const opened = new URL(urls[0], "http://x");
    assertEquals(opened.pathname, "/_denext/open-in-editor");
    assertEquals(opened.searchParams.get("file"), "shop/page.tsx", "no app dir to prefix");
  });
});

Deno.test("Routes pane: the toolbar probes the typed path (Enter, change, the button), adding a leading /", async () => {
  const { ctx, detailPane } = panelCtx();
  ctx.state.routes = loadedTab(null);
  renderRoutesTab(ctx);
  const [box, go] = elements(detailPane).filter((e) =>
    e.tagName === "INPUT" || e.tagName === "BUTTON"
  );
  await withJsonFetch({ path: "/x", matched: false }, async (urls) => {
    box.value = "blog/post";
    box.dispatch("keydown", { key: "a" }); // not Enter: no probe
    box.dispatch("keydown", { key: "Enter" });
    box.value = "  ";
    box.dispatch("change"); // empty: the root
    box.value = "/about";
    go.dispatch("click");
    await settle();
    assertEquals(
      urls.map((u) => new URL(u, "http://x").searchParams.get("path")),
      ["/blog/post", "/", "/about"],
    );
  });
  assertEquals(ctx.state.routes.data, { path: "/x", matched: false });
});

Deno.test("Routes pane: an API route and a dynamic page with boundaries, files opened under the app dir", async () => {
  const g = globalThis as { location?: unknown };
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { pathname: "/blog/hello" },
  });
  try {
    const { ctx, detailPane } = panelCtx();
    renderRoutesTab(ctx);
    assertEquals(detailPane.textContent, "loading…", "before the first read");
    detailPane.replaceChildren();
    ctx.state.routes = loadedTab({
      path: "/blog/hello",
      matched: true,
      appDir: "/p/app",
      api: { routePath: "/blog/[slug]", file: "blog/[slug]/route.ts" },
      page: {
        routePath: "/blog/[slug]",
        file: "blog/[slug]/page.tsx",
        boundary: "server",
        params: { slug: "hello" },
        layouts: [],
        templates: [],
        boundaries: { error: "blog/error.tsx", loading: "loading.tsx", bogus: 1 },
      },
    });
    renderRoutesTab(ctx);
    const text = detailPane.textContent;
    const box = elements(detailPane).find((e) => e.tagName === "INPUT")!;
    assertEquals(box.value, "/blog/hello", "the probe starts at the page being looked at");
    assertStringIncludes(text, "API route/blog/[slug]route:blog/[slug]/route.ts");
    assertStringIncludes(text, "Paramsslughello");
    // In the fixed order, the files only (a non-string entry is ignored).
    assertStringIncludes(text, "Boundariesloading:loading.tsxerror:blog/error.tsx");
    assert(!text.includes("Slots"), "no slots, no section");
    assertStringIncludes(detailPane.outerHTML, "#5fd48a", "a server module's badge is green");
    await withJsonFetch({}, async (urls) => {
      elements(detailPane).find((e) => e.textContent === "blog/[slug]/route.ts")!.dispatch("click");
      await settle();
      const opened = new URL(urls[0], "http://x").searchParams.get("file");
      assertEquals(opened, "/p/app/blog/[slug]/route.ts");
    });
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had);
    else delete g.location;
  }
});

// ── MVU tab ──────────────────────────────────────────────────────────────────────────────────

Deno.test("MVU pane: no program running, outside `denext dev` too", () => {
  const { ctx, detailPane } = panelCtx();
  renderMvuTab(ctx); // the page's registry: none in this process
  assertStringIncludes(detailPane.textContent, "No Model–View–Update program is running");
});

Deno.test("MVU pane: a model JSON can't show, a long one cut, and a cursor with no step", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const record = (id: number, cursor: number, models: unknown[]) => ({
    id,
    name: `p${id}`,
    cursor,
    steps: models.map((model, i) => ({ msg: { i }, model, at: i })),
    jump: () => {},
  });
  const { ctx, detailPane } = panelCtx();
  renderMvuTab(
    ctx,
    new Map([
      [1, record(1, 0, [cyclic])],
      [2, record(2, 0, ["x".repeat(5000)])],
      [3, record(3, 5, [1])], // the cursor points past the steps
      [4, record(4, 0, [undefined])],
    ]),
  );
  const text = detailPane.textContent;
  assertStringIncludes(text, "[object Object]", "a cyclic model falls back to String()");
  assertStringIncludes(text, `${"x".repeat(100)}`);
  assert(text.includes("x".repeat(3990) + "…"), "a long model is cut");
  assertEquals(text.split("model after step").length, 4, "no model line for a missing step");
  assertStringIncludes(text, "undefined", "an undefined model is shown as such");
});

Deno.test("summarize: strings as they are, values as JSON, unserializable ones as text, cut to length", () => {
  assertEquals(summarize("hi"), "hi");
  assertEquals(summarize({ a: 1 }), '{"a":1}');
  assertEquals(summarize(10n), "10");
  assertEquals(summarize(undefined), "undefined");
  assertEquals(summarize("abcdef", 4), "abc…");
});

// ── Console tab ──────────────────────────────────────────────────────────────────────────────

/** A console store over `entries` (the capture script's shape), recording what is asked of it. */
function fakeConsole(entries: unknown[], diagnosis: Record<string, unknown> = { state: "idle" }) {
  const calls = { cleared: 0, diagnosed: [] as Array<string | undefined> };
  const store = {
    entries,
    errorCount: entries.length,
    importErrorSeen: false,
    limit: 500,
    diagnosis,
    subscribe: () => () => {},
    clear: () => {
      calls.cleared++;
      store.entries = [];
    },
    diagnose: (why?: string) => {
      calls.diagnosed.push(why);
      return Promise.resolve(diagnosis);
    },
  };
  return { store, calls };
}

/** Run `fn` with `store` as the page's console capture (`window.__denextConsole`). */
async function withConsole(store: unknown, fn: () => Promise<void> | void): Promise<void> {
  const g = globalThis as { __denextConsole?: unknown };
  const prev = g.__denextConsole;
  g.__denextConsole = store;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete g.__denextConsole;
    else g.__denextConsole = prev;
  }
}

const ENTRY = (
  id: number,
  level: string,
  message: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  ts: Date.UTC(2026, 0, 1, 0, 0, 0, 5),
  level,
  source: "console",
  message,
  stack: "",
  url: "",
  ...extra,
});

Deno.test("Console pane: no capture installed says so", async () => {
  await withConsole(undefined, () => {
    const { ctx, detailPane } = panelCtx();
    renderConsoleTab(ctx);
    assertStringIncludes(detailPane.textContent, "console capture is not installed");
  });
});

Deno.test("Console pane: the level filters, debug under log, and an empty level", async () => {
  const { store } = fakeConsole([
    ENTRY(1, "error", "boom", { source: "uncaught", stack: "at a\nat b" }),
    ENTRY(2, "warn", "careful"),
    ENTRY(3, "info", "fyi"),
    ENTRY(4, "debug", "dbg"),
    ENTRY(5, "log", "plain"),
  ]);
  await withConsole(store, () => {
    for (
      const [level, shown] of [
        ["error", ["boom"]],
        ["warn", ["careful"]],
        ["info", ["fyi"]],
        ["log", ["dbg", "plain"]],
      ] as const
    ) {
      const { ctx, detailPane } = panelCtx();
      ctx.state.consoleLevel = level;
      renderConsoleTab(ctx);
      const text = detailPane.textContent;
      for (const m of ["boom", "careful", "fyi", "dbg", "plain"]) {
        assertEquals(text.includes(m), (shown as readonly string[]).includes(m), `${level}: ${m}`);
      }
    }
    const { ctx, detailPane } = panelCtx();
    store.entries = [ENTRY(1, "log", "only")];
    ctx.state.consoleLevel = "error";
    renderConsoleTab(ctx);
    assertStringIncludes(detailPane.textContent, "nothing at this level");
  });
});

Deno.test("Console pane: toolbar filter, clear and diagnose; a stack toggles open and shut", async () => {
  const { store, calls } = fakeConsole([
    ENTRY(7, "error", "boom", { source: "rejection", stack: "at f (x.ts:1)" }),
  ]);
  await withConsole(store, () => {
    const { ctx, detailPane, calls: panel } = panelCtx();
    renderConsoleTab(ctx);
    const button = (label: string) => elements(detailPane).find((e) => e.textContent === label)!;
    button("warnings").dispatch("click");
    assertEquals(ctx.state.consoleLevel, "warn");
    const row = elements(detailPane).find((e) => e.textContent.includes("boom"))!;
    assertStringIncludes(row.textContent, "rejection");
    assertStringIncludes(row.textContent, "▸ stack");
    row.dispatch("click");
    assert(ctx.state.consoleExpanded.has(7), "a click opens the stack");
    detailPane.replaceChildren();
    ctx.state.consoleLevel = "all";
    renderConsoleTab(ctx);
    const open = elements(detailPane).find((e) => e.textContent.includes("▾ stack"))!;
    assertStringIncludes(open.textContent, "at f (x.ts:1)");
    open.dispatch("click");
    assert(!ctx.state.consoleExpanded.has(7), "a second click closes it");
    button("diagnose boot").dispatch("click");
    assertEquals(calls.diagnosed, ["manual"]);
    ctx.state.consoleExpanded.add(7);
    button("clear").dispatch("click");
    assertEquals([calls.cleared, ctx.state.consoleExpanded.size], [1, 0]);
    assert(panel.renders >= 4, "each control re-renders the panel");
  });
});

Deno.test("Console pane: the boot diagnosis while running, clean, with no entry, and failing", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [
      { state: "running", checked: 3, queued: 2, failures: [], pass: "deep" },
      "3 module(s) checked, 2 pending (deep pass",
    ],
    [{ state: "running", checked: 1, queued: 0, failures: [] }, "1 module(s) checked, 0 pending"],
    [
      { state: "done", checked: 9, failures: [], entry: "/main.js" },
      "9 module(s) checked, none failed to load",
    ],
    [
      { state: "done", checked: 0, failures: [], entry: "", note: "no entry module found" },
      "boot diagnosis: no entry module found",
    ],
    [
      {
        state: "done",
        checked: 4,
        entry: "/main.js",
        failures: [
          { url: "/a.js", from: "/main.js", reason: "404" },
          { url: "/b.js", from: "", reason: "SyntaxError" },
        ],
      },
      "boot diagnosis: 2 failing module(s)",
    ],
  ];
  for (const [diagnosis, expected] of cases) {
    const { store } = fakeConsole([], diagnosis);
    await withConsole(store, () => {
      const { ctx, detailPane } = panelCtx();
      renderConsoleTab(ctx);
      const text = detailPane.textContent;
      assertStringIncludes(text, expected);
      assertStringIncludes(text, "no console output yet");
      if (expected.includes("failing")) {
        assertStringIncludes(text, "/a.js\n  404\n  imported by /main.js");
        assert(!text.includes("SyntaxError\n  imported"), "no importer, no importer line");
      }
    });
  }
});

Deno.test("Console pane: past 300 entries the oldest are hidden, and the pane sticks to the bottom", async () => {
  const entries = Array.from({ length: 305 }, (_, i) => ENTRY(i, "log", `m${i}`));
  const { store } = fakeConsole(entries);
  await withConsole(store, () => {
    const { ctx, detailPane } = panelCtx();
    const pane = detailPane as unknown as {
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
    };
    Object.assign(pane, { scrollHeight: 1000, scrollTop: 900, clientHeight: 80 }); // at the bottom
    renderConsoleTab(ctx);
    assertStringIncludes(detailPane.textContent, "5 older entries hidden (copy includes them)");
    assert(!detailPane.textContent.includes("m4 "), "the oldest are not drawn");
    assertEquals(pane.scrollTop, 1000, "kept at the bottom");
    Object.assign(pane, { scrollTop: 100 }); // scrolled up: left where it is
    detailPane.replaceChildren();
    renderConsoleTab(ctx);
    assertEquals(pane.scrollTop, 100);
  });
});

Deno.test("Console pane: copy writes what the level shows to the clipboard, or shows a copy box", async () => {
  const { store } = fakeConsole([
    ENTRY(1, "error", "boom", { source: "uncaught", stack: "at a\nat b" }),
    ENTRY(2, "log", "plain"),
  ]);
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(nav, "clipboard");
  const realSetTimeout = globalThis.setTimeout;
  const later: Array<() => void> = [];
  await withConsole(store, async () => {
    try {
      // No clipboard: a selectable box at the top of the pane.
      Object.defineProperty(nav, "clipboard", { configurable: true, value: undefined });
      const plain = panelCtx();
      renderConsoleTab(plain.ctx);
      elements(plain.detailPane).find((e) => e.textContent === "copy")!.dispatch("click");
      const box = plain.detailPane.childNodes[0] as unknown as { tagName: string; value: string };
      assertEquals(box.tagName, "TEXTAREA");
      assertStringIncludes(box.value, "[error] (uncaught) boom\n    at a\n    at b");
      assertStringIncludes(box.value, "[log] plain");

      // A clipboard: the button says it copied, then goes back (its timer run by hand here).
      const written: string[] = [];
      Object.defineProperty(nav, "clipboard", {
        configurable: true,
        value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
      });
      globalThis.setTimeout = ((fn: () => void) => (later.push(fn), 0)) as typeof setTimeout;
      const { ctx, detailPane } = panelCtx();
      ctx.state.consoleLevel = "error";
      renderConsoleTab(ctx);
      const copy = elements(detailPane).find((e) => e.textContent === "copy")!;
      copy.dispatch("click");
      await Promise.resolve();
      await Promise.resolve();
      assertEquals(written.length, 1);
      assert(!written[0].includes("plain"), "only what the level shows");
      assertEquals(copy.textContent, "copied");
      later.forEach((fn) => fn());
      assertEquals(copy.textContent, "copy");

      // A clipboard that refuses: the copy box again.
      Object.defineProperty(nav, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) },
      });
      const refused = panelCtx();
      renderConsoleTab(refused.ctx);
      elements(refused.detailPane).find((e) => e.textContent === "copy")!.dispatch("click");
      await Promise.resolve();
      await Promise.resolve();
      assertEquals(
        (refused.detailPane.childNodes[0] as unknown as { tagName: string }).tagName,
        "TEXTAREA",
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      if (had) Object.defineProperty(nav, "clipboard", had);
      else delete nav.clipboard;
    }
  });
});
