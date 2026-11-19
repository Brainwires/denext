// A soft navigation re-runs the incoming route's client entry. An entry registers its `main` by
// its own URL when it evaluates (bundle.ts's ENTRY_REGISTRATION), so a route this document has
// already evaluated is re-run by calling `main` again — no `<script>`, no fetch — and a route
// seen for the first time is loaded by its plain URL (the HTTP cache keeps it), never under a
// per-navigation `?nav=` stamp. The stamp stays for dev (the entry is rebuilt in place) and for an
// entry that registers nothing and was already loaded.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { generateFlightEntry, generateRouteEntry } from "../src/build/bundle.ts";
import type { BoundaryManifest } from "../src/build/module-graph.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import { injectRouteEntry } from "../src/client/nav-document.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const REGISTRATION = "(globalThis.__dnxEntries ??= {})[import.meta.url] = main;";

/** A fake script element: records its `src` and fires its listeners on demand. */
class FakeScript {
  type = "";
  src = "";
  removed = false;
  #on = new Map<string, () => void>();
  addEventListener(type: string, fn: () => void): void {
    this.#on.set(type, fn);
  }
  dispatch(type: string): void {
    this.#on.get(type)?.();
  }
  remove(): void {
    this.removed = true;
  }
}

/** Install a document that records every injected script; the page's own scripts are `own`. */
function installDocument(own: string[] = []): { injected: FakeScript[]; restore: () => void } {
  const g = globalThis as Any;
  const saved = { doc: g.document, entries: g.__dnxEntries, dev: g.__denextDev };
  const injected: FakeScript[] = [];
  g.document = {
    createElement: () => new FakeScript(),
    body: { appendChild: (s: FakeScript) => injected.push(s) },
    querySelectorAll: () => own.map((src) => ({ src })),
  };
  delete g.__dnxEntries;
  delete g.__denextDev;
  return {
    injected,
    restore: () => {
      g.document = saved.doc;
      g.__dnxEntries = saved.entries;
      g.__denextDev = saved.dev;
    },
  };
}

/** What a generated entry does when it evaluates: register its `main` by its URL. */
function evaluate(href: string, main: () => unknown): void {
  const g = globalThis as Any;
  (g.__dnxEntries ??= {})[href] = main;
}

const PAGE = new URL("http://site.test/a/");

Deno.test("generated route and Flight entries register their main by their own URL", () => {
  const route: PageRoute = {
    kind: "page",
    pattern: parsePattern(""),
    routePath: "/",
    filePath: "/proj/app/page.tsx",
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  const entry = generateRouteEntry(route);
  assertStringIncludes(entry, REGISTRATION);
  assert(entry.indexOf(REGISTRATION) < entry.lastIndexOf("main();"), "registered before it runs");
  const flight = generateFlightEntry(
    { client: new Map(), server: new Map() } as unknown as BoundaryManifest,
  );
  assertStringIncludes(flight, REGISTRATION);
  assertStringIncludes(flight, "export const ready = main();");
});

Deno.test("navigation between visited routes fetches no entry module", async () => {
  const { injected, restore } = installDocument(["http://site.test/_denext/client/a.js"]);
  try {
    const runs: string[] = [];
    // The first page's entry evaluated on load.
    evaluate("http://site.test/_denext/client/a.js", () => runs.push("a"));
    // A → B, B never loaded: injected once, by its plain URL.
    const first = injectRouteEntry("/_denext/client/b.js", PAGE);
    assertEquals(injected.length, 1);
    assertEquals(injected[0].src, "http://site.test/_denext/client/b.js", "no ?nav= stamp");
    evaluate("http://site.test/_denext/client/b.js", () => runs.push("b"));
    injected[0].dispatch("load");
    await first;
    assert(injected[0].removed, "the injected script removes itself");
    // B → A → B → A: every entry is re-run in place, nothing is injected or fetched.
    for (const name of ["a", "b", "a"]) {
      await injectRouteEntry(`/_denext/client/${name}.js`, PAGE);
    }
    assertEquals(injected.length, 1, "no further entry request");
    assertEquals(runs, ["a", "b", "a"]);
  } finally {
    restore();
  }
});

Deno.test("a re-run waits for the entry's async main (the reconcile lands in the transition)", async () => {
  const { injected, restore } = installDocument();
  try {
    let done = false;
    evaluate("http://site.test/x.js", async () => {
      await Promise.resolve();
      await Promise.resolve();
      done = true;
    });
    await injectRouteEntry("/x.js", PAGE);
    assert(done, "resolved only after main settled");
    assertEquals(injected.length, 0);
  } finally {
    restore();
  }
});

Deno.test("a re-run main that throws is reported, and the navigation still settles", async () => {
  const { restore } = installDocument();
  const saveError = console.error;
  const errors: unknown[] = [];
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    evaluate("http://site.test/x.js", () => {
      throw new Error("boom");
    });
    await injectRouteEntry("/x.js", PAGE);
    assertEquals(errors.length, 1);
  } finally {
    console.error = saveError;
    restore();
  }
});

Deno.test("a re-run main that never settles is cut off by the 4 s safety timeout", async () => {
  const { restore } = installDocument();
  const g = globalThis as Any;
  const saveSetTimeout = g.setTimeout;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  g.setTimeout = (fn: () => void, ms: number) => (timers.push({ fn, ms }), 0);
  try {
    evaluate("http://site.test/x.js", () => new Promise(() => {}));
    const nav = injectRouteEntry("/x.js", PAGE);
    assertEquals(timers.map((t) => t.ms), [4000]);
    timers[0].fn();
    await nav; // settles without main ever resolving
  } finally {
    g.setTimeout = saveSetTimeout;
    restore();
  }
});

Deno.test("dev re-imports the entry under a ?nav= stamp even when it registered (rebuilt in place)", async () => {
  const { injected, restore } = installDocument();
  try {
    (globalThis as Any).__denextDev = true;
    let ran = 0;
    evaluate("http://site.test/x.js", () => ran++);
    const nav = injectRouteEntry("/x.js", PAGE);
    assertEquals(ran, 0, "the stale module's main is not called");
    assertEquals(injected.length, 1);
    assertStringIncludes(injected[0].src, "http://site.test/x.js?nav=");
    injected[0].dispatch("load");
    await nav;
  } finally {
    restore();
  }
});

Deno.test("an entry that registers nothing is stamped once it was loaded (by a nav or the page)", async () => {
  const { injected, restore } = installDocument(["http://site.test/boot.js"]);
  try {
    // A first injection is plain; the module evaluated but registered no main.
    const first = injectRouteEntry("/plugin.js", PAGE);
    injected[0].dispatch("load");
    await first;
    assertEquals(injected[0].src, "http://site.test/plugin.js");
    // The second one must re-evaluate it, so it takes a fresh URL.
    const second = injectRouteEntry("/plugin.js", PAGE);
    assertStringIncludes(injected[1].src, "http://site.test/plugin.js?nav=");
    injected[1].dispatch("error");
    await second;
    // The page's own module script (the Flight boot) was evaluated by the page: stamped too.
    const third = injectRouteEntry("/boot.js", PAGE);
    assertStringIncludes(injected[2].src, "http://site.test/boot.js?nav=");
    injected[2].dispatch("load");
    await third;
  } finally {
    restore();
  }
});
