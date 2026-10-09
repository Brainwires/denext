// Unbundled dev loop, pure helpers: compat specifier → dev URL mapping, and HMR accept-
// boundary propagation over the reverse import graph.

import { assert, assertEquals } from "@std/assert";
import {
  addImporter,
  createUnbundledState,
  DEP_PREFIX,
  depSlug,
  EMPTY_MODULE,
  FS_PREFIX,
  NPM_PREFIX,
  type TransformEntry,
  type UnbundledState,
} from "../src/build/dev-unbundled/state.ts";
import { compatDepUrl, rewriteSpecifier } from "../src/build/dev-unbundled/resolve.ts";
import { onChange, propagate } from "../src/build/dev-unbundled/hmr.ts";
import { NEXT_ALIASES, REACT_ALIASES } from "../src/build/next-compat.ts";
import { cjsExternalWrapper, serverOnlyStub } from "../src/build/dev-unbundled/deps.ts";

function state(compat: boolean): UnbundledState {
  return createUnbundledState({
    projectDir: "/proj",
    appDir: "/proj/app",
    configPath: "/proj/deno.json",
    outDir: "/proj/out",
    compat,
  });
}

Deno.test("compatDepUrl maps react/next/denext to the runtime, npm to the dep bundle", () => {
  const st = state(true);
  assertEquals(compatDepUrl(st, "react"), `${DEP_PREFIX}${REACT_ALIASES["react"] ?? "react.js"}`);
  assert(compatDepUrl(st, "react-dom/client")!.startsWith(DEP_PREFIX));
  assertEquals(compatDepUrl(st, "react-is"), `${DEP_PREFIX}react-is.js`);
  // React-Compiler-precompiled npm code, and the codemod's rewrite of it: the shared runtime.
  assertEquals(
    compatDepUrl(st, "react/compiler-runtime"),
    `${DEP_PREFIX}react-compiler-runtime.js`,
  );
  assertEquals(compatDepUrl(st, "denext/compiler-runtime"), `${DEP_PREFIX}compiler-runtime.js`);
  assertEquals(compatDepUrl(st, "next/link"), `${DEP_PREFIX}${NEXT_ALIASES["next/link"]}`);
  assertEquals(compatDepUrl(st, "next/not-a-module"), null, "unmapped next/* is left alone");
  assertEquals(
    compatDepUrl(st, "denext"),
    `${DEP_PREFIX}denext.js`,
    "the root barrel, not the react shim",
  );
  assertEquals(compatDepUrl(st, "denext/react"), `${DEP_PREFIX}react.js`);
  assertEquals(compatDepUrl(st, "node:fs"), null);
  assertEquals(compatDepUrl(st, "https://esm.sh/x"), null);
  assertEquals(compatDepUrl(st, "lodash-es"), `${NPM_PREFIX}${depSlug("lodash-es")}.js`);
  assert(st.npmSpecs.has("lodash-es"), "an npm specifier is noted for the on-demand bundle");
});

// Audit 3.4.0 N4: `specAliases` is a plain object, so an own-key lookup must not reach
// `Object.prototype` — a bare specifier named `constructor` or `toString` is an npm package.
Deno.test("compatDepUrl: a specifier named like an Object.prototype key is not aliased", () => {
  const st = createUnbundledState({
    projectDir: "/proj",
    appDir: "/proj/app",
    configPath: "/proj/deno.json",
    outDir: "/proj/out",
    compat: true,
    specAliases: { "@legendapp/list/react": "legend-list-dom.js" },
  });
  for (const spec of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assertEquals(compatDepUrl(st, spec), `${NPM_PREFIX}${depSlug(spec)}.js`, spec);
  }
});

