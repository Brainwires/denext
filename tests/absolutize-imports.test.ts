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
  // The base is a real absolute directory on this OS (a drive-letter path on Windows).
  const win = Deno.build.os === "windows";
  const out = absolutizeImports(
    { denext: "./mod.ts", up: "../x.ts" },
    win ? "C:\\base\\sub" : "/base/sub",
  );
  const root = win ? "file:///C:/base" : "file:///base";
  assertEquals(out.denext, `${root}/sub/mod.ts`);
  assertEquals(out.up, `${root}/x.ts`);
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
