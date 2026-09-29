// SPA dev watches denext's own sources when denext runs from local files (a checkout): an edit
// there drops the framework pre-bundle and reloads (src/build/spa/framework-watch.ts).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { isFrameworkPath, linkedFrameworkDir } from "../src/build/spa/framework-watch.ts";

Deno.test("linkedFrameworkDir: the checkout's src/ locally, nothing from JSR", () => {
  const dir = linkedFrameworkDir();
  assertEquals(dir, Deno.realPathSync(fromFileUrl(new URL("../src", import.meta.url))));
  assertEquals(linkedFrameworkDir("https://jsr.io/@denext/denext/2.11.0/src/build/spa/x.ts"), null);
  assert(isFrameworkPath(`${dir}/mobile/native-view.ts`, dir));
  assert(!isFrameworkPath(`${dir}-other/x.ts`, dir));
  assert(!isFrameworkPath("/tmp/app/src/x.ts", null));
});
