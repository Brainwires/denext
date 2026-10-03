// The dev console capture (src/build/dev-server/console-capture-script.ts): evaluated against
// a fake window — console, fetch, timers, document — so nothing patches the test process's
// own console. Covers capture + serialization, the buffer bound, forwarding to the dev log,
// script load errors, and the boot diagnosis over a fake module graph.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CONSOLE_BUFFER_LIMIT,
  consoleCaptureScript,
  DEEP_DIAGNOSIS_MODULE_CAP,
  DIAGNOSIS_MODULE_CAP,
  RELOAD_LOOP_LIMIT,
  RELOAD_LOOP_WINDOW_MS,
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
function setup(
  opts: {
    modules?: Record<string, FakeModule>;
    scripts?: Any[];
    session?: Map<string, string>;
  } = {},
) {
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
  const session = opts.session;
  const win: Any = {
    console: fakeConsole,
    sessionStorage: session && {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, String(v)),
      removeItem: (k: string) => void session.delete(k),
    },
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
  // The static pass found the failure, so the deep pass (lazy.js, a dynamic import) never ran.
  assertEquals(d.checked, 4);
  assertEquals(d.pass, "static");
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

// ── The deep pass: graphs reachable only through a dynamic import ────────────────────────────

const FS = `${ORIGIN}/_denext/@fs/app/src`;

/**
 * The SPA dev shape T3 Code boots through: the generated entry dynamically imports the app
 * entry, whose `void import("./main").then(...).catch(showBootError)` the dev transform serves
 * as `import("/_denext/@fs/…/main.tsx?v=1")`. The failure (an HTML fallback for a JS import)
 * is two static hops below `main`, so a static-only walk never reaches it.
 */
function dynamicOnlyGraph(): Record<string, FakeModule> {
  return {
    [`${ORIGIN}/_denext/@entry`]: {
      body: `import { installDevtools } from "/_denext/@dep/devtools.js";\n` +
        `globalThis.__denextDev = true;\ninstallDevtools();\n` +
        `await import("/_denext/@fs/app/src/bootstrap.ts?v=1");\n`,
    },
    [`${ORIGIN}/_denext/@dep/devtools.js`]: { body: `export function installDevtools() {}\n` },
    [`${FS}/bootstrap.ts?v=1`]: {
      body:
        `// bootstrap.ts\nimport { showBootError } from "/_denext/@fs/app/src/lib/bootError.ts?v=1";\n` +
        `void import("/_denext/@fs/app/src/main.tsx?v=1").then(({ startup }) => startup)` +
        `.catch(showBootError);\n`,
    },
    [`${FS}/lib/bootError.ts?v=1`]: { body: `export function showBootError(e) {}\n` },
    [`${FS}/main.tsx?v=1`]: {
      body:
        `import { App } from "/_denext/@fs/app/src/App.tsx?v=1";\nexport const startup = App;\n`,
    },
    [`${FS}/App.tsx?v=1`]: {
      body:
        `import { Router } from "/_denext/@fs/app/src/router.ts?v=1";\nexport const App = Router;\n`,
    },
    [`${FS}/router.ts?v=1`]: {
      type: "text/html; charset=utf-8",
      body: "<!doctype html><html><body><div id=root></div></body></html>",
    },
  };
}

const ENTRY_SCRIPT = () => fakeScript({ type: "module", src: "/_denext/@entry" });

Deno.test("boot diagnosis: a failure reachable only through import('./main') is reported", async () => {
  const { store, tick } = setup({ modules: dynamicOnlyGraph(), scripts: [ENTRY_SCRIPT()] });
  const d = await store.diagnose("test");
  tick();
  assertEquals(d.pass, "deep");
  assertEquals(d.staticChecked, 2, "the static pass: the entry and its static dep");
  assertEquals(d.failures.length, 1, JSON.stringify(d.failures));
  assertEquals(d.failures[0].url, `${FS}/router.ts?v=1`);
  assertEquals(d.failures[0].from, `${FS}/App.tsx?v=1`);
  const msgs = store.entries.map((e: Any) => e.message);
  assert(msgs.some((m: string) => m.includes("following dynamic imports too")), msgs.join("\n"));
});

Deno.test("boot diagnosis: a caught boot import that is only console.error'd starts the walk", async () => {
  // T3's `showBootError`: `console.error("T3 Code failed to start.", error)` — no unhandled
  // rejection, no uncaught error. The logged import failure has to start the walk itself.
  const { store, fakeConsole, tick } = setup({
    modules: dynamicOnlyGraph(),
    scripts: [ENTRY_SCRIPT()],
  });
  fakeConsole.error("T3 Code failed to start.", new TypeError("Importing a module script failed."));
  assertEquals(store.importErrorSeen, true);
  assertEquals(store.diagnosis.state, "idle", "scheduled, not yet started");
  tick();
  assertEquals(store.diagnosis.state, "running");
  const d = await store.diagnose(); // joins the running walk
  assertEquals(d.failures.map((f: Any) => f.url), [`${FS}/router.ts?v=1`]);
});

Deno.test("boot diagnosis: starts from the module the browser's import error names", async () => {
  // Chrome names the dynamically imported module; here the entry's own graph never reaches it,
  // so only the named URL can lead the walk to the failure.
  const graph = dynamicOnlyGraph();
  graph[`${ORIGIN}/_denext/@entry`] = { body: `export {};\n` };
  const { store, fire, tick } = setup({ modules: graph, scripts: [ENTRY_SCRIPT()] });
  const named = `${FS}/main.tsx?v=1`;
  fire("unhandledrejection", {
    reason: new TypeError(`Failed to fetch dynamically imported module: ${named}`),
  });
  assertEquals(store.importErrorUrl, named);
  tick();
  const d = await store.diagnose();
  assertEquals(d.named, named);
  assertEquals(d.pass, "static", "the named module's static graph holds the failure");
  assertEquals(d.failures.map((f: Any) => [f.url, f.from]), [[
    `${FS}/router.ts?v=1`,
    `${FS}/App.tsx?v=1`,
  ]]);
  const started = store.entries.find((e: Any) => e.message.includes("walking the module graph"));
  assertStringIncludes(started.message, named);
});

Deno.test("boot diagnosis: a cross-origin URL in the message is not walked", async () => {
  const { store, fire, tick } = setup({ modules: brokenGraph(), scripts: [] });
  fire("unhandledrejection", {
    reason: new TypeError("Failed to fetch dynamically imported module: https://cdn.example/x.js"),
  });
  assertEquals(store.importErrorUrl, "");
  tick();
  const d = await store.diagnose();
  assertEquals(d.checked, 0);
  assertStringIncludes(d.note, "no same-origin module entry");
});

Deno.test("boot diagnosis: a worker module (new URL(…, import.meta.url)) is followed, an asset is not", async () => {
  const { store, fetched } = setup({
    modules: {
      [`${ORIGIN}/_denext/entry.js`]: {
        body:
          `const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });\n` +
          `const logo = new URL("./logo.png", import.meta.url);\n` +
          `const r = import.meta.resolve("./resolved.js");\n`,
      },
      [`${ORIGIN}/_denext/worker.ts`]: { body: `export {};\n` },
      [`${ORIGIN}/_denext/resolved.js`]: { body: `export const x = ;\n` },
    },
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  const d = await store.diagnose("test");
  assert(fetched.includes(`${ORIGIN}/_denext/worker.ts`), fetched.join("\n"));
  assert(!fetched.some((u) => u.endsWith("logo.png")), "an asset URL is not a module");
  assertEquals(d.failures.map((f: Any) => f.url), [`${ORIGIN}/_denext/resolved.js`]);
});

/** An entry importing `n` leaf modules statically (`m<i>.js`); `bad` serves a 404. */
function fanOut(n: number, bad = -1, dynamic = false): Record<string, FakeModule> {
  const lines: string[] = [];
  const graph: Record<string, FakeModule> = {};
  for (let i = 0; i < n; i++) {
    lines.push(dynamic ? `import("./m${i}.js");` : `import "./m${i}.js";`);
    if (i !== bad) graph[`${ORIGIN}/_denext/m${i}.js`] = { body: `export const v${i} = ${i};\n` };
  }
  graph[`${ORIGIN}/_denext/entry.js`] = { body: lines.join("\n") + "\n" };
  return graph;
}

Deno.test("boot diagnosis: static edges past the static cap are walked by the deep pass", async () => {
  const n = DIAGNOSIS_MODULE_CAP + 50;
  const { store } = setup({
    modules: fanOut(n, n - 5),
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  const d = await store.diagnose("test");
  assertEquals(d.staticChecked, DIAGNOSIS_MODULE_CAP);
  assertEquals(d.pass, "deep");
  assertEquals(d.checked, n + 1);
  assertEquals(d.failures.map((f: Any) => f.url), [`${ORIGIN}/_denext/m${n - 5}.js`]);
  const progress = store.entries.filter((e: Any) => e.message.includes("pending (deep pass)"));
  assert(progress.length >= 1, "the deep pass reports progress");
});

Deno.test("boot diagnosis: the deep pass stops at its cap and says so", async () => {
  const { store } = setup({
    modules: fanOut(DEEP_DIAGNOSIS_MODULE_CAP + 100, -1, true),
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  const d = await store.diagnose("test");
  assertEquals(d.checked, DEEP_DIAGNOSIS_MODULE_CAP);
  assertEquals(d.capped, true);
  assertEquals(d.failures, []);
  assertStringIncludes(
    store.entries.at(-1).message,
    `stopped at ${DEEP_DIAGNOSIS_MODULE_CAP} modules`,
  );
});

// ── The link check: an imported name the target does not export ─────────────────────────────

/** A graph of `/_denext/<name>` modules (the entry is `entry.js`), and a walk over it. */
async function linkWalk(files: Record<string, string>) {
  const modules: Record<string, FakeModule> = {};
  for (const [name, body] of Object.entries(files)) modules[`${ORIGIN}/_denext/${name}`] = { body };
  const h = setup({ modules, scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })] });
  const d = await h.store.diagnose("test");
  const missing = d.failures
    .filter((f: Any) => f.missing != null)
    .map((f: Any) => [f.from.slice(ORIGIN.length), f.missing, f.url.slice(ORIGIN.length), f.hint]);
  return { ...h, d, missing };
}

const at = (name: string) => `${ORIGIN}/_denext/${name}`;

Deno.test("link check: a missing named export is reported with its importer and a hint", async () => {
  const { d, missing, store } = await linkWalk({
    "entry.js": `import { formatDate, parse } from "./util.js";\nformatDate(parse("x"));\n`,
    "util.js": `export function formatDates() {}\nexport const parse = (s) => s;\n`,
  });
  assertEquals(missing, [["/_denext/entry.js", "formatDate", "/_denext/util.js", "formatDates"]]);
  assertEquals(d.pass, "static", "a link failure ends the walk before the deep pass");
  assertStringIncludes(d.failures[0].reason, 'does not export "formatDate"');
  const line = store.entries.find((e: Any) => e.source === "diagnosis" && e.level === "error");
  assertEquals(
    line.message,
    `boot diagnosis: ${at("entry.js")} imports "formatDate" from ${at("util.js")}, ` +
      `which does not export it — did you mean "formatDates"?`,
  );
});

Deno.test("link check: a default import of a module without a default export", async () => {
  const { missing } = await linkWalk({
    "entry.js": `import React from "./react.js";\nimport * as all from "./react.js";\n`,
    // An ESM bundle of a CJS package that only re-exports names (no default).
    "react.js": `var x = 1;\nexport { x as createElement, x as useState };\n`,
  });
  assertEquals(missing, [["/_denext/entry.js", "default", "/_denext/react.js", ""]]);
});

Deno.test("link check: export * chains resolve (default excluded) without false positives", async () => {
  const { missing, d } = await linkWalk({
    "entry.js":
      `import { a, b, c, deep } from "./index.js";\nimport def, { nope } from "./index.js";\n`,
    "index.js": `export * from "./ab.js";\nexport * from "./c.js";\nexport default 1;\n`,
    "ab.js": `export const a = 1, b = 2;\nexport * from "./deep.js";\n`,
    "c.js": `export function c() {}\nexport default "c's default is not re-exported by *";\n`,
    "deep.js": `export class deep {}\n`,
  });
  assertEquals(missing, [["/_denext/entry.js", "nope", "/_denext/index.js", ""]]);
  assertEquals(d.failures.length, 1);
});

Deno.test("link check: export * does not re-export default", async () => {
  const { missing } = await linkWalk({
    "entry.js": `import x from "./barrel.js";\n`,
    "barrel.js": `export * from "./impl.js";\n`,
    "impl.js": `export default function impl() {}\n`,
  });
  assertEquals(missing, [["/_denext/entry.js", "default", "/_denext/barrel.js", ""]]);
});

Deno.test("link check: aliasing — export { a as b }, as default, and re-exports", async () => {
  const { missing } = await linkWalk({
    "entry.js":
      `import Main, { b, renamed } from "./alias.js";\nimport { a } from "./alias.js";\n` +
      `export { gone } from "./alias.js";\n`,
    "alias.js": `const a = 1;\nfunction main() {}\nexport { a as b, main as default };\n` +
      `export { inner as renamed } from "./inner.js";\n`,
    "inner.js": `export const inner = 1;\n`,
  });
  assertEquals(missing, [
    ["/_denext/entry.js", "a", "/_denext/alias.js", "b"],
    ["/_denext/entry.js", "gone", "/_denext/alias.js", ""],
  ]);
});

Deno.test("link check: a re-export of a name the source lacks is reported", async () => {
  const { missing } = await linkWalk({
    "entry.js": `import { thing } from "./index.js";\n`,
    "index.js": `export { thing } from "./impl.js";\n`,
    "impl.js": `export const thingy = 1;\n`,
  });
  assertEquals(missing, [["/_denext/index.js", "thing", "/_denext/impl.js", "thingy"]]);
});

Deno.test("link check: an export * cycle is safe and still resolves every name", async () => {
  const { missing, d } = await linkWalk({
    "entry.js": `import { a, b, c } from "./a.js";\nimport { a as a2, missing } from "./b.js";\n`,
    "a.js": `export * from "./b.js";\nexport const a = 1;\n`,
    "b.js": `export * from "./a.js";\nexport * from "./c.js";\nexport const b = 2;\n`,
    "c.js": `export * from "./b.js";\nexport const c = 3;\n`,
  });
  assertEquals(d.state, "done");
  assertEquals(missing, [["/_denext/entry.js", "missing", "/_denext/b.js", ""]]);
});

Deno.test("link check: strings, comments, templates and regexes don't count as exports", async () => {
  const { missing } = await linkWalk({
    "entry.js": `import { real, fake, cmt, blk, tpl, rx } from "./tricky.js";\n`,
    "tricky.js": [
      `const s = "export function fake() {}";`,
      `// export function cmt() {}`,
      `/* export const blk = 1; */`,
      "const t = `export const tpl = ${'`export const tpl2`'}`;",
      `const r = /export function rx() {}/;`,
      `const ratio = 4 / 2; export function real() {}`,
    ].join("\n"),
  });
  assertEquals(missing.map((m: Any[]) => m[1]), ["fake", "cmt", "blk", "tpl", "rx"]);
});

Deno.test("link check: a module it can't analyze is skipped, not guessed at", async () => {
  const { missing, d } = await linkWalk({
    "entry.js": `import { a } from "./cjs.js";\nimport { b } from "./destructured.js";\n` +
      `import { c } from "./star-of-cjs.js";\nimport { d } from "./broken.js";\n`,
    "cjs.js": `module.exports = { a: 1 };\n`,
    "destructured.js": `export const { b } = { b: 1 };\n`,
    "star-of-cjs.js": `export * from "./cjs.js";\n`,
    "broken.js": `export const d = "unterminated;\n`,
  });
  assertEquals(missing, []);
  // broken.js fails the parse check on its own; no link failure is invented for it.
  assert(d.failures.every((f: Any) => f.missing == null), JSON.stringify(d.failures));
});

Deno.test("link check: a healthy graph with every import form reports nothing", async () => {
  const { d, store } = await linkWalk({
    "entry.js": `import def, { named as local, other } from "./lib.js";\n` +
      `import * as ns from "./lib.js";\nimport "./side.js";\n` +
      `export { other } from "./lib.js";\nexport * as all from "./lib.js";\n` +
      `const lazy = () => import("./lazy.js");\n`,
    "lib.js": `export default 1;\nexport const named = 1;\nexport async function other() {}\n`,
    "side.js": `console.log("export const nothing = 1");\n`,
    "lazy.js": `import def from "./lib.js";\nexport {};\n`,
  });
  assertEquals(d.failures, []);
  assertEquals(d.pass, "deep");
  assertStringIncludes(store.entries.at(-1).message, "every analyzable import naming an export");
});

Deno.test("link check: the deep pass checks modules behind a dynamic import too", async () => {
  const { d, missing } = await linkWalk({
    "entry.js": `const lazy = () => import("./lazy.js");\n`,
    "lazy.js": `import { gone } from "./lib.js";\nexport {};\n`,
    "lib.js": `export const here = 1;\n`,
  });
  assertEquals(d.pass, "deep");
  assertEquals(missing, [["/_denext/lazy.js", "gone", "/_denext/lib.js", ""]]);
});

Deno.test("link check: Chrome's own message is surfaced with the importer and starts the walk there", async () => {
  const { store, fire, tick } = setup({
    modules: {
      [at("entry.js")]: { body: `export {};\n` },
      [at("page.js")]: { body: `import { missing } from "/_denext/lib.js";\n` },
      [at("lib.js")]: { body: `export const missng = 1;\n` },
    },
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  const err = new SyntaxError(
    "The requested module '/_denext/lib.js' does not provide an export named 'missing'",
  );
  fire("error", { error: err, message: err.message, filename: at("page.js") });
  assertEquals(store.linkError.importer, at("page.js"));
  assertEquals(store.linkError.target, at("lib.js"));
  const said = store.entries.find((e: Any) => e.message.includes("the browser reports"));
  assertEquals(
    said.message,
    `boot diagnosis: the browser reports that ${at("page.js")} imports "missing" from ${
      at("lib.js")
    }, ` +
      `which does not export it`,
  );
  tick();
  const d = await store.diagnose();
  assertEquals(d.named, at("page.js"));
  assertEquals(d.failures.map((f: Any) => [f.from, f.missing, f.hint]), [[
    at("page.js"),
    "missing",
    "missng",
  ]]);
});

Deno.test("link check: a link error without an importer is placed on the walked edge", async () => {
  const { store, fire, tick } = setup({
    modules: {
      [at("entry.js")]: { body: `import { thing } from "./lib.js";\n` },
      // The browser knows better than the analysis here (lib.js is skipped: CJS-looking).
      [at("lib.js")]: { body: `module.exports = {};\n` },
    },
    scripts: [fakeScript({ type: "module", src: "/_denext/entry.js" })],
  });
  fire("unhandledrejection", {
    reason: new SyntaxError(
      "The requested module './lib.js' does not provide an export named 'thing'",
    ),
  });
  assertEquals(store.linkError.importer, "");
  tick();
  await store.diagnose();
  assertEquals(store.linkError.importer, at("entry.js"));
  const lines = store.entries.filter((e: Any) => e.message.includes("the browser reports"));
  assertEquals(lines.length, 2);
  assertEquals(
    lines[1].message,
    `boot diagnosis: the browser reports that ${at("entry.js")} imports "thing" from ${
      at("lib.js")
    }, ` +
      `which does not export it`,
  );
});

// ── The reload loop ──────────────────────────────────────────────────────────────────────────

/** A sessionStorage holding `n` dev-ordered reloads `agoMs` back, plus this load's mark. */
function reloadHistory(n: number, agoMs: number, marked = true): Map<string, string> {
  const now = Date.now();
  const log = Array.from({ length: n }, () => ({ t: now - agoMs, why: "rebuilt" }));
  const session = new Map([["__denextDevReloads", JSON.stringify(log)]]);
  if (marked) session.set("__denextDevReloadMark", "the dev server rebuilt and ordered a reload");
  return session;
}

Deno.test("reload loop: more dev-ordered reloads than the limit in the window is reported", () => {
  const session = reloadHistory(RELOAD_LOOP_LIMIT, 1000);
  const { store } = setup({ session });
  assertEquals(store.reloadLoop.count, RELOAD_LOOP_LIMIT + 1);
  const warn = store.entries.find((e: Any) => e.source === "reload-loop");
  assertEquals(warn.level, "warn");
  assertStringIncludes(warn.message, `${RELOAD_LOOP_LIMIT + 1} times`);
  assertStringIncludes(warn.message, "the dev server rebuilt and ordered a reload");
  assertEquals(session.has("__denextDevReloadMark"), false, "the mark is consumed");
});

Deno.test("reload loop: at the limit, outside the window or unmarked, nothing is reported", () => {
  for (
    const session of [
      reloadHistory(RELOAD_LOOP_LIMIT - 1, 1000), // this load makes it exactly the limit
      reloadHistory(RELOAD_LOOP_LIMIT + 5, RELOAD_LOOP_WINDOW_MS + 1000), // old reloads
      reloadHistory(RELOAD_LOOP_LIMIT + 5, 1000, false), // a load the dev server didn't order
    ]
  ) {
    const { store } = setup({ session });
    assertEquals(store.reloadLoop, null);
    assertEquals(store.entries.filter((e: Any) => e.source === "reload-loop"), []);
  }
});

Deno.test("reload loop: markReload records the mark the next load counts", () => {
  const session = new Map<string, string>();
  const { store } = setup({ session });
  store.markReload("why");
  assertEquals(session.get("__denextDevReloadMark"), "why");
});

Deno.test("both dev-reload scripts mark the reloads the dev server orders", () => {
  for (const script of [DEV_RELOAD_SCRIPT, SPA_DEV_RELOAD]) {
    assertStringIncludes(script, ".markReload(");
    assertStringIncludes(script, '"the dev server rebuilt and ordered a reload"');
  }
});
