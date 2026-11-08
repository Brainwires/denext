// Desktop CI: Linux packaging's libnode check (`assertLinuxNativeAddons`) on REAL ELF Node-API
// addons, not the unit tests' canned `readelf` output. `scripts/ci/desktop-appimage-smoke.sh libnode`
// compiles a stub `libnode.so.<abi>`, an addon linked against it and one that is not, then runs:
//
//   deno run -A scripts/ci/desktop-libnode-check.ts <linked.node> <plain.node> <libnode soname>
//
// The linked addon must stop the package, in the bundle and in a copied sidecar package
// (`.deno-desktop/sidecars/`), naming the addon, the soname and the fix; the plain one must pass;
// and the scan must have read the addons (no "not checked" note).

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  assertLinuxNativeAddons,
  linuxNativeAddonProblems,
} from "../../src/build/desktop-native-addons.ts";

const [linked, plain, soname] = Deno.args;
if (!linked || !plain || !soname) {
  console.error("usage: desktop-libnode-check.ts <linked.node> <plain.node> <libnode soname>");
  Deno.exit(2);
}

/** A fresh project with its bundle; `addons` copied in under `<root>/<relative path>`. */
async function project(addons: Record<string, string>): Promise<{ dir: string; bundle: string }> {
  const dir = await Deno.makeTempDir({ prefix: "libnode-check-" });
  const bundle = join(dir, "dist", "app-x64");
  await Deno.mkdir(bundle, { recursive: true });
  for (const [rel, src] of Object.entries(addons)) {
    const dest = join(dir, rel);
    await Deno.mkdir(join(dest, ".."), { recursive: true });
    await Deno.copyFile(src, dest);
  }
  return { dir, bundle };
}

const ADDON_IN_BUNDLE = "dist/app-x64/node_modules/pty/build/Release/pty.node";
const ADDON_IN_SIDECAR = ".deno-desktop/sidecars/api/node_modules/db/db.node";

// The scan reads the linked addon's dynamic section and names its libnode.
const bad = await project({ [ADDON_IN_BUNDLE]: linked });
const scan = await linuxNativeAddonProblems([bad.bundle]);
assertEquals(scan.note, undefined, "the addons were not read (no readelf / objdump / ldd?)");
assertEquals(scan.addons.length, 1, `addons found: ${scan.addons.join(", ")}`);
assertEquals(scan.problems.length, 1);
assertEquals(scan.problems[0].library, soname);
console.log(`scan: ${scan.problems[0].addon} links ${scan.problems[0].library}`);

// The package script's check refuses it, naming the addon, the soname and the fix.
const err = await assertRejects(() => assertLinuxNativeAddons(bad.dir, bad.bundle), Error);
assertStringIncludes(err.message, "cannot package for Linux");
assertStringIncludes(err.message, "pty.node");
assertStringIncludes(err.message, soname);
assertStringIncludes(err.message, "node-gyp");
console.log(`bundle: refused — ${err.message}`);

// The same addon in a copied sidecar package, the bundle clean: still refused.
const sidecar = await project({ [ADDON_IN_SIDECAR]: linked });
const sidecarErr = await assertRejects(
  () => assertLinuxNativeAddons(sidecar.dir, sidecar.bundle),
  Error,
);
assertStringIncludes(sidecarErr.message, "db.node");
assertStringIncludes(sidecarErr.message, soname);
console.log("sidecar: refused");

// An addon that links no libnode (Node's own headers / an npm prebuilt) packages.
const good = await project({ [ADDON_IN_BUNDLE]: plain });
const goodScan = await linuxNativeAddonProblems([good.bundle]);
assertEquals(goodScan.addons.length, 1);
assertEquals(goodScan.problems, []);
assertEquals(goodScan.note, undefined);
await assertLinuxNativeAddons(good.dir, good.bundle);
console.log("plain addon: packaged");

for (const p of [bad, sidecar, good]) await Deno.remove(p.dir, { recursive: true });
console.log(
  `\n✓ the libnode check refuses an addon linked against ${soname} and passes one that is not`,
);
