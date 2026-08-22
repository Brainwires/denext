// Regression test for import-map absolutization: a prefix mapping's trailing
// slash must survive (a `"~/": "./src/"` alias needs `~/x` → `…/src/x`).

import { assert, assertEquals } from "@std/assert";
import { absolutizeImports } from "../src/build/bundle.ts";

Deno.test("absolutizeImports preserves a trailing slash on prefix mappings", () => {
  const out = absolutizeImports({ "~/": "./src/", "@/": "./app/" }, "/base");
  assert(out["~/"].endsWith("/src/"), `expected trailing slash, got ${out["~/"]}`);
  assert(out["@/"].endsWith("/app/"), `expected trailing slash, got ${out["@/"]}`);
});

Deno.test("absolutizeImports resolves relative paths to file URLs (no spurious slash)", () => {
  const out = absolutizeImports({ denext: "./mod.ts", up: "../x.ts" }, "/base/sub");
  assertEquals(out.denext, "file:///base/sub/mod.ts");
  assertEquals(out.up, "file:///base/x.ts");
});

Deno.test("absolutizeImports passes bare specifiers through unchanged", () => {
  const out = absolutizeImports({
    react: "npm:react@19",
    std: "jsr:@std/path@1",
    remote: "https://esm.sh/x",
    abs: "file:///already/abs.ts",
  }, "/base");
  assertEquals(out.react, "npm:react@19");
  assertEquals(out.std, "jsr:@std/path@1");
  assertEquals(out.remote, "https://esm.sh/x");
  assertEquals(out.abs, "file:///already/abs.ts");
});
