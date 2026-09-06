import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { createApp } from "../src/server/app.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { matchPage } from "../src/router/match.ts";
import { parsePattern } from "../src/router/segments.ts";
import { ErrorBoundary, notFound } from "../src/runtime/error-boundary.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function onePage(over: Partial<RouteManifest["pages"][number]>): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: "page.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
      ...over,
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("renderToString: error boundary renders fallback on throw (dev shows real message)", async () => {
  const g = globalThis as { __denextDev?: boolean };
  g.__denextDev = true;
  const Boom = (): VNode => {
    throw new Error("kaboom");
  };
  try {
    const html = await renderToString(
      h(ErrorBoundary, {
        fallback: ({ error }: { error: Error }) => h("div", { class: "err" }, error.message),
        children: h(Boom, null),
      }),
    );
    assertEquals(html, '<div class="err">kaboom</div>');
  } finally {
    delete g.__denextDev;
  }
});

Deno.test("server: error.tsx boundary catches a page error (dev shows real message)", async () => {
  const g = globalThis as { __denextDev?: boolean };
  g.__denextDev = true;
  try {
    const manifest = onePage({ error: "error.tsx" });
    const app = createApp({
      getManifest: () => manifest,
      load: (fp) =>
        Promise.resolve(
          fp === "error.tsx"
            ? {
              default: (p: { error: Error }) =>
                h("p", { class: "boom" }, `Error: ${p.error.message}`),
            }
            : {
              default: () => {
                throw new Error("page failed");
              },
            },
        ),
    });
    const res = await app(new Request("http://localhost/"));
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), '<p class="boom">Error: page failed</p>');
  } finally {
    delete g.__denextDev;
  }
});

Deno.test("server: error.tsx boundary redacts the real error in production (H1)", async () => {
  const g = globalThis as { __denextDev?: boolean };
  delete g.__denextDev; // production is the default
  const origError = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => void logged.push(a);
  const SECRET = "connect ECONNREFUSED db-prod:5432 password=hunter2";
  try {
    const manifest = onePage({ error: "error.tsx" });
    const app = createApp({
      getManifest: () => manifest,
      load: (fp) =>
        Promise.resolve(
          fp === "error.tsx"
            ? {
              default: (p: { error: Error & { digest?: string } }) =>
                h(
                  "p",
                  { class: "boom" },
                  `Error: ${p.error.message}${p.error.stack ?? ""}${
                    p.error.digest ? ` (${p.error.digest})` : ""
                  }`,
                ),
            }
            : {
              default: () => {
                throw new Error(SECRET);
              },
            },
        ),
    });
    const res = await app(new Request("http://localhost/"));
    assertEquals(res.status, 200);
    const html = await res.text();
    // The client sees the generic message + a digest, never the thrown secret/stack.
    assert(!html.includes(SECRET), "the internal detail is NOT sent to the client");
    assertStringIncludes(html, "Internal Server Error");
    // The real error is still logged server-side (correlatable by digest).
    assert(
      logged.some((a) =>
        (a as unknown[]).some((x) => x instanceof Error && x.message.includes(SECRET))
      ),
      "the real error is logged server-side",
    );
  } finally {
    console.error = origError;
  }
});

Deno.test("server: an error.tsx boundary catch is reported to onRequestError (M4)", async () => {
  const g = globalThis as { __denextDev?: boolean };
  delete g.__denextDev; // production
  const origError = console.error;
  console.error = () => {}; // silence H1's redaction log
  const reports: Array<{ error: unknown; routeType: string }> = [];
  const SECRET = "boom: internal detail 0xdeadbeef";
  try {
    const manifest = onePage({ error: "error.tsx" });
    const app = createApp({
      getManifest: () => manifest,
      load: (fp) =>
        Promise.resolve(
          fp === "error.tsx" ? { default: () => h("p", null, "Something went wrong") } : {
            default: () => {
              throw new Error(SECRET);
            },
          },
        ),
      onRequestError: (error, _req, ctx) => {
        reports.push({ error, routeType: ctx.routeType });
      },
    });
    const res = await app(new Request("http://localhost/"));
    assertEquals(res.status, 200);
    await res.text();
    // The caught boundary error is surfaced to instrumentation — with the REAL
    // error (not the redacted client copy) and routeType "render".
    assertEquals(reports.length, 1);
    assert(reports[0].error instanceof Error);
    assertEquals((reports[0].error as Error).message, SECRET);
    assertEquals(reports[0].routeType, "render");
  } finally {
    console.error = origError;
  }
});

