// Guards the compat runtime prebuild against the PUBLISHED package — sources as JSR rewrote
// them. The http-served-checkout e2e (`remote-spa-compat-build`) exercises remote-root code
// paths but serves the repo's own sources, where the wasm codecs are imported BARE
// (`@denext/photon`); JSR publishes them rewritten to `jsr:@denext/photon@^x.y.z`, which an
// external list matching only the bare spelling let esbuild descend into ("Do not know how to
// load path: …/denext_photon.wasm"). This runs the LOCAL prebuild code against the latest
// published denext root, so a rewritten-specifier regression shows up before the next release.
//
// Opt-in + NETWORK (fetches jsr.io). Skipped when jsr.io can't be reached.

import { assert } from "@std/assert";
import { prebuildDenextRuntime } from "../../src/build/next-compat.ts";

Deno.test({
  name: "e2e: the compat runtime prebuilds from the PUBLISHED (JSR-rewritten) denext sources",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  let latest: string;
  try {
    const meta = await (await fetch("https://jsr.io/@denext/denext/meta.json")).json();
    latest = meta.latest;
  } catch {
    console.warn("e2e: jsr.io unreachable (offline?) — skipping.");
    return;
  }
  const root = `https://jsr.io/@denext/denext/${latest}/`;
  const out = await Deno.makeTempDir({ prefix: "denext_jsr_prebuild_" });
  const prevPolicy = Deno.env.get("DENEXT_MIN_DEP_AGE");
  // The published codecs may be younger than Deno's default dependency-age window.
  Deno.env.set("DENEXT_MIN_DEP_AGE", "0");
  try {
    const dir = await prebuildDenextRuntime({
      outDir: out,
      frameworkRoot: root,
      configPath: `${root}deno.json`,
      classComponents: false,
    });
    const files = [...Deno.readDirSync(dir)].map((e) => e.name);
    assert(
      files.some((f) => f.startsWith("react") && f.endsWith(".js")),
      `runtime emitted: ${files}`,
    );
    assert(!files.some((f) => f.endsWith(".wasm")), "the wasm codecs stay external, not bundled");
  } finally {
    if (prevPolicy === undefined) Deno.env.delete("DENEXT_MIN_DEP_AGE");
    else Deno.env.set("DENEXT_MIN_DEP_AGE", prevPolicy);
    await Deno.remove(out, { recursive: true }).catch(() => {});
  }
});
