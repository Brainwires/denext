// The dev console capture (src/build/dev-server/console-capture-script.ts): evaluated against
// a fake window — console, fetch, timers, document — so nothing patches the test process's
// own console. Covers capture + serialization, the buffer bound, forwarding to the dev log,
// script load errors, and the boot diagnosis over a fake module graph.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CONSOLE_BUFFER_LIMIT,
  consoleCaptureScript,
} from "../src/build/dev-server/console-capture-script.ts";
import { DEV_RELOAD_SCRIPT } from "../src/build/dev-server/reload-script.ts";
import { SPA_DEV_RELOAD } from "../src/build/spa/dev-reload-script.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ORIGIN = "http://localhost:3000";

interface FakeModule {
  status?: number;
  type?: string;
  body: string;
}

function fakeScript(attrs: Record<string, string>): Any {
  return {
    tagName: "SCRIPT",
    nodeType: 1,
    nodeName: "SCRIPT",
    getAttribute: (n: string) => attrs[n] ?? null,
  };
}

/** Evaluate the capture script against fakes; returns the handles a test drives. */
function setup(opts: { modules?: Record<string, FakeModule>; scripts?: Any[] } = {}) {
  const calls: { level: string; args: unknown[] }[] = [];
  const fakeConsole: Any = {};
  for (const lvl of ["log", "info", "warn", "error", "debug"]) {
    fakeConsole[lvl] = (...args: unknown[]) => calls.push({ level: lvl, args });
  }
  const timers: (() => void)[] = [];
  const posts: unknown[][] = [];
  const fetched: string[] = [];
  const listeners: Record<string, ((e: Any) => void)[]> = {};
  const modules = opts.modules ?? {};
  const win: Any = {
    console: fakeConsole,
    setTimeout: (fn: () => void) => (timers.push(fn), timers.length),
    addEventListener: (t: string, fn: (e: Any) => void) => (listeners[t] ??= []).push(fn),
    fetch: (url: string, init?: Any) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(init.body));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      fetched.push(url);
      const m = modules[url];
      if (!m) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(
        new Response(m.body, {
          status: m.status ?? 200,
          headers: { "content-type": m.type ?? "text/javascript; charset=utf-8" },
        }),
      );
    },
  };
  const doc: Any = {
    querySelectorAll: (sel: string) => sel.includes("importmap") ? [] : (opts.scripts ?? []),
  };
  const location = { href: `${ORIGIN}/`, origin: ORIGIN, pathname: "/" };
  new Function("window", "document", "location", consoleCaptureScript("/_denext/dev-log"))(
    win,
    doc,
    location,
  );
  /** Run the queued timers (repeatedly — a timer may queue another). */
  const tick = () => {
    for (let i = 0; i < 20 && timers.length; i++) timers.splice(0).forEach((fn) => fn());
  };
  const fire = (type: string, e: Any) => (listeners[type] ?? []).forEach((fn) => fn(e));
  return { win, store: win.__denextConsole, fakeConsole, calls, tick, posts, fetched, fire };
}

Deno.test("console capture: records every level and still calls the original", () => {
  const { store, fakeConsole, calls } = setup();
  fakeConsole.log("hello", 1, true);
  fakeConsole.info("i");
  fakeConsole.warn("w");
  fakeConsole.error("e");
  fakeConsole.debug("d");
  assertEquals(calls.map((c) => c.level), ["log", "info", "warn", "error", "debug"]);
  assertEquals(calls[0].args, ["hello", 1, true]);
  assertEquals(
    store.entries.map((e: Any) => [e.level, e.message]),
    [["log", "hello 1 true"], ["info", "i"], ["warn", "w"], ["error", "e"], ["debug", "d"]],
  );
  assertEquals(store.errorCount, 1);
});

Deno.test("console capture: serializes cycles, errors, DOM nodes, %-formats and long strings", () => {
  const { store } = setup();
  const cyc: Any = { a: 1 };
  cyc.self = cyc;
  assertEquals(store.format([cyc]), "{a: 1, self: [Circular]}");
  const err = new TypeError("bad thing");
  assertEquals(store.format(["boom", err]), "boom TypeError: bad thing");
  const node = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    id: "root",
    className: "a b",
    getAttribute: () => null,
  };
  assertEquals(store.format([node]), "<div#root.a.b>");
  assertEquals(store.format(["%c[denext] ready", "color:red", "— x"]), "[denext] ready — x");
  assertEquals(store.format(["%s has %d", "list", 3]), "list has 3");
  assertEquals(store.format([[1, "two", null, undefined]]), '[1, "two", null, undefined]');
  assertEquals(store.format([{ deep: { er: { est: { x: 1 } } } }]), "{deep: {er: {est: {…}}}}");
  const long = store.format(["x".repeat(5000)]);
  assert(long.length < 2100, `truncated (${long.length})`);
  assertStringIncludes(long, "more chars");
});

Deno.test("console capture: an error argument's stack is kept", () => {
  const { store, fakeConsole } = setup();
  const err = new Error("kaboom");
  fakeConsole.error("failed:", err);
  assertStringIncludes(store.entries[0].stack, "kaboom");
});

Deno.test("console capture: the buffer is bounded (oldest dropped)", () => {
  const { store, fakeConsole } = setup();
  for (let i = 0; i < CONSOLE_BUFFER_LIMIT + 25; i++) fakeConsole.log(`line ${i}`);
  assertEquals(store.entries.length, CONSOLE_BUFFER_LIMIT);
  assertEquals(store.entries[0].message, "line 25");
  assertEquals(store.entries.at(-1).message, `line ${CONSOLE_BUFFER_LIMIT + 24}`);
  store.clear();
  assertEquals(store.entries.length, 0);
  assertEquals(store.errorCount, 0);
});