Deno.test("server: notFound() yields a 404 with the not-found UI", async () => {
  const manifest = onePage({ notFound: "nf.tsx" });
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) =>
      Promise.resolve(
        fp === "nf.tsx"
          ? { default: () => h("h1", null, "Nothing here") }
          : { default: () => notFound() },
      ),
  });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 404);
  assertStringIncludes(await res.text(), "<h1>Nothing here</h1>");
});

Deno.test("server: notFound() without a not-found.tsx uses a default 404 UI", async () => {
  const manifest = onePage({});
  const app = createApp({
    getManifest: () => manifest,
    load: () => Promise.resolve({ default: () => notFound() }),
  });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 404);
  assertStringIncludes(await res.text(), "This page could not be found.");
});

Deno.test("client: ErrorBoundary shows fallback then resets to children", () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  let fail = true;
  function Maybe(): VNode {
    if (fail) throw new Error("boom");
    return h("span", null, "recovered");
  }
  function Fallback(props: { error: Error; reset: () => void }): VNode {
    return h("button", { onClick: props.reset }, `err:${props.error.message}`);
  }

  const root = createRoot(asEl(container));
  root.render(h(ErrorBoundary, { fallback: Fallback, children: h(Maybe, null) }));
  assertEquals(container.innerHTML, "<button>err:boom</button>");

  // Fix the condition and trigger reset via the fallback's button.
  fail = false;
  (container.childNodes[0] as FakeElement).dispatch("click");
  flushSync();
  assertEquals(container.innerHTML, "<span>recovered</span>");
});

Deno.test("scanner captures nearest loading/error/not-found per page", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_sf_" });
  try {
    const files = [
      "layout.tsx",
      "error.tsx",
      "not-found.tsx",
      "page.tsx",
      "dashboard/loading.tsx",
      "dashboard/page.tsx",
    ];
    for (const rel of files) {
      const full = join(dir, rel);
      await Deno.mkdir(join(full, ".."), { recursive: true });
      await Deno.writeTextFile(full, "export default function(){}\n");
    }
    const manifest = await scanRoutes(dir);

    const dash = matchPage(manifest, "/dashboard");
    assertExists(dash);
    // dashboard inherits root error/not-found, has its own loading.
    assertStringIncludes(dash.route.loading ?? "", "dashboard/loading.tsx");
    assertStringIncludes(dash.route.error ?? "", "error.tsx");
    assertStringIncludes(dash.route.notFound ?? "", "not-found.tsx");

    const home = matchPage(manifest, "/");
    assertExists(home);
    assertEquals(home.route.loading, null);
    assertStringIncludes(home.route.error ?? "", "error.tsx");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- per-segment signal boundaries (Next.js not-found.tsx semantics) --------------------

/** Scan an app dir made of the given files (stub sources; the modules come from `mods`). */
async function scannedApp(
  files: string[],
  mods: Record<string, unknown>,
): Promise<{ dir: string; app: ReturnType<typeof createApp> }> {
  const dir = await Deno.makeTempDir({ prefix: "denext_sig_" });
  for (const rel of files) {
    const full = join(dir, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, "export default function(){}\n");
  }
  const manifest = await scanRoutes(dir);
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => {
      // Longest suffix wins ("shop/layout.tsx" over "layout.tsx").
      const key = Object.keys(mods).filter((k) => fp.endsWith("/" + k))
        .sort((a, b) => b.length - a.length)[0];
      return Promise.resolve(key ? mods[key] : undefined);
    },
  });
  return { dir, app };
}

type P = { children?: VNode; params: Promise<Record<string, string>> };

