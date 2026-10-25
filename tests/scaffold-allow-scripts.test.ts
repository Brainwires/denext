// `denext create`'s deno.json denies the one npm lifecycle script the framework's dependency
// graph carries (`@parcel/watcher`'s, through `sass`; its prebuilt binary is an optional
// dependency and denext never watches through it). Up to 4.5.0 every command on a fresh scaffold,
// and every Docker build of it, printed Deno's "Ignored build scripts" box, hiding real warnings.

import { assertEquals } from "@std/assert";
import { denoJson } from "../src/build/scaffold.ts";

Deno.test("a scaffolded deno.json denies @parcel/watcher's build script, so Deno doesn't warn", () => {
  for (const opts of [{}, { desktop: true }, { capacitor: true }]) {
    const cfg = JSON.parse(denoJson({ dir: "/x", ...opts }));
    assertEquals(cfg.allowScripts, { deny: ["npm:@parcel/watcher"] }, JSON.stringify(opts));
  }
});

Deno.test("a scaffolded deno.json excludes .deno/, so deno test skips a runtime's npm-compat copy", () => {
  // Deno runtime 3.0.0-rc.5's type-check writes `.deno/npm-compat` (with `@jsr/*` `_test.ts`
  // files) into the project root; default `deno test` discovery would run them.
  for (const opts of [{}, { desktop: true }, { monorepoScope: "@acme" }]) {
    const cfg = JSON.parse(denoJson({ dir: "/x", ...opts }));
    assertEquals(cfg.exclude, [".deno/"], JSON.stringify(opts));
  }
});
