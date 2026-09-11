// Guards the router-plugin contract surface (@denext/denext/plugin-kit): the blessed
// pipeline primitives must stay exported and callable-shaped. If a core refactor
// drops or renames one of these, this fails — a deliberate semver tripwire.

import { assert, assertEquals } from "@std/assert";
import * as kit from "../src/plugin/kit.ts";

Deno.test("plugin-kit exports the blessed pipeline primitives", () => {
  const expected = [
    "PageCache",
    "buildAppCss",
    "bundleRoutes",
    "enableFastRefresh",
    "extractRouteCss",
    "hydrateRoot",
    "matchSegments",
    "parsePattern",
    "peelLocale",
    "registerFamily",
    "specificity",
    "tapChannel",
    "verifyOrigin",
  ];
  for (const name of expected) {
    assert(name in kit, `plugin-kit must export ${name}`);
    assertEquals(
      typeof (kit as Record<string, unknown>)[name],
      "function",
      `${name} should be a function/class`,
    );
  }
  // The Remix/React-Router route-module codegen ships as ONE namespace (a router plugin's
  // whole generator toolkit), not as a spread of value exports.
  assertEquals(typeof kit.remixCodegen, "object");
  assertEquals(typeof kit.remixCodegen.analyzeModule, "function");
  assertEquals(typeof kit.remixCodegen.pageWrapperSource, "function");
});

Deno.test("plugin-kit does not leak an over-broad value surface", () => {
  // Types erase at runtime, so only value exports show up here. Keep this list tight:
  // adding a value to the kit is a semver commitment, so it should be intentional.
  const values = Object.keys(kit).sort();
  assertEquals(values, [
    "PageCache",
    "STALLED",
    "TOO_LARGE",
    "apiDefinitionOf",
    "bufferedRequest",
    "buildAppCss",
    "buildNextCompatModules",
    "bundleRoutes",
    "cappedBody",
    "compareSpecificity",
    "compileMdxSource",
    "createNextCompatServerLoader",
    "enableFastRefresh",
    "extractRouteCss",
    "fromBase64Url",
    "hmacSign",
    "hmacVerify",
    "hydrateRoot",
    "matchSegments",
    "parsePattern",
    "peelLocale",
    "readCappedBody",
    "registerFamily",
    "remixCodegen",
    "revalidatePath",
    "revalidateTag",
    "specificity",
    "tapChannel",
    "toBase64Url",
    "verifyOrigin",
  ]);
});
