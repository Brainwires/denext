// U11 (#106): a framework root without a trailing slash. `new URL("src/x.ts", base)` replaces
// the base's last segment, so `runtimeEntryPoints("/a/denext")` resolved every runtime entry
// under `/a/` — the prebuild then bundled files that don't exist. A caller passing its own
// `frameworkRoot` (a filesystem path, as `frameworkRoot()` returns one) hit it every time.

import { assertEquals } from "@std/assert";
import { resolve, toFileUrl } from "@std/path";
import { runtimeEntryPoints } from "../src/build/next-compat.ts";

Deno.test("a bare framework path without a trailing slash keeps its last segment", () => {
  const root = resolve("/a/denext");
  const entries = runtimeEntryPoints(root);
  assertEquals(entries["denext"], `${toFileUrl(root).href}/mod.ts`);
  assertEquals(entries["react"], `${toFileUrl(root).href}/src/compat/react.ts`);
});

Deno.test("a URL root without a trailing slash keeps its last segment", () => {
  const jsr = runtimeEntryPoints("https://jsr.io/@denext/denext/4.6.0");
  assertEquals(jsr["denext"], "https://jsr.io/@denext/denext/4.6.0/mod.ts");
  const file = runtimeEntryPoints("file:///a/denext");
  assertEquals(file["react"], "file:///a/denext/src/compat/react.ts");
});

Deno.test("a root that already ends in a slash is unchanged", () => {
  assertEquals(runtimeEntryPoints("file:///fw/")["denext"], "file:///fw/mod.ts");
  const root = resolve("/a/denext");
  assertEquals(runtimeEntryPoints(`${root}/`)["denext"], `${toFileUrl(root).href}/mod.ts`);
});
