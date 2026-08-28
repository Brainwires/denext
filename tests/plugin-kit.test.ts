// Guards the router-plugin contract surface (@denext/denext/plugin-kit): the blessed
// pipeline primitives must stay exported and callable-shaped. If a core refactor
// drops or renames one of these, this fails — a deliberate semver tripwire.

import { assert, assertEquals } from "@std/assert";
import * as kit from "../src/plugin/kit.ts";

Deno.test("plugin-kit exports the blessed pipeline primitives", () => {
  const expected = [
    // route matching
    "matchSegments",
    "parsePattern",
    "peelLocale",
    "specificity",
    // ISR
    "PageCache",
    // build steps
    "bundleRoutes",
    "buildAppCss",
    "extractRouteCss",
    // client hydration + fast refresh
    "enableFastRefresh",
    "hydrateRoot",
    "registerFamily",
  ];
  for (const name of expected) {
    assert(name in kit, `plugin-kit must export ${name}`);
    assertEquals(
      typeof (kit as Record<string, unknown>)[name],
      "function",
      `${name} should be a function/class`,
    );
  }
});

Deno.test("plugin-kit does not leak an over-broad value surface", () => {
  // Types erase at runtime, so only value exports show up here. Keep this list tight:
  // adding a value to the kit is a semver commitment, so it should be intentional.
  const values = Object.keys(kit).sort();
  assertEquals(values, [
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
  ]);
});
