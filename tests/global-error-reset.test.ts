// `resetGlobalError` — the hydrated global-error page's `reset()`. Next-style soft recovery:
// re-fetch the current route and swap the document in place (no browser reload); fall back to a
// hard reload when the environment can't (offline, no DOMParser) or the fetch fails.
//
// navigation.ts is browser-only, so these drive the browser branch by stubbing
// `globalThis.location` / `document` / `fetch` / `DOMParser` and restoring them in a `finally`.

import { assert, assertEquals } from "@std/assert";
import { resetGlobalError } from "../src/client/navigation.ts";

// deno-lint-ignore no-explicit-any
type AnyGlobal = any;

interface FakeScript {
  type: string | null;
  src: string | null;
  attrs: Array<{ name: string; value: string }>;
  replacedWith?: FakeScript;
}

function scriptEl(type: string | null, src: string | null): FakeScript & Record<string, unknown> {
  const attrs = [
    ...(type ? [{ name: "type", value: type }] : []),
    ...(src ? [{ name: "src", value: src }] : []),
  ];
  return {
    type,
    src,
    attrs,
    getAttribute(n: string) {
      return n === "type" ? type : n === "src" ? src : null;
    },
    get attributes() {
      return attrs;
    },
    setAttribute(n: string, v: string) {
      if (n === "src") (this as FakeScript).src = v;
      if (n === "type") (this as FakeScript).type = v;
    },
    textContent: "",
    replaceWith(next: FakeScript) {
      (this as FakeScript).replacedWith = next;
    },
  };
}

/** Stub browser globals, run `fn`, and restore. Returns whether `location.reload` was called. */
async function withBrowser(
  opts: {
    fetchImpl?: typeof fetch | undefined;
    domParser?: boolean;
    scripts?: Array<FakeScript & Record<string, unknown>>;
  },
  fn: (state: { reloaded: () => boolean; created: FakeScript[] }) => Promise<void>,
): Promise<void> {
  const g = globalThis as AnyGlobal;
  const saved = {
    location: g.location,
    document: g.document,
    fetch: g.fetch,
    DOMParser: g.DOMParser,
  };
  let reloaded = false;
  const created: FakeScript[] = [];
  try {
    g.location = { href: "https://app.test/dash", reload: () => (reloaded = true) };
    g.fetch = opts.fetchImpl;
    const scripts = opts.scripts ?? [];
    g.document = {
      documentElement: { tag: "old-html" },
      title: "",
      adoptNode: (n: unknown) => n,
      replaceChild: () => undefined,
      querySelectorAll: () => scripts,
      createElement: () => {
        const s = scriptEl(null, null);
        created.push(s);
        return s;
      },
    };
    if (opts.domParser) {
      g.DOMParser = class {
        parseFromString(_html: string, _type: string) {
          return {
            documentElement: { tag: "new-html" },
            title: "Recovered",
            querySelectorAll: () => scripts,
          };
        }
      };
    } else {
      delete g.DOMParser;
    }
    await fn({ reloaded: () => reloaded, created });
  } finally {
    g.location = saved.location;
    g.document = saved.document;
    g.fetch = saved.fetch;
    if (saved.DOMParser === undefined) delete g.DOMParser;
    else g.DOMParser = saved.DOMParser;
  }
}

Deno.test("resetGlobalError: falls back to a reload when DOMParser is unavailable", async () => {
  await withBrowser({
    fetchImpl: (() => Promise.resolve(new Response("<html></html>"))) as typeof fetch,
    domParser: false,
  }, async (s) => {
    await resetGlobalError();
    assertEquals(s.reloaded(), true);
  });
});

Deno.test("resetGlobalError: reloads when the fetch fails", async () => {
  await withBrowser({
    fetchImpl: (() => Promise.reject(new Error("offline"))) as typeof fetch,
    domParser: true,
  }, async (s) => {
    await resetGlobalError();
    assertEquals(s.reloaded(), true);
  });
});

Deno.test("resetGlobalError: on success swaps the document and re-runs the module entry (no reload)", async () => {
  const scripts = [
    scriptEl("application/json", null), // a data island — left as-is
    scriptEl("module", "/_denext/client/index.js"), // the app entry — re-executed, cache-busted
  ];
  const fetchImpl = (() =>
    Promise.resolve(
      new Response("<html><body>ok</body></html>", { status: 200 }),
    )) as typeof fetch;
  await withBrowser({ fetchImpl, domParser: true, scripts }, async (s) => {
    await resetGlobalError();
    // No hard reload: the document was swapped in place.
    assertEquals(s.reloaded(), false);
    // The module entry was recreated with a cache-busting `?nav` so the ES module re-evaluates.
    const moduleEntry = s.created.find((c) => (c.src ?? "").includes("index.js"));
    assert(moduleEntry, "the module entry was recreated");
    assert((moduleEntry!.src ?? "").includes("nav="), "its src is cache-busted");
    // The JSON data island was NOT recreated (it does not execute).
    assertEquals(s.created.some((c) => c.type === "application/json"), false);
  });
});