/** The playground's shape: `[s]/layout.tsx` AND `[s]/page.tsx` both call notFound(). */
const SHOP_FILES = [
  "layout.tsx",
  "shop/layout.tsx",
  "shop/not-found.tsx",
  "shop/[s]/layout.tsx",
  "shop/[s]/not-found.tsx",
  "shop/[s]/page.tsx",
  "shop/[s]/[c]/page.tsx",
];
const SHOP_MODS: Record<string, unknown> = {
  "layout.tsx": { default: (p: P) => h("html", null, h("body", null, "root:", p.children)) },
  "shop/layout.tsx": { default: (p: P) => h("section", null, "shop-layout:", p.children) },
  "shop/not-found.tsx": { default: () => h("h1", null, "shop-not-found") },
  "shop/[s]/layout.tsx": {
    default: async (p: P) => {
      if ((await p.params).s === "missing") notFound();
      return h("div", null, "s-layout:", p.children);
    },
  },
  "shop/[s]/not-found.tsx": { default: () => h("h1", null, "s-not-found") },
  "shop/[s]/page.tsx": {
    default: async (p: P) => {
      const { s } = await p.params;
      if (s !== "shoes") notFound();
      return h("p", null, "page:" + s);
    },
  },
  "shop/[s]/[c]/page.tsx": { default: () => notFound() },
};