Deno.test("console capture: entries are forwarded to the dev log in batches", () => {
  const { fakeConsole, tick, posts } = setup();
  fakeConsole.warn("careful");
  fakeConsole.log("plain");
  tick();
  assertEquals(posts.length, 1);
  const batch = posts[0] as Any[];
  assertEquals(batch.map((l) => [l.level, l.message]), [["warn", "careful"], ["log", "plain"]]);
});

Deno.test("console capture: uncaught errors, rejections and resource failures are recorded", () => {
  const { store, fire, tick } = setup();
  const err = new RangeError("out of range");
  fire("error", { error: err, message: err.message });
  fire("unhandledrejection", { reason: new Error("nope") });
  fire("error", {
    target: {
      tagName: "IMG",
      nodeType: 1,
      nodeName: "IMG",
      getAttribute: (n: string) => n === "src" ? "/x.png" : null,
    },
  });
  tick();
  const msgs = store.entries.map((e: Any) => `${e.source}: ${e.message}`);
  assertEquals(msgs, [
    "uncaught: RangeError: out of range",
    "rejection: Unhandled rejection: Error: nope",
    'resource: failed to load <img src="/x.png">',
  ]);
  assertEquals(store.errorCount, 3);
});

/** A module graph whose second hop is the SPA fallback's HTML, served for a JS import. */
function brokenGraph(): Record<string, FakeModule> {
  return {
    [`${ORIGIN}/_denext/entry.js`]: {
      body: `import { a } from "./a.js";\nimport "/_denext/@m/side.js";\n` +
        `export default async function main() { await import("./lazy.js"); return a; }\n`,
    },
    [`${ORIGIN}/_denext/a.js`]: {
      body: `import{b as c}from"./b.js";export const a = c + 1;\nexport { c };\n`,
    },
    [`${ORIGIN}/_denext/b.js`]: {
      type: "text/html; charset=utf-8",
      body: "<!doctype html><html><body><div id=root></div></body></html>",
    },
    [`${ORIGIN}/_denext/@m/side.js`]: { body: `console.log(import.meta.url);\n` },
    [`${ORIGIN}/_denext/lazy.js`]: { body: `export class Lazy {}\n` },
  };
}

Deno.test("boot diagnosis: an HTML-instead-of-JS module is reported with its importer", async () => {
  const { store, tick } = setup({
    modules: brokenGraph(),
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  const done = store.diagnose("test");
  const d = await done;
  tick();
  assertEquals(d.state, "done");
  assertEquals(d.checked, 5);
  assertEquals(d.failures.length, 1, JSON.stringify(d.failures));
  assertEquals(d.failures[0].url, `${ORIGIN}/_denext/b.js`);
  assertEquals(d.failures[0].from, `${ORIGIN}/_denext/a.js`);
  assertStringIncludes(d.failures[0].reason, "text/html");
  assertStringIncludes(d.failures[0].reason, "HTML");
  const line = store.entries.find((e: Any) => e.source === "diagnosis" && e.level === "error");
  assertStringIncludes(line.message, "/_denext/b.js");
  assertStringIncludes(line.message, "imported by");
});

Deno.test("boot diagnosis: a 404, a syntax error and an unresolvable bare specifier", async () => {
  const { store } = setup({
    modules: {
      [`${ORIGIN}/_denext/entry.js`]: {
        body: `import "./missing.js";\nimport "./broken.js";\nimport "./bare.js";\n`,
      },
      [`${ORIGIN}/_denext/broken.js`]: { body: `export const x = ;\n` },
      [`${ORIGIN}/_denext/bare.js`]: {
        body: `import React from "react";\nexport default React;\n`,
      },
    },
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  const d = await store.diagnose("test");
  const byUrl = Object.fromEntries(
    d.failures.map((f: Any) => [f.url.slice(ORIGIN.length), f.reason]),
  );
  assertStringIncludes(byUrl["/_denext/missing.js"], "HTTP 404");
  assertStringIncludes(byUrl["/_denext/broken.js"], "does not parse");
  assertStringIncludes(byUrl["/_denext/bare.js"], '"react"');
});

Deno.test("boot diagnosis: a healthy graph reports no failures", async () => {
  const graph = brokenGraph();
  graph[`${ORIGIN}/_denext/b.js`] = { body: `export const b = 1;\n` };
  const { store } = setup({
    modules: graph,
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  const d = await store.diagnose("test");
  assertEquals(d.failures, []);
  const last = store.entries.at(-1);
  assertStringIncludes(last.message, "5 module(s) checked");
});

Deno.test("boot diagnosis: runs on its own when the entry module script fails to load", async () => {
  const entry = fakeScript({ type: "module", src: "/_denext/entry.js" });
  const { store, fire } = setup({ modules: brokenGraph(), scripts: [entry] });
  fire("error", { target: entry });
  assertEquals(store.diagnosis.state, "running");
  const d = await store.diagnose(); // joins the running walk
  assertEquals(d.failures.length, 1);
  assertStringIncludes(store.entries[0].message, "failed to load module script /_denext/entry.js");
});

Deno.test("boot diagnosis: an import error message schedules one walk", async () => {
  const { store, fire, tick } = setup({
    modules: brokenGraph(),
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  fire("unhandledrejection", { reason: new TypeError("Importing a module script failed.") });
  assertEquals(store.importErrorSeen, true);
  tick();
  const d = await store.diagnose();
  assertEquals(d.failures.length, 1);
});

Deno.test("both dev-reload scripts start with the console capture", () => {
  for (const script of [DEV_RELOAD_SCRIPT, SPA_DEV_RELOAD]) {
    assertStringIncludes(script.slice(0, 400), "__denextConsole");
    assertStringIncludes(script, "/_denext/dev-log");
  }
});
