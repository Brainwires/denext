// The compat source → server-bundle map: the manifest stores it project/outDir-relative;
// the prod server and the build's finalize stage rebuild the absolute map the same way.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  compatModuleMapFromManifest,
  createNextCompatServerLoader,
} from "../src/build/next-compat-loader.ts";

Deno.test("compatModuleMapFromManifest resolves relative entries (incl. ../ outside the app)", () => {
  const map = compatModuleMapFromManifest("/repo/apps/web", "/repo/apps/web/.denext", {
    "app/layout.tsx": "server/app_layout.js",
    "../../node_modules/next-themes/dist/index.mjs": "server/next-themes.js",
  });
  assertEquals(
    map.get("/repo/apps/web/app/layout.tsx"),
    "/repo/apps/web/.denext/server/app_layout.js",
  );
  assertEquals(
    map.get(join("/repo", "node_modules/next-themes/dist/index.mjs")),
    "/repo/apps/web/.denext/server/next-themes.js",
  );
});

Deno.test("createNextCompatServerLoader loads the bundle for a mapped source, else the source", async () => {
  const seen: string[] = [];
  const base = (p: string) => {
    seen.push(p);
    return Promise.resolve({});
  };
  const load = createNextCompatServerLoader(base, {
    moduleMap: new Map([["/app/page.tsx", "/out/server/page.js"]]),
  });
  await load("/app/page.tsx");
  await load("file:///app/page.tsx");
  await load("/app/other.tsx");
  assertEquals(seen, ["/out/server/page.js", "/out/server/page.js", "/app/other.tsx"]);
});
