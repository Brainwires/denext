import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
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
      ...over,
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
  };
}

Deno.test("renderToString: error boundary renders fallback on throw", async () => {
  function Boom(): VNode {
    throw new Error("kaboom");
  }
  const html = await renderToString(
    h(ErrorBoundary, {
      fallback: ({ error }: { error: Error }) => h("div", { class: "err" }, error.message),
      children: h(Boom, null),
    }),
  );
  assertEquals(html, '<div class="err">kaboom</div>');
});

Deno.test("server: error.tsx boundary catches a page error", async () => {
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
