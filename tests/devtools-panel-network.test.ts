// DevTools panel: the Network tab. Drives the tab against a stubbed `fetch` through the
// in-memory DOM harness — no browser, no dev server — asserting the rendered table rather
// than the module's internals: row order and count, the status pill's colour per response
// class, both toolbar filters, the App-Router-only state, and malformed-event tolerance.

import { assert, assertEquals } from "@std/assert";
import { FakeDocument, type FakeElement, type FakeNode } from "./helpers/dom.ts";
import { initialState } from "../src/client/devtools-panel.ts";
import type { PanelCtx } from "../src/client/devtools-panel/ctx.ts";
import { buildStyles } from "../src/client/devtools-panel/styles.ts";
import { DEV_STATE_PATH } from "../src/client/devtools-panel/dev-api.ts";
import { refreshNetworkTab, renderNetworkTab } from "../src/client/devtools-panel/network.ts";

// deno-lint-ignore no-explicit-any
const asAny = (v: unknown): any => v;

/** One `kind:"request"` dev event, as `/_denext/dev-state` serializes it. */
interface RequestEvent {
  kind: "request";
  ts: number;
  source: "server";
  level: string;
  message: string;
  url: string;
  status: number;
  durationMs: number;
}

/** Build a request event the way `handler.ts` records one. */
function event(
  path: string,
  status: number,
  durationMs: number,
  ts = Date.now(),
): RequestEvent {
  return {
    kind: "request",
    ts,
    source: "server",
    level: status >= 500 ? "error" : "info",
    message: `GET ${path} → ${status}`,
    url: path,
    status,
    durationMs,
  };
}

/** A panel context with no live panel, for driving the Network tab in isolation. */
function networkCtx(): { ctx: PanelCtx; detailPane: FakeElement; renders: () => number } {
  const doc = new FakeDocument();
  const { S, S_BADGE } = buildStyles();
  const detailPane = doc.createElement("div");
  let renders = 0;
  const ctx: PanelCtx = {
    doc: asAny(doc),
    api: asAny({}),
    S,
    S_BADGE,
    state: initialState(),
    treePane: asAny(doc.createElement("div")),
    detailPane: asAny(detailPane),
    // The panel's own render pass: clear the pane, then let the tab redraw it.
    render: () => {
      renders++;
      detailPane.replaceChildren();
      renderNetworkTab(ctx);
    },
    selectNode: () => {},
    highlight: () => {},
    hideHighlight: () => {},
  };
  return { ctx, detailPane, renders: () => renders };
}

