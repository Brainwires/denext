// The import map `denext create` writes: every denext entry a new app is told to import resolves
// (here `denext/deploy`, which denext.config.ts imports a deploy preset from).

import { assertEquals } from "@std/assert";
import { denoJson } from "../src/build/scaffold.ts";

Deno.test("denext create maps denext/deploy beside denext/server", () => {
  const imports = JSON.parse(denoJson({ dir: "app" })).imports as Record<string, string>;
  assertEquals(imports["denext/deploy"], `${imports["denext"]}/deploy`);
  assertEquals(imports["denext/server"], `${imports["denext"]}/server`);
});
