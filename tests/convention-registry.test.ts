import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  registerConvention,
  registerRouteSynthesizer,
  scanRoutes,
} from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

async function buildAppTree(files: string[]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_conv_" });
  for (const rel of files) {
    const full = join(dir, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, "export default function () {}\n");
  }
  return dir;
}

Deno.test("registerConvention can retarget a built-in convention matcher", async () => {
  const dir = await buildAppTree(["about/page.mts"]);
  try {
    // Default matcher does not recognize .mts.
    const before = await scanRoutes(dir);
    assertEquals(before.pages.length, 0);

    // Widen the "page" convention to also accept .mts, then rescan.
    registerConvention("page", /^page\.(mts|tsx|ts|jsx|js)$/);
    const after = await scanRoutes(dir);
    assertEquals(after.pages.map((p) => p.routePath), ["/about"]);
  } finally {
    // Restore the built-in matcher so other tests in this process are unaffected.
    registerConvention("page", /^page\.(tsx|ts|jsx|js)$/);
    await Deno.remove(dir, { recursive: true });
  }
});

// A synthesizer that is inert unless the fixture opts in via a marker route, so
// registering it globally does not affect other tests in the shared process.
registerRouteSynthesizer((manifest) => {
  const marker = manifest.pages.find((p) => p.routePath === "/__synth_marker");
  if (!marker) return;
  manifest.pages.push({
    ...marker,
    routePath: "/__synth_marker/derived",
    pattern: parsePattern("__synth_marker/derived"),
  });
});

Deno.test("registerRouteSynthesizer can add derived routes post-scan", async () => {
  const dir = await buildAppTree(["__synth_marker/page.tsx"]);
  try {
    const manifest = await scanRoutes(dir);
    const derived = manifest.pages.find((p) => p.routePath === "/__synth_marker/derived");
    assertExists(derived);
    // Both the original and the derived route are present.
    assertExists(manifest.pages.find((p) => p.routePath === "/__synth_marker"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
