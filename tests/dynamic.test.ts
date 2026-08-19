import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { dynamic } from "../src/runtime/dynamic.ts";
import { bundleRoute } from "../src/build/bundle.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

function Loaded() {
  return h("span", { id: "real" }, "loaded-content");
}
function Spin() {
  return h("p", { id: "spin" }, "loading…");
}

Deno.test("dynamic() SSRs the resolved component (ssr:true)", async () => {
  const Lazy = dynamic(() => Promise.resolve({ default: Loaded }));
  const html = await renderToString(h(Lazy, {}));
  assertStringIncludes(html, "loaded-content");
});

Deno.test("dynamic({ ssr:false }) renders the loading fallback on the server", async () => {
  const Lazy = dynamic(() => Promise.resolve({ default: Loaded }), {
    ssr: false,
    loading: Spin,
  });
  const html = await renderToString(h(Lazy, {}));
  assertStringIncludes(html, "loading…");
  assert(!html.includes("loaded-content"), "ssr:false must not server-render the component");
});

Deno.test("dynamic() accepts a loader returning the component directly", async () => {
  const Lazy = dynamic(() => Promise.resolve(Loaded));
  const html = await renderToString(h(Lazy, {}));
  assertStringIncludes(html, "loaded-content");
});

Deno.test("a route using dynamic() emits a separate code-split chunk", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dyn_" });
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
        imports: {
          "denext": new URL("../mod.ts", import.meta.url).href,
          "denext/jsx-runtime": new URL("../src/jsx/jsx-runtime.ts", import.meta.url).href,
          "denext/client": new URL("../src/client/mod.ts", import.meta.url).href,
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "heavy.tsx"),
      `export default function Heavy() { return <div>HEAVY_MARKER_XYZ</div>; }\n`,
    );
    const pagePath = join(dir, "page.tsx");
    await Deno.writeTextFile(
      pagePath,
      `import { dynamic } from "denext";\n` +
        `const Heavy = dynamic(() => import("./heavy.tsx"));\n` +
        `export default function Page() { return <Heavy />; }\n`,
    );

    const route: PageRoute = {
      kind: "page",
      pattern: parsePattern(""),
      routePath: "/",
      filePath: pagePath,
      layoutChain: [],
      templateChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
    };
    const output = await bundleRoute(route, { configPath: join(dir, "deno.json") });

    // More than one file → the dynamic import became its own chunk.
    assert(output.files.size > 1, `expected a split chunk, got ${output.files.size} file(s)`);
    // The heavy component's code lives in a chunk, not the entry.
    const entry = output.files.get(output.entry)!;
    assert(!entry.includes("HEAVY_MARKER_XYZ"), "heavy code must not be in the entry");
    const chunks = [...output.files.entries()].filter(([n]) => n !== output.entry);
    assert(
      chunks.some(([, code]) => code.includes("HEAVY_MARKER_XYZ")),
      "heavy code should be in a split chunk",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// React.lazy (distinct from dynamic): suspends to the NEAREST <Suspense fallback>
// rather than wrapping its own boundary, matching React.
Deno.test("lazy() suspends to the nearest ancestor <Suspense fallback>", async () => {
  const { lazy } = await import("../src/runtime/dynamic.ts");
  const { Suspense } = await import("../src/runtime/suspense.ts");
  const Lazy = lazy(() => Promise.resolve({ default: Loaded }));
  // The surrounding Suspense's fallback is what shows during load (and the
  // resolved content once ready) — lazy adds no boundary of its own.
  const html = await renderToString(
    h(Suspense, { fallback: h(Spin, {}), children: h(Lazy, {}) }),
  );
  assertStringIncludes(html, "loaded-content");
});

Deno.test("lazy() has no internal boundary: the suspension propagates upward", async () => {
  const { lazy } = await import("../src/runtime/dynamic.ts");
  const { isThenable } = await import("../src/runtime/suspense.ts");
  const Lazy = lazy(() => Promise.resolve({ default: Loaded }));
  // With NO wrapping <Suspense>, the suspension escapes to the top (thrown
  // thenable) instead of being swallowed by an internal boundary — proving lazy
  // adds none of its own. (dynamic() would instead render its own fallback here.)
  let thrown: unknown;
  try {
    await renderToString(h("div", null, h(Lazy, {})));
  } catch (e) {
    thrown = e;
  }
  assert(isThenable(thrown), "the Suspense signal propagated (no internal boundary)");
});
