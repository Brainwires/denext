// The on-demand class-component runtime: the server marks a render that produced a class
// component, the document carries the `#__denext_classes` marker, and the generated browser
// entry loads `denext/class-runtime` before hydrating when it sees it — so a class that lives
// only in a dependency (never named in the app's own sources) still hydrates in production.
// The build scan is a preload hint (eager import) and `classComponents: false` keeps the
// runtime out entirely.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { flightTailScripts } from "../src/jsx/render-to-flight-stream.ts";
import { Component } from "../src/compat/react.ts";
import { renderDocument } from "../src/server/document.ts";
import {
  CLASS_MARKER_ID,
  classRendered,
  markClassRendered,
  takeClassRendered,
} from "../src/runtime/render-scope.ts";
import {
  appUsesClassComponents,
  generateFlightEntry,
  generateRouteEntry,
} from "../src/build/bundle.ts";
import { type BoundaryManifest, isFrameworkSource } from "../src/build/module-graph.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

class Hello extends Component<{ who: string }> {
  override render() {
    return h("b", null, `hi ${this.props.who}`);
  }
}
function Fn() {
  return h("i", null, "fn");
}

const MARKER = `id="${CLASS_MARKER_ID}"`;

// ---- the server-side marker ------------------------------------------------------------

Deno.test("renderToString marks a render that produced a class component (and only that)", async () => {
  takeClassRendered(); // start clean (the out-of-request scope is process-wide)
  await renderToString(h("div", null, h(Fn, null)));
  assertEquals(takeClassRendered(), false, "a function-only render leaves no mark");
  await renderToString(h("div", null, h(Hello as never, { who: "x" })));
  assertEquals(classRendered(), true, "peek sees the mark");
  assertEquals(takeClassRendered(), true, "take returns it…");
  assertEquals(takeClassRendered(), false, "…and resets it for the next render");
});

Deno.test("the Flight renderer marks a class rendered inside a server tree", async () => {
  takeClassRendered();
  const { html } = await renderToHtmlFlight(h("main", null, h(Hello as never, { who: "flight" })));
  assertStringIncludes(html, "hi flight");
  assertEquals(takeClassRendered(), true);
});

// ---- the document marker --------------------------------------------------------------

function doc(): string {
  return renderDocument({
    bodyHtml: "<p>x</p>",
    metadata: {},
    hydration: { params: {}, searchParams: "", pathname: "/" },
    clientEntry: "/_denext/client/e.js",
  });
}

Deno.test("a hydrating document carries #__denext_classes only after a class rendered", () => {
  takeClassRendered();
  assert(!doc().includes(MARKER), "no class → no marker");
  markClassRendered();
  const marked = doc();
  assertStringIncludes(
    marked,
    `<script id="${CLASS_MARKER_ID}" type="application/json">1</script>`,
  );
  // Emitted BEFORE the client entry script, so the entry can probe for it synchronously.
  assert(marked.indexOf(MARKER) < marked.indexOf('<script type="module"'));
  assert(!doc().includes(MARKER), "assembling the document consumed the flag");
});

Deno.test("a non-hydrating (0 KB JS) document never carries the marker", () => {
  markClassRendered();
  const out = renderDocument({ bodyHtml: "<p>static</p>", metadata: {} });
  assert(!out.includes(MARKER));
  takeClassRendered(); // the static document did not consume it; reset for later tests
});

Deno.test("the streamed Flight tail carries the marker too", () => {
  takeClassRendered();
  assert(!flightTailScripts({ flight: null }).includes(MARKER));
  markClassRendered();
  assertStringIncludes(flightTailScripts({ flight: null }), MARKER);
  assertEquals(classRendered(), false, "the tail consumed the flag");
});

// ---- the generated entries -------------------------------------------------------------

function emptyBoundary(): BoundaryManifest {
  return { client: new Map(), server: new Map() } as unknown as BoundaryManifest;
}

const route: PageRoute = {
  kind: "page",
  pattern: parsePattern(""),
  routePath: "/",
  filePath: "/proj/app/page.tsx",
  layoutChain: ["/proj/app/layout.tsx"],
  loading: null,
  error: null,
  notFound: null,
  forbidden: null,
  unauthorized: null,
  templateChain: [],
};