/** Run `fn` with `fetch` replaced by `stub`. */
async function withFetch(stub: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** Serve `events` from the dev-state endpoint, then let the tab's read settle. */
async function load(ctx: PanelCtx, events: unknown[], seen?: string[]): Promise<void> {
  await withFetch((input) => {
    seen?.push(String(input));
    return Promise.resolve(Response.json({ events, total: events.length }));
  }, async () => {
    refreshNetworkTab(ctx);
    await new Promise((r) => setTimeout(r, 0));
  });
}

function queryAll(root: FakeNode, pred: (e: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => {
    if ((n as FakeElement).tagName !== undefined && pred(n as FakeElement)) {
      out.push(n as FakeElement);
    }
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

/** The table's body rows (the header row lives in `<thead>`). */
function bodyRows(pane: FakeElement): FakeElement[] {
  const body = queryAll(pane, (e) => e.tagName === "TBODY")[0];
  return body ? queryAll(body, (e) => e.tagName === "TR") : [];
}

/** Every row's request cell text, top to bottom. */
function rowPaths(pane: FakeElement): string[] {
  return bodyRows(pane).map((r) => queryAll(r, (e) => e.tagName === "TD")[0].textContent);
}

/** The status pill of row `i`. */
function pill(pane: FakeElement, i: number): FakeElement {
  return queryAll(
    bodyRows(pane)[i],
    (e) => e.tagName === "SPAN" && e.style.cssText.includes("border-radius:999px"),
  )[0];
}

/** The toolbar's filter input. */
function filterBox(pane: FakeElement): FakeElement {
  return queryAll(pane, (e) => e.tagName === "INPUT")[0];
}

/** The toolbar's "errors only" toggle. */
function errorsBtn(pane: FakeElement): FakeElement {
  return queryAll(pane, (e) => e.tagName === "BUTTON" && e.textContent === "errors")[0];
}

Deno.test("network tab: asks for the request kind, capped at 200", async () => {
  const { ctx } = networkCtx();
  const seen: string[] = [];
  await load(ctx, [event("/a", 200, 3)], seen);
  assertEquals(seen, [`${DEV_STATE_PATH}?kind=request&limit=200`]);
});

Deno.test("network tab: renders newest-first, one row per request, with a count", async () => {
  const { ctx, detailPane, renders } = networkCtx();
  const t = Date.now();
  await load(ctx, [
    event("/oldest", 200, 4, t - 30_000),
    event("/middle", 200, 9, t - 2000),
    event("/newest", 200, 1, t),
  ]);
  assertEquals(renders(), 1, "one re-render per read");
  assertEquals(rowPaths(detailPane), ["GET /newest", "GET /middle", "GET /oldest"]);
  assert(detailPane.textContent.includes("3 requests"), detailPane.textContent);
  // Relative timestamps, not absolute ones.
  assert(detailPane.textContent.includes("2s ago"), detailPane.textContent);
  assert(detailPane.textContent.includes("30s ago"), detailPane.textContent);
});

Deno.test("network tab: caps the table at 200 rows", async () => {
  const { ctx, detailPane } = networkCtx();
  const many = Array.from({ length: 260 }, (_, i) => event(`/r${i}`, 200, i));
  await load(ctx, many);
  assertEquals(bodyRows(detailPane).length, 200);
  // The cap keeps the newest, so the first dropped row is the oldest request.
  assertEquals(rowPaths(detailPane)[0], "GET /r259");
});

Deno.test("network tab: the status pill is coloured by response class", async () => {
  const { ctx, detailPane } = networkCtx();
  await load(ctx, [
    event("/server", 500, 1),
    event("/missing", 404, 1),
    event("/moved", 302, 1),
    event("/ok", 200, 1),
  ]);
  // Newest first: /ok, /moved, /missing, /server.
  const colors = [0, 1, 2, 3].map((i) => {
    const css = pill(detailPane, i).style.cssText;
    return css.slice(css.indexOf("background:"));
  });
  assert(colors[0].startsWith("background:#5fd48a"), colors[0]); // 2xx green
  assert(colors[1].startsWith("background:#8aa2ff"), colors[1]); // 3xx blue
  assert(colors[2].startsWith("background:#f0b45b"), colors[2]); // 4xx amber
  assert(colors[3].startsWith("background:#ff6b6b"), colors[3]); // 5xx red
  assertEquals([0, 1, 2, 3].map((i) => pill(detailPane, i).textContent), [
    "200",
    "302",
    "404",
    "500",
  ]);
});

Deno.test("network tab: duration bars scale to the slowest visible request", async () => {
  const { ctx, detailPane } = networkCtx();
  await load(ctx, [event("/slow", 200, 100), event("/fast", 200, 10)]);
  const bars = queryAll(
    detailPane,
    (e) => e.tagName === "DIV" && e.style.cssText.includes("height:9px"),
  );
  assertEquals(bars.length, 2);
  assertEquals(asAny(bars[0]).style.width, "7px", "the fastest request gets a short bar");
  assertEquals(asAny(bars[1]).style.width, "70px", "the slowest fills the scale");
  assert(detailPane.textContent.includes("100ms"), detailPane.textContent);
});

Deno.test("network tab: the errors-only toggle hides 2xx and 3xx", async () => {
  const { ctx, detailPane } = networkCtx();
  await load(ctx, [event("/ok", 200, 1), event("/gone", 410, 1), event("/boom", 500, 1)]);
  assertEquals(bodyRows(detailPane).length, 3);

  errorsBtn(detailPane).dispatch("click");
  assertEquals(rowPaths(detailPane), ["GET /boom", "GET /gone"]);
  assert(detailPane.textContent.includes("2 of 3"), detailPane.textContent);
  assert(errorsBtn(detailPane).style.cssText.includes("#8aa2ff"), "the toggle reads as active");

  errorsBtn(detailPane).dispatch("click");
  assertEquals(bodyRows(detailPane).length, 3);
  assert(detailPane.textContent.includes("3 requests"), detailPane.textContent);
});

Deno.test("network tab: the text filter narrows by path, case-insensitively", async () => {
  const { ctx, detailPane } = networkCtx();
  await load(ctx, [
    event("/api/users", 200, 1),
    event("/about", 200, 1),
    event("/api/posts", 200, 1),
  ]);
  const box = filterBox(detailPane);
  box.value = "  API/  ";
  box.dispatch("input");
  assertEquals(rowPaths(detailPane), ["GET /api/posts", "GET /api/users"]);
  assert(detailPane.textContent.includes("2 of 3"), detailPane.textContent);

  filterBox(detailPane).value = "nothing-matches";
  filterBox(detailPane).dispatch("input");
  assertEquals(bodyRows(detailPane).length, 0);
  assert(detailPane.textContent.includes("no requests match the filter"), detailPane.textContent);
});

Deno.test("network tab: an empty log says so, keeping the toolbar", async () => {
  const { ctx, detailPane } = networkCtx();
  await load(ctx, []);
  assert(detailPane.textContent.includes("no requests yet"), detailPane.textContent);
  assert(errorsBtn(detailPane), "the toolbar is still there");
});

Deno.test("network tab: malformed events are skipped, never thrown on", async () => {
  const { ctx, detailPane } = networkCtx();
  await load(ctx, [
    null,
    "not an event",
    42,
    {},
    { message: 7, url: null },
    { message: "no method or arrow", url: "/fallback", status: "204", durationMs: "x", ts: "y" },
    { url: "/only-url" },
    event("/good", 201, 5),
  ]);
  // Newest first: the good row, the url-only row, then the unparseable-message row.
  assertEquals(rowPaths(detailPane), ["GET /good", "/only-url", "/fallback"]);
  assertEquals(pill(detailPane, 1).textContent, "—", "a missing status renders as a dash");
  assert(detailPane.textContent.includes("0ms"), "a missing duration renders as zero");
  assert(detailPane.textContent.includes("3 requests"), detailPane.textContent);
});

Deno.test("network tab: a payload that is not an event list renders as empty", async () => {
  for (const payload of [{ events: "nope" }, {}, null]) {
    const { ctx, detailPane } = networkCtx();
    await withFetch(() => Promise.resolve(Response.json(payload)), async () => {
      refreshNetworkTab(ctx);
      await new Promise((r) => setTimeout(r, 0));
    });
    assert(detailPane.textContent.includes("no requests yet"), detailPane.textContent);
  }
});

Deno.test("network tab: an absent endpoint renders the App-Router-only state", async () => {
  const { ctx, detailPane } = networkCtx();
  renderNetworkTab(ctx);
  assertEquals(detailPane.textContent, "loading…");

  await withFetch(() => Promise.resolve(new Response("nope", { status: 404 })), async () => {
    refreshNetworkTab(ctx);
    await new Promise((r) => setTimeout(r, 0));
  });
  assertEquals(
    detailPane.textContent,
    "Network is not available in SPA dev (App Router only)",
  );
  assertEquals(ctx.state.dataUnavailable, true);
  assertEquals(bodyRows(detailPane).length, 0);
});

Deno.test("network tab: a failed poll keeps the last good table on screen", async () => {
  const { ctx, detailPane } = networkCtx();
  await load(ctx, [event("/kept", 200, 2)]);
  await withFetch(() => Promise.resolve(new Response("boom", { status: 500 })), async () => {
    refreshNetworkTab(ctx);
    await new Promise((r) => setTimeout(r, 0));
  });
  assertEquals(rowPaths(detailPane), ["GET /kept"]);
});
