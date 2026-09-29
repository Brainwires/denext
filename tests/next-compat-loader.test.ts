// The compat source → server-bundle map: the manifest stores it project/outDir-relative;
// the prod server and the build's finalize stage rebuild the absolute map the same way.

import { assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  compatModuleMapFromManifest,
  createNextCompatServerLoader,
} from "../src/build/next-compat-loader.ts";

/** A real absolute root on this OS (`C:\repo` on Windows), so the map holds local paths. */
const R = Deno.build.os === "windows" ? "C:\\repo" : "/repo";

Deno.test("compatModuleMapFromManifest resolves relative entries (incl. ../ outside the app)", () => {
  const web = join(R, "apps", "web");
  const map = compatModuleMapFromManifest(web, join(web, ".denext"), {
    "app/layout.tsx": "server/app_layout.js",
    "../../node_modules/next-themes/dist/index.mjs": "server/next-themes.js",
  });
  assertEquals(
    map.get(join(web, "app", "layout.tsx")),
    join(web, ".denext", "server", "app_layout.js"),
  );
  assertEquals(
    map.get(join(R, "node_modules/next-themes/dist/index.mjs")),
    join(web, ".denext", "server", "next-themes.js"),
  );
});

Deno.test("createNextCompatServerLoader loads the bundle for a mapped source, else the source", async () => {
  const seen: string[] = [];
  const base = (p: string) => {
    seen.push(p);
    return Promise.resolve({});
  };
  const page = join(R, "app", "page.tsx");
  const other = join(R, "app", "other.tsx");
  const load = createNextCompatServerLoader(base, {
    moduleMap: new Map([[page, "/out/server/page.js"]]),
  });
  await load(page);
  await load(toFileUrl(page).href);
  await load(other);
  assertEquals(seen, ["/out/server/page.js", "/out/server/page.js", other]);
});