Deno.test("rewriteSpecifier sends a first-party stylesheet to the empty shim, not the JS transform", () => {
  const st = state(false);
  const e: TransformEntry = { mtimeMs: 0, code: "", deps: [], selfAccepting: false };
  assertEquals(rewriteSpecifier(st, "./styles.css", "/proj/src/styles.css", e), EMPTY_MODULE);
  assertEquals(
    rewriteSpecifier(st, "./a.module.scss?x", "/proj/src/a.module.scss", e),
    EMPTY_MODULE,
  );
  assertEquals(e.deps.length, 0, "no graph edge for a stylesheet");
  assert(rewriteSpecifier(st, "./app.tsx", "/proj/src/app.tsx", e).startsWith(FS_PREFIX));
});

/** entry → A (self-accepting) → B → C; B also imports D (a leaf that self-accepts). */
function graph(): UnbundledState {
  const st = state(false);
  for (const m of ["/proj/app/A.tsx", "/proj/app/B.tsx", "/proj/app/C.tsx", "/proj/app/D.tsx"]) {
    st.known.add(m);
  }
  addImporter(st, "/proj/app/A.tsx", "entry:/");
  addImporter(st, "/proj/app/B.tsx", "/proj/app/A.tsx");
  addImporter(st, "/proj/app/C.tsx", "/proj/app/B.tsx");
  addImporter(st, "/proj/app/D.tsx", "/proj/app/B.tsx");
  st.accepting.add("/proj/app/A.tsx");
  st.accepting.add("/proj/app/D.tsx");
  return st;
}

Deno.test("propagate finds the nearest self-accepting importers, or null for a reload", () => {
  const st = graph();
  assertEquals([...propagate(st, "/proj/app/C.tsx", new Set())!], ["/proj/app/A.tsx"]);
  assertEquals([...propagate(st, "/proj/app/D.tsx", new Set())!], ["/proj/app/D.tsx"]);
  st.accepting.delete("/proj/app/A.tsx");
  assertEquals(propagate(st, "/proj/app/B.tsx", new Set()), null, "reaches the entry → reload");
  // A module the client graph never imported.
  assertEquals(propagate(st, "/proj/app/zzz.tsx", new Set()), null);
  // A cycle terminates (C ↔ B) and a dead end (no importers) is a reload.
  addImporter(st, "/proj/app/B.tsx", "/proj/app/C.tsx");
  assertEquals(propagate(st, "/proj/app/C.tsx", new Set()), null);
  st.importers.delete("/proj/app/D.tsx");
  st.accepting.delete("/proj/app/D.tsx");
  assertEquals(propagate(st, "/proj/app/D.tsx", new Set()), null);
});

Deno.test("onChange: boundary updates, a structural reload, and an unknown-only batch", () => {
  const st = graph();
  const swap = onChange(st, ["/proj/app/C.tsx"]);
  assertEquals(swap.reload, false);
  assertEquals(swap.unknownOnly, false);
  assertEquals(swap.updates.length, 1);
  assert(swap.updates[0].startsWith(`${FS_PREFIX}/proj/app/A.tsx?t=`), swap.updates[0]);
  assert(/&v=\d+$/.test(swap.updates[0]), "carries the boundary's baked version");
  st.accepting.delete("/proj/app/A.tsx");
  assertEquals(onChange(st, ["/proj/app/B.tsx"]).reload, true);
  assertEquals(onChange(st, ["/proj/app/nope.tsx"]).unknownOnly, true);
});

