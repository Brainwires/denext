// Unbundled dev loop, pure helpers: compat specifier → dev URL mapping, and HMR accept-
// boundary propagation over the reverse import graph.

import { assert, assertEquals } from "@std/assert";
import {
  addImporter,
  createUnbundledState,
  DEP_PREFIX,
  depSlug,
  FS_PREFIX,
  NPM_PREFIX,
  type UnbundledState,
} from "../src/build/dev-unbundled/state.ts";
import { compatDepUrl } from "../src/build/dev-unbundled/resolve.ts";
import { onChange, propagate } from "../src/build/dev-unbundled/hmr.ts";
import { NEXT_ALIASES, REACT_ALIASES } from "../src/build/next-compat.ts";

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
  assertEquals(compatDepUrl(st, "next/link"), `${DEP_PREFIX}${NEXT_ALIASES["next/link"]}`);
  assertEquals(compatDepUrl(st, "next/not-a-module"), null, "unmapped next/* is left alone");
  assertEquals(compatDepUrl(st, "denext"), `${DEP_PREFIX}react.js`);
  assertEquals(compatDepUrl(st, "node:fs"), null);
  assertEquals(compatDepUrl(st, "https://esm.sh/x"), null);
  assertEquals(compatDepUrl(st, "lodash-es"), `${NPM_PREFIX}${depSlug("lodash-es")}.js`);
  assert(st.npmSpecs.has("lodash-es"), "an npm specifier is noted for the on-demand bundle");
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