const LAZY_BOOT = 'document.getElementById("__denext_classes")';
const LAZY_IMPORT = "await loadClassRuntime()";
const EAGER_IMPORT = 'import { installClassSupport } from "denext/class-runtime"';

Deno.test("Flight entry: lazy (default) probes the marker and awaits the chunk before hydrating", () => {
  const src = generateFlightEntry(emptyBoundary());
  assertStringIncludes(src, LAZY_BOOT);
  assertStringIncludes(src, LAZY_IMPORT);
  assertStringIncludes(src, 'import { loadClassRuntime } from "denext/client-runtime"');
  assert(!src.includes(EAGER_IMPORT), "no static import in lazy mode");
  assert(!/^installClassSupport\(\);$/m.test(src), "no top-level install in lazy mode");
  // The awaited load precedes the island loading + hydration inside the async main().
  assert(src.indexOf(LAZY_IMPORT) < src.indexOf("await registry.ensure(flight)"));
  assert(src.indexOf(LAZY_IMPORT) < src.indexOf("startClient(el, tree)"));
});

Deno.test("Flight entry: eager imports the chunk statically; off emits nothing", () => {
  const eager = generateFlightEntry(emptyBoundary(), false, false, true, null, "eager");
  assertStringIncludes(eager, EAGER_IMPORT);
  assertStringIncludes(eager, "installClassSupport();");
  assert(!eager.includes(LAZY_BOOT), "eager needs no marker probe");
  const off = generateFlightEntry(emptyBoundary(), false, false, true, null, "off");
  assert(!off.includes("class-runtime") && !off.includes("loadClassRuntime"));
  assert(!off.includes(LAZY_BOOT));
});

Deno.test("route entry: lazy makes main() async and loads the chunk before startClient", () => {
  const src = generateRouteEntry(route);
  assertStringIncludes(src, "async function main()");
  assertStringIncludes(src, LAZY_BOOT);
  assert(src.indexOf(LAZY_IMPORT) < src.indexOf("startClient(el, tree)"));
  assert(!src.includes(EAGER_IMPORT));
  const eager = generateRouteEntry(route, false, false, null, "eager");
  assertStringIncludes(eager, EAGER_IMPORT);
  assert(!eager.includes(LAZY_BOOT));
  const off = generateRouteEntry(route, false, false, null, "off");
  assert(!off.includes("class-runtime") && !off.includes("loadClassRuntime"));
});

// ---- the build scan as a preload hint ----------------------------------------------------

Deno.test("the sibling-package crawl never hands the framework's own sources to the scans", () => {
  const fw = new URL("../", import.meta.url).pathname; // this checkout's framework root
  assertEquals(isFrameworkSource(fw + "src/compat/react.ts"), true);
  assertEquals(isFrameworkSource(fw + "packages/pages-router/mod.ts"), true);
  assertEquals(isFrameworkSource(fw + "mod.ts"), true);
  assertEquals(isFrameworkSource(fw + "examples/hello/app/page.tsx"), false, "an in-repo app");
  assertEquals(isFrameworkSource(fw + "examples/shared/ui.tsx"), false, "a sibling package");
  assertEquals(isFrameworkSource("/somewhere/else/ui.tsx"), false);
});

Deno.test("appUsesClassComponents reads sibling-package modules passed as extraFiles", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_class_scan_" });
  try {
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(
      join(dir, "app", "page.tsx"),
      `import { Widget } from "@acme/ui";\nexport default function Page() { return <Widget />; }\n`,
    );
    const sibling = join(dir, "..", `denext_class_scan_sibling_${crypto.randomUUID()}.tsx`);
    await Deno.writeTextFile(
      sibling,
      `import { Component } from "react";\nexport class Widget extends Component { render() { return null; } }\n`,
    );
    try {
      assertEquals(await appUsesClassComponents(dir), false, "the app's own sources name no class");
      assertEquals(await appUsesClassComponents(dir, [sibling]), true, "…but the sibling does");
    } finally {
      await Deno.remove(sibling);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
