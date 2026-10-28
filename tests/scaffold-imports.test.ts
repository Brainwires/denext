// The import map `denext create` writes: every denext entry a new app is told to import resolves
// (here `denext/deploy`, which denext.config.ts imports a deploy preset from).

import { assertEquals } from "@std/assert";
import { denoJson } from "../src/build/scaffold.ts";

Deno.test("denext create maps denext/deploy beside denext/server", () => {
  const imports = JSON.parse(denoJson({ dir: "app" })).imports as Record<string, string>;
  assertEquals(imports["denext/deploy"], `${imports["denext"]}/deploy`);
  assertEquals(imports["denext/server"], `${imports["denext"]}/server`);
});

Deno.test("denext create maps @denext/auth at denext's own range, and no denext/auth", () => {
  const imports = JSON.parse(denoJson({ dir: "app" })).imports as Record<string, string>;
  const range = imports["denext"].slice("jsr:@denext/denext@".length);
  assertEquals(imports["@denext/auth"], `jsr:@denext/auth@${range}`);
  assertEquals(imports["denext/auth"], undefined);
});
