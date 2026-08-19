// Dev server client contract (DEV_RELOAD_SCRIPT). The reload/HMR script is
// injected only into dev pages; here it is evaluated in a fake DOM and its
// Fast-Refresh `refresh()` path is driven through the SSE channel to verify the
// same-origin guard (L3), the cache-busting re-import, and the reload fallbacks.
// (The error-overlay half of the same script is covered by dev-overlay.test.ts.)

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DEV_RELOAD_SCRIPT } from "../src/build/dev-server.ts";
import { FakeElement } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

interface DevHarness {
  win: Any;
  location: { href: string; origin: string; reload: () => void };
  reloads: { count: number };
  body: FakeElement;
  /** The captured EventSource instance the script wired its onmessage onto. */
  es: () => Any;
  /** The most recently appended <script> child of <body>, or undefined. */
  lastScript: () => FakeElement & { src?: string; onload?: () => void; onerror?: () => void };
}

/** Evaluate DEV_RELOAD_SCRIPT against a fake DOM and return handles to drive it. */
function runDevScript(opts: { scriptSrc?: string | null; href?: string } = {}): DevHarness {
  const href = opts.href ?? "http://localhost:3000/app";
  const origin = new URL(href).origin;
  const reloads = { count: 0 };
  const location = { href, origin, reload: () => void reloads.count++ };

  const body = new FakeElement("body");

  let scriptEl: FakeElement | null;
  if (opts.scriptSrc === null) {
    scriptEl = null; // no matching module <script> in the document
  } else {
    scriptEl = new FakeElement("script");
    scriptEl.setAttribute("type", "module");
    scriptEl.setAttribute("src", opts.scriptSrc ?? "/_denext/route.js");
  }

  const document: Any = {
    querySelector: () => scriptEl,
    createElement: (tag: string) => new FakeElement(tag),
    body,
    documentElement: body,
  };

  const win: Any = { addEventListener: () => {} };

  let es: Any = null;
  class FakeEventSource {
    onmessage: ((e: { data: string }) => void) | null = null;
    url: string;
    constructor(url: string) {
      this.url = url;
      es = this;
    }
  }

  const run = new Function("window", "document", "location", "EventSource", DEV_RELOAD_SCRIPT);
  run(win, document, location, FakeEventSource);

  return {
    win,
    location,
    reloads,
    body,
    es: () => es,
    lastScript: () => body.childNodes[body.childNodes.length - 1] as Any,
  };
}

/** Push an SSE frame through the script's onmessage handler. */
function sse(h: DevHarness, data: string) {
  h.es().onmessage({ data });
}

Deno.test("dev script wires an EventSource to the reload channel", () => {
  const h = runDevScript();
  assert(h.es(), "the script opened an EventSource");
  assertEquals(h.es().url, "/_denext/reload");
  assertEquals(typeof h.es().onmessage, "function");
});

Deno.test("a refresh frame re-imports the route entry cache-busted from same origin", () => {
  const h = runDevScript({ scriptSrc: "/_denext/route.js" });
  sse(h, "refresh");
  assertEquals(h.reloads.count, 0, "same-origin refresh must NOT hard-reload");
  assertEquals(h.win.__denextRefreshing, true);
  const injected = h.lastScript();
  assertEquals(injected.tagName, "SCRIPT");
  assertStringIncludes(injected.src ?? "", "http://localhost:3000/_denext/route.js");
  assertStringIncludes(injected.src ?? "", "hmr=1");
});

Deno.test("L3: a cross-origin script src hard-reloads instead of re-importing", () => {
  const h = runDevScript({ scriptSrc: "https://evil.example/_denext/x.js" });
  sse(h, "refresh");
  assertEquals(h.reloads.count, 1, "cross-origin src must fall back to a hard reload");
  assertEquals(h.body.childNodes.length, 0, "no cross-origin script may be injected");
  assert(h.win.__denextRefreshing !== true, "refresh must not proceed for a foreign origin");
});

Deno.test("L3: a protocol-relative //host src is treated as cross-origin", () => {
  const h = runDevScript({ scriptSrc: "//evil.example/_denext/x.js" });
  sse(h, "refresh");
  assertEquals(h.reloads.count, 1);
  assertEquals(h.body.childNodes.length, 0);
});

Deno.test("refresh with no matching module script falls back to a reload", () => {
  const h = runDevScript({ scriptSrc: null });
  sse(h, "refresh");
  assertEquals(h.reloads.count, 1);
  assertEquals(h.body.childNodes.length, 0);
});

Deno.test("the hmr cache-buster increments across successive refreshes", () => {
  const h = runDevScript({ scriptSrc: "/_denext/route.js" });
  sse(h, "refresh");
  sse(h, "refresh");
  assertEquals(h.body.childNodes.length, 2);
  assertStringIncludes((h.body.childNodes[1] as Any).src ?? "", "hmr=2");
});

Deno.test("a re-imported script removes itself on load and does not reload", () => {
  const h = runDevScript({ scriptSrc: "/_denext/route.js" });
  sse(h, "refresh");
  const injected = h.lastScript();
  injected.onload!();
  assertEquals(h.body.childNodes.length, 0, "loaded script cleans itself up");
  assertEquals(h.reloads.count, 0);
});

Deno.test("a re-imported script that errors hard-reloads as a fallback", () => {
  const h = runDevScript({ scriptSrc: "/_denext/route.js" });
  sse(h, "refresh");
  const injected = h.lastScript();
  injected.onerror!();
  assertEquals(h.reloads.count, 1, "a failed re-import falls back to a full reload");
  assertEquals(h.body.childNodes.length, 0);
});

Deno.test("a reload frame triggers a full page reload", () => {
  const h = runDevScript({ scriptSrc: "/_denext/route.js" });
  sse(h, "reload");
  assertEquals(h.reloads.count, 1);
  assertEquals(h.body.childNodes.length, 0, "reload never injects a script");
});

Deno.test("dev script sets the __denextDev marker for the client reconciler", () => {
  const h = runDevScript();
  assertEquals(h.win.__denextDev, true);
});
