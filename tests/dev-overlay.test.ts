// W8 — dev error overlay. The dev script (injected only into dev pages) installs
// a full-screen error overlay fed by window 'error'/'unhandledrejection' events
// and server-pushed build-error SSE frames. Evaluate the script in a fake DOM and
// confirm it renders on a simulated runtime error.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DEV_RELOAD_SCRIPT } from "../src/build/dev-server.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

function evalDevScript() {
  const { doc } = makeDom();
  const body = (doc as Any).createElement("body");
  (doc as Any).body = body;
  const listeners: Record<string, (e: Any) => void> = {};
  const win: Any = {
    addEventListener: (t: string, fn: (e: Any) => void) => (listeners[t] = fn),
  };
  // EventSource is undefined here, so the script's `new EventSource()` throws and
  // is swallowed by its own try/catch — the overlay wiring still installs.
  const run = new Function("window", "document", "location", "EventSource", DEV_RELOAD_SCRIPT);
  run(win, doc, { reload() {} }, undefined);
  return { win, body, listeners };
}

Deno.test("dev script installs the marker and overlay API", () => {
  const { win, listeners } = evalDevScript();
  assertEquals(win.__denextDev, true);
  assertEquals(typeof win.__denextOverlay, "function");
  assert(listeners["error"], "listens for runtime errors");
  assert(listeners["unhandledrejection"], "listens for unhandled rejections");
});

Deno.test("dev overlay renders on a runtime error and shows message + stack", () => {
  const { body, listeners } = evalDevScript();
  listeners["error"]({ error: { message: "boom", stack: "at foo (app.tsx:3:5)" } });
  const html = body.innerHTML;
  assertStringIncludes(html, "denext — Runtime error");
  assertStringIncludes(html, "boom");
  assertStringIncludes(html, "at foo (app.tsx:3:5)");
});

Deno.test("dev overlay shows an unhandled rejection", () => {
  const { body, listeners } = evalDevScript();
  listeners["unhandledrejection"]({ reason: { message: "nope", stack: "at bar" } });
  assertStringIncludes(body.innerHTML, "denext — Unhandled rejection");
  assertStringIncludes(body.innerHTML, "nope");
});

Deno.test("a second overlay replaces the first (no stacking)", () => {
  const { body, win } = evalDevScript();
  win.__denextOverlay("Build error", "first", "");
  win.__denextOverlay("Build error", "second", "");
  // Exactly one overlay child remains, showing the latest message.
  assertEquals(body.childNodes.length, 1);
  assertStringIncludes(body.innerHTML, "second");
  assert(!body.innerHTML.includes("first"), "prior overlay was removed");
});