Deno.test("unbundled @dep inventory: every denext specifier the client can import is pre-bundled", async () => {
  const { DENEXT_RUNTIME_FILE, DEP_ENTRYPOINTS, depSlug } = await import(
    "../src/build/dev-unbundled/state.ts"
  );
  // The native @dep set and the compat runtime-file map describe the same specifiers; a
  // subpath present in one but not the other 404s in that dev mode. `denext/class-runtime`
  // (loaded on demand by class-loader.ts) was missing from both — the unbundled dev pages
  // never hydrated, silently (a failed module fetch is not a console error).
  for (const spec of Object.keys(DENEXT_RUNTIME_FILE)) {
    const slug = depSlug(spec === "denext/jsx-dev-runtime" ? "denext/jsx-runtime" : spec);
    assert(slug in DEP_ENTRYPOINTS, `${spec} has no native @dep entry (${slug})`);
  }
  assertEquals(DEP_ENTRYPOINTS["denext_class-runtime"], "src/class-runtime.ts");
  assertEquals(DENEXT_RUNTIME_FILE["denext/class-runtime"], "class-runtime.js");
  // `denext/feature`: the fold leaves the import in place, so a "use client" module that
  // calls `feature()` imports it at runtime — it 404'd in unbundled dev the same silent way.
  assertEquals(DEP_ENTRYPOINTS["denext_feature"], "src/feature.ts");
  assertEquals(DENEXT_RUNTIME_FILE["denext/feature"], "feature.js");
  // The compat dev loop serves each runtime file from the prebuilt runtime graph: every file
  // named here must be one of its entry points, or the URL is a 404 in compat dev too.
  const { runtimeEntryPoints } = await import("../src/build/next-compat.ts");
  const prebuilt = runtimeEntryPoints(new URL("../", import.meta.url).href);
  for (const file of Object.values(DENEXT_RUNTIME_FILE)) {
    assert(file.replace(/\.js$/, "") in prebuilt, `${file} is not a prebuilt runtime entry`);
  }
  // Every entry points at a real framework file.
  for (const rel of Object.values(DEP_ENTRYPOINTS)) {
    await Deno.stat(new URL("../" + rel, import.meta.url));
  }
});

Deno.test("compat: an npm island named by path rides the npm bundle; unknown denext/* stays out", () => {
  const st = state(true);
  const e: TransformEntry = { mtimeMs: 0, code: "", deps: [], selfAccepting: false };
  // The Flight entry imports an npm package's `"use client"` file by path: never served raw.
  const island = "/proj/node_modules/.deno/ui@1/node_modules/ui/dist/cjs/provider.js";
  assertEquals(rewriteSpecifier(st, island, island, e), `${NPM_PREFIX}${depSlug(island)}.js`);
  assert(st.npmSpecs.has(island));
  // The native loop keeps @fs (its npm code never takes this path).
  assert(rewriteSpecifier(state(false), island, island, e).startsWith(FS_PREFIX));
  // A denext module the prebuilt runtime lacks is not an npm package (it broke the whole bundle).
  assertEquals(compatDepUrl(st, "denext/not-prebuilt"), null);
  assertEquals(compatDepUrl(st, "denext/desktop/client"), `${DEP_PREFIX}desktop-client.js`);
  assertEquals(compatDepUrl(st, "next/compat/router"), `${DEP_PREFIX}next-compat-router.js`);
});

Deno.test("compat: a CommonJS require of a runtime module gets a re-exporting wrapper", async () => {
  const target = "data:text/javascript," +
    encodeURIComponent("export default 1; export const x = 2;");
  const wrapper = cjsExternalWrapper(target);
  const mod = await import("data:text/javascript," + encodeURIComponent(wrapper));
  assertEquals(mod.default, 1);
  assertEquals(mod.x, 2);
  // A target without a default export: the namespace stands in for it.
  const bare = "data:text/javascript," + encodeURIComponent("export const y = 3;");
  const mod2 = await import("data:text/javascript," + encodeURIComponent(cjsExternalWrapper(bare)));
  assertEquals(mod2.default.y, 3);
});

Deno.test("compat: a CommonJS require of Next's server surface throws only when called", () => {
  const module = { exports: {} as Record<string | symbol, unknown> };
  new Function("module", serverOnlyStub("next/headers"))(module);
  const exp = module.exports;
  assertEquals(exp.__esModule, true);
  assertEquals(exp[Symbol.toStringTag], undefined);
  const headers = exp.headers as () => unknown;
  assertEquals(typeof headers, "function"); // importing it is fine…
  let message = "";
  try {
    headers(); // …calling it in the browser is not
  } catch (err) {
    message = (err as Error).message;
  }
  assertEquals(message, "next/headers.headers() is server-only");
});
