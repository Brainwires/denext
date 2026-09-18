// Guards the compat runtime prebuild against the PUBLISHED package — sources as JSR rewrote
// them. The http-served-checkout e2e (`remote-spa-compat-build`) exercises remote-root code
// paths but serves the repo's own sources, where the wasm codecs are imported BARE
// (`@denext/photon`); JSR publishes them rewritten to `jsr:@denext/photon@^x.y.z`, which an
// external list matching only the bare spelling let esbuild descend into ("Do not know how to
// load path: …/denext_photon.wasm"). This runs the LOCAL prebuild code against the newest
// published denext root, so a rewritten-specifier regression shows up before the next release.
//
// "Newest" INCLUDES prereleases: JSR's `latest` is the newest STABLE version, and the active
// branch runs several rcs ahead of it — the local entry list can name a module (`src/mobile/
// mod.ts` in 2.5.0-rc.1) that `latest` (2.4.3) never published, which is a version skew, not a
// prebuild regression. So the test picks the highest version by semver, and when even that one
// lacks an entry the local tree references, it SKIPS naming the modules instead of failing.
//
// Opt-in + NETWORK (fetches jsr.io). Skipped when jsr.io can't be reached.

import { assert } from "@std/assert";
import { prebuildDenextRuntime, runtimeEntryPoints } from "../../src/build/next-compat.ts";

const PACKAGE = "https://jsr.io/@denext/denext/";

/** A version as `[major, minor, patch]` plus its prerelease identifiers (none for a release). */
function parseSemver(v: string): { core: number[]; pre: string[] } | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split(".") ?? [] };
}

/** One prerelease identifier against another, per SemVer 2.0 §11 (numeric < alphanumeric). */
function compareIdentifier(x: string, y: string): number {
  const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
  if (nx && ny) return Number(x) - Number(y);
  if (nx !== ny) return nx ? -1 : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Prerelease lists: a shorter list sorts first when every shared identifier is equal. */
function comparePrerelease(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareIdentifier(a[i], b[i]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** Semver ordering (`1.2.3-rc.1` < `1.2.3`; prerelease identifiers compared per SemVer 2.0). */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a), pb = parseSemver(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  // A release outranks every prerelease of the same core.
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  return comparePrerelease(pa.pre, pb.pre);
}

/** The highest published version, prereleases included (`meta.json` lists every version). */
async function newestPublished(): Promise<string> {
  const meta = await (await fetch(PACKAGE + "meta.json")).json();
  const versions = Object.keys(meta.versions ?? {}).filter((v) => !meta.versions[v]?.yanked);
  versions.sort(compareSemver);
  return versions.at(-1) ?? meta.latest;
}

/** The published file list of one version (`<version>_meta.json` → `manifest` keys). */
async function publishedFiles(version: string): Promise<Set<string>> {
  const meta = await (await fetch(`${PACKAGE}${version}_meta.json`)).json();
  return new Set(Object.keys(meta.manifest ?? {}));
}

Deno.test({
  name: "e2e: the compat runtime prebuilds from the PUBLISHED (JSR-rewritten) denext sources",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  let version: string;
  let files: Set<string>;
  try {
    version = await newestPublished();
    files = await publishedFiles(version);
  } catch {
    console.warn("e2e: jsr.io unreachable (offline?) — skipping.");
    return;
  }
  const root = `${PACKAGE}${version}/`;
  // Every entry the LOCAL prebuild lists must exist in that version, or esbuild fails on a
  // "Module not found" that says nothing about specifier rewriting — the property under test.
  const missing = Object.values(runtimeEntryPoints(root))
    .map((url) => url.slice(root.length - 1))
    .filter((path) => !files.has(path));
  if (missing.length > 0) {
    console.warn(
      `e2e: the local runtime entry list references modules the newest published version ` +
        `(${version}) lacks — skipping until the next publish:\n  ${missing.join("\n  ")}`,
    );
    return;
  }
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
    const emitted = [...Deno.readDirSync(dir)].map((e) => e.name);
    assert(
      emitted.some((f) => f.startsWith("react") && f.endsWith(".js")),
      `runtime emitted: ${emitted}`,
    );
    assert(!emitted.some((f) => f.endsWith(".wasm")), "the wasm codecs stay external, not bundled");
  } finally {
    if (prevPolicy === undefined) Deno.env.delete("DENEXT_MIN_DEP_AGE");
    else Deno.env.set("DENEXT_MIN_DEP_AGE", prevPolicy);
    await Deno.remove(out, { recursive: true }).catch(() => {});
  }
});
