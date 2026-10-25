// React Native mode on the App Router, in `denext dev`: the per-module loop serves the
// `"use client"` island unbundled (its `react-native` from React Native mode's dependency bundle,
// react-native-web resolved there), so editing the island pushes an in-place `update:` frame — a
// hot swap with its state kept — instead of the bundled loop's whole-route refresh. An edit that
// imports a name the dependency bundle lacks rebuilds it and reloads the page instead (a hot swap
// would link against the old bundle). No browser: the live-reload SSE channel is tapped with
// `fetch`, as in tests/dev-server-hmr-integration.test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startDevOnDir } from "./e2e/harness.ts";
import { fsUrlPath, NPM_PREFIX } from "../src/build/dev-unbundled/state.ts";
import { stopNextCompat } from "../src/build/next-compat.ts";
import { writeRnAppRouterFixture } from "./helpers/rn-app-router-fixture.ts";
import { SseTap } from "./helpers/sse-tap.ts";

/** GET `path` from the dev server as text, asserting a 200. */
async function text(origin: string, path: string): Promise<string> {
  const res = await fetch(origin + path);
  const body = await res.text();
  assertEquals(res.status, 200, `${path}: ${body.slice(0, 300)}`);
  return body;
}

Deno.test({
  name: "dev (App Router, reactNative): an island edit hot-swaps per module",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_rn_ar_hmr_" }));
  await writeRnAppRouterFixture(dir, "{ reactNative: true }");
  const server = await startDevOnDir(dir, { DENEXT_DEV_TYPECHECK: "0" }, { unbundled: true });
  const island = join(dir, "components/counter.tsx");
  let tap: SseTap | null = null;
  try {
    await t.step("the page renders, and its island is served on its own", async () => {
      const html = await text(server.origin, "/");
      assertStringIncludes(html, 'data-rnw="RNW_VIEW"');
      assertStringIncludes(html, "RN_ISLAND:0");
      // The Flight entry imports the island by its `@fs` URL (the per-module loop owns it).
      assertStringIncludes(await text(server.origin, "/_denext/flight.js"), fsUrlPath(island));
      const mod = await text(server.origin, fsUrlPath(island));
      assertStringIncludes(mod, `${NPM_PREFIX}react-native.js`);
      // React Native mode's dependency bundle: react-native is react-native-web there.
      const rn = await text(server.origin, `${NPM_PREFIX}react-native.js`);
      assert(/as View\b/.test(rn) && /as StyleSheet\b/.test(rn), rn.slice(0, 400));
      assert(!rn.includes("import typeof"), "not the real (Flow) react-native");
    });

    tap = new SseTap((await fetch(server.origin + "/_denext/reload")).body!);

    await t.step("editing the island pushes an in-place update of that module", async () => {
      tap!.events.length = 0;
      const src = await Deno.readTextFile(island);
      await Deno.writeTextFile(island, src.replace('"RN_ISLAND:"', '"RN_ISLAND_EDITED:"'));
      const frame = await tap!.waitFor((e) =>
        e === "refresh" || e === "reload" || e.startsWith("update:")
      );
      assert(frame !== null, `no frame: ${tap!.events.join(",")}`);
      assert(frame.startsWith("update:"), `expected a per-module update, got ${frame}`);
      assertStringIncludes(frame, fsUrlPath(island));
      assertStringIncludes(await text(server.origin, fsUrlPath(island)), "RN_ISLAND_EDITED:");
    });

    await t.step("an edit importing a name the dependency bundle lacks reloads", async () => {
      tap!.events.length = 0;
      const src = await Deno.readTextFile(island);
      await Deno.writeTextFile(
        island,
        src.replace(
          'import { StyleSheet, Text, View } from "react-native";',
          'import { Pressable, StyleSheet, Text, View } from "react-native";\n' +
            "export const pressable = Pressable;",
        ),
      );
      const frame = await tap!.waitFor((e) =>
        e === "refresh" || e === "reload" || e.startsWith("update:")
      );
      assertEquals(frame, "reload", tap!.events.join(","));
      assert(
        !tap!.events.some((e) => e.startsWith("update:")),
        "no hot swap against the old bundle",
      );
      assert(/as Pressable\b/.test(await text(server.origin, `${NPM_PREFIX}react-native.js`)));
    });
  } finally {
    await tap?.close();
    await server.close();
    await stopNextCompat();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("denext.serverStyleSheets")];
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