Deno.test("scanner records each level's own not-found/forbidden/unauthorized files", async () => {
  const { dir, app: _ } = await scannedApp(SHOP_FILES, SHOP_MODS);
  try {
    const manifest = await scanRoutes(dir);
    const match = matchPage(manifest, "/shop/shoes");
    assertExists(match);
    const levels = match.route.levels ?? [];
    assertEquals(levels.map((l) => l.notFound?.split("/").slice(-2).join("/") ?? null), [
      null,
      "shop/not-found.tsx",
      "[s]/not-found.tsx",
    ]);
    assertEquals(levels.map((l) => l.forbidden ?? null), [null, null, null]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signal boundaries: a page's notFound() renders ITS level's not-found inside its layout", async () => {
  const { dir, app } = await scannedApp(SHOP_FILES, SHOP_MODS);
  try {
    const ok = await app(new Request("http://localhost/shop/shoes"));
    assertEquals(ok.status, 200);
    assertStringIncludes(await ok.text(), "root:<section>shop-layout:<div>s-layout:<p>page:shoes");

    const res = await app(new Request("http://localhost/shop/shoes/nope"));
    assertEquals(res.status, 404);
    const html = await res.text();
    assertStringIncludes(html, "s-layout:");
    assertStringIncludes(html, "<h1>s-not-found</h1>");
    assert(!html.includes("shop-not-found"), "the parent's not-found must not render");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signal boundaries: a LAYOUT's notFound() escalates to the parent level (not a 500)", async () => {
  const { dir, app } = await scannedApp(SHOP_FILES, SHOP_MODS);
  try {
    // Both [s]/layout.tsx and [s]/page.tsx throw: Next renders shop/not-found.tsx inside
    // shop/layout.tsx and root layout — the throwing layout and ITS not-found never render.
    const res = await app(new Request("http://localhost/shop/missing"));
    assertEquals(res.status, 404);
    const html = await res.text();
    assertStringIncludes(html, "root:<section>shop-layout:");
    assertStringIncludes(html, "<h1>shop-not-found</h1>");
    assert(!html.includes("s-layout:"), "the throwing layout must not render");
    assert(!html.includes("s-not-found"), "the throwing level's own not-found must not render");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signal boundaries: no not-found file above the throw → built-in 404 inside the root layout only", async () => {
  const files = ["layout.tsx", "a/layout.tsx", "a/page.tsx"];
  const mods: Record<string, unknown> = {
    "layout.tsx": { default: (p: P) => h("html", null, h("body", null, "root:", p.children)) },
    "a/layout.tsx": { default: (p: P) => h("div", null, "a-layout:", p.children) },
    "a/page.tsx": { default: () => notFound() },
  };
  const { dir, app } = await scannedApp(files, mods);
  try {
    const res = await app(new Request("http://localhost/a"));
    assertEquals(res.status, 404);
    const html = await res.text();
    assertStringIncludes(html, "root:");
    assertStringIncludes(html, "This page could not be found.");
    assert(!html.includes("a-layout:"), "nested layouts are not part of the root 404");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signal boundaries: the ROOT layout throwing notFound() renders the bare built-in 404", async () => {
  const files = ["layout.tsx", "not-found.tsx", "page.tsx"];
  const mods: Record<string, unknown> = {
    "layout.tsx": { default: () => notFound() },
    "not-found.tsx": { default: () => h("h1", null, "custom-nf") },
    "page.tsx": { default: () => h("p", null, "home") },
  };
  const { dir, app } = await scannedApp(files, mods);
  try {
    const res = await app(new Request("http://localhost/"));
    assertEquals(res.status, 404);
    const html = await res.text();
    assertStringIncludes(html, "This page could not be found.");
    assert(!html.includes("custom-nf"), "the file sits inside the layout that threw");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signal boundaries: error.tsx still does not catch a notFound() thrown below it", async () => {
  const files = ["layout.tsx", "a/error.tsx", "a/not-found.tsx", "a/page.tsx"];
  const mods: Record<string, unknown> = {
    "layout.tsx": { default: (p: P) => h("html", null, h("body", null, p.children)) },
    "a/error.tsx": { default: () => h("h1", null, "error-ui") },
    "a/not-found.tsx": { default: () => h("h1", null, "a-not-found") },
    "a/page.tsx": { default: () => notFound() },
  };
  const { dir, app } = await scannedApp(files, mods);
  try {
    const res = await app(new Request("http://localhost/a"));
    assertEquals(res.status, 404);
    const html = await res.text();
    assertStringIncludes(html, "<h1>a-not-found</h1>");
    assert(!html.includes("error-ui"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signal boundaries: notFound() inside a streamed hole renders the level's not-found in place", async () => {
  const files = ["layout.tsx", "a/loading.tsx", "a/not-found.tsx", "a/page.tsx"];
  const mods: Record<string, unknown> = {
    "layout.tsx": { default: (p: P) => h("html", null, h("body", null, p.children)) },
    "a/loading.tsx": { default: () => h("p", null, "loading…") },
    "a/not-found.tsx": { default: () => h("h1", null, "a-not-found") },
    "a/page.tsx": {
      default: async () => {
        await new Promise((r) => setTimeout(r, 5));
        notFound();
      },
    },
  };
  const { dir, app } = await scannedApp(files, mods);
  try {
    const res = await app(new Request("http://localhost/a"));
    const html = await res.text();
    assertStringIncludes(html, "a-not-found");
    assert(!html.includes("Internal Server Error"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("client: a Flight boundary node catches an island's render throw with the client error.tsx", async () => {
  const { parseFlight } = await import("../src/client/flight-client.ts");
  const { useState } = await import("../src/runtime/hooks.ts");
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));

  // The playground's BuggyButton: a client island that throws on its own re-render.
  function Buggy(): VNode {
    const [clicked, setClicked] = useState(false);
    if (clicked) throw new Error("Oh no");
    return h("button", { onClick: () => setClicked(true) }, "trigger");
  }
  function ErrTsx(props: { error: Error; reset: () => void }): VNode {
    return h("i", { onClick: props.reset }, `error.tsx:${props.error.message}`);
  }
  const registry = new Map([["c_err#ErrTsx", ErrTsx], ["c_buggy#Buggy", Buggy]]);
  const flight = { $: "b", f: "c_err#ErrTsx", c: [{ $: "c", i: "c_buggy#Buggy", p: {}, c: [] }] };
  const root = createRoot(asEl(container));
  root.render(parseFlight(flight as never, registry as never) as VNode);
  flushSync();
  assertEquals(container.innerHTML, "<button>trigger</button>");

  // The island throws during its client re-render: the boundary swaps in error.tsx.
  (container.childNodes[0] as FakeElement).dispatch("click");
  flushSync();
  assertEquals(container.innerHTML, "<i>error.tsx:Oh no</i>");

  // reset() remounts the children (fresh state → no throw).
  (container.childNodes[0] as FakeElement).dispatch("click");
  flushSync();
  assertEquals(container.innerHTML, "<button>trigger</button>");
});
