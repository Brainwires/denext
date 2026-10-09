// `denext mobile assets` (src/build/mobile-assets.ts) and its raster / PNG helpers
// (src/build/png-raster.ts): every icon and splash size from one source, RGB where Apple
// requires it, dark variants, and a dry run that writes nothing. NETWORK on a cold cache
// (photon wasm).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  crc32,
  decodeImage,
  encodePng,
  flatten,
  hexOf,
  parseHexColor,
  solid,
} from "../src/build/png-raster.ts";
import {
  colorFlag,
  findAssetSource,
  formatAssetsReport,
  generateMobileAssets,
} from "../src/build/mobile-assets.ts";

/** A PNG's width, height and colour type from its IHDR. */
function ihdr(bytes: Uint8Array): { width: number; height: number; colorType: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20), colorType: bytes[25] };
}

/** A 64×64 icon: a red disc on transparency. */
async function iconPng(size = 64): Promise<Uint8Array> {
  const r = solid(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((x - size / 2) ** 2 + (y - size / 2) ** 2 > (size / 2.5) ** 2) continue;
      r.px.set([220, 20, 60, 255], (y * size + x) * 4);
    }
  }
  return await encodePng(r);
}

async function project(platforms: string[]): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_assets_" });
  for (const p of platforms) await Deno.mkdir(join(dir, p));
  await Deno.mkdir(join(dir, "assets"));
  await Deno.writeFile(join(dir, "assets/icon.png"), await iconPng());
  return dir;
}

Deno.test("png-raster: crc32, colours, and an RGB / RGBA round trip through photon", async () => {
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assertEquals(parseHexColor("#0f172a"), { r: 15, g: 23, b: 42 });
  assertEquals(parseHexColor("fff"), { r: 255, g: 255, b: 255 });
  assertEquals(parseHexColor("blue"), null);
  assertEquals(hexOf({ r: 15, g: 23, b: 42 }), "#0F172A");
  assertEquals(colorFlag("#000", "--x"), { r: 0, g: 0, b: 0 });
  let threw = false;
  try {
    colorFlag("nope", "--background-color");
  } catch (err) {
    threw = true;
    assertStringIncludes((err as Error).message, "--background-color");
  }
  assert(threw);

  const img = solid(3, 2, { r: 1, g: 2, b: 3 });
  img.px.set([200, 100, 50, 128], 4);
  const rgba = await encodePng(img);
  assertEquals(ihdr(rgba), { width: 3, height: 2, colorType: 6 });
  assertEquals((await decodeImage(rgba)).px, img.px);

  const rgb = await encodePng(flatten(img, { r: 255, g: 255, b: 255 }), { alpha: false });
  assertEquals(ihdr(rgb).colorType, 2);
  const back = await decodeImage(rgb);
  assertEquals([...back.px.subarray(0, 4)], [1, 2, 3, 255]);
  // 50% of (200,100,50) over white.
  assertEquals([...back.px.subarray(4, 8)], [227, 177, 152, 255]);
});

Deno.test("mobile assets: every iOS and Android icon and splash, RGB App Store icon", async () => {
  const dir = await project(["ios", "android"]);
  try {
    const report = await generateMobileAssets(dir, {
      icon: (await findAssetSource(dir, "icon"))!,
      background: { r: 15, g: 23, b: 42 },
    });
    assertEquals(report.platforms, ["ios", "android"]);
    // iOS: icon + Contents.json, 3 splashes + Contents.json. Android: 4 icons × 5 densities,
    // 2 adaptive XML, the colour, 11 splashes.
    assertEquals(report.files.length, 2 + 4 + 20 + 3 + 11);
    assert(report.warnings.some((w) => w.includes("1024×1024")), "a 64px icon is warned about");

    const appIcon = await Deno.readFile(
      join(dir, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"),
    );
    assertEquals(ihdr(appIcon), { width: 1024, height: 1024, colorType: 2 });
    const splash = await Deno.readFile(
      join(dir, "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png"),
    );
    assertEquals(ihdr(splash).width, 2732);
    const contents = JSON.parse(
      await Deno.readTextFile(
        join(dir, "ios/App/App/Assets.xcassets/Splash.imageset/Contents.json"),
      ),
    );
    assertEquals(contents.images.length, 3);

    const res = join(dir, "android/app/src/main/res");
    assertEquals(ihdr(await Deno.readFile(join(res, "mipmap-xxxhdpi/ic_launcher.png"))).width, 192);
    assertEquals(
      ihdr(await Deno.readFile(join(res, "mipmap-hdpi/ic_launcher_foreground.png"))).width,
      162,
    );
    assertEquals(
      ihdr(await Deno.readFile(join(res, "drawable-land-xxhdpi/splash.png"))),
      { width: 1600, height: 960, colorType: 2 },
    );
    assertStringIncludes(
      await Deno.readTextFile(join(res, "mipmap-anydpi-v26/ic_launcher.xml")),
      "@mipmap/ic_launcher_monochrome",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(res, "values/ic_launcher_background.xml")),
      "#0F172A",
    );
    // The round icon's corner is transparent; the legacy one's is the background.
    const round = await decodeImage(
      await Deno.readFile(join(res, "mipmap-mdpi/ic_launcher_round.png")),
    );
    assertEquals(round.px[3], 0);
    const legacy = await decodeImage(await Deno.readFile(join(res, "mipmap-mdpi/ic_launcher.png")));
    assertEquals([...legacy.px.subarray(0, 4)], [15, 23, 42, 255]);
    assertStringIncludes(formatAssetsReport(report), "40 files for ios + android");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile assets: dark variants, a platform filter, and a dry run that writes nothing", async () => {
  const dir = await project(["ios", "android"]);
  try {
    await Deno.writeFile(join(dir, "assets/icon-dark.png"), await iconPng(32));
    const dry = await generateMobileAssets(dir, {
      icon: join(dir, "assets/icon.png"),
      iconDark: (await findAssetSource(dir, "iconDark"))!,
      background: { r: 255, g: 255, b: 255 },
      darkBackground: { r: 0, g: 0, b: 0 },
    }, { platforms: ["ios"], dryRun: true });
    assertEquals(dry.platforms, ["ios"]);
    assert(dry.files.some((f) => f.path.endsWith("AppIcon-512@2x-dark.png")));
    assertEquals(dry.files.filter((f) => f.path.includes("-dark.png")).length, 4);
    assertStringIncludes(formatAssetsReport(dry), "would write");
    let wrote = false;
    try {
      await Deno.stat(join(dir, "ios/App"));
      wrote = true;
    } catch { /* nothing written */ }
    assert(!wrote, "a dry run writes nothing");

    await generateMobileAssets(dir, {
      icon: join(dir, "assets/icon.png"),
      background: { r: 255, g: 255, b: 255 },
      darkBackground: { r: 0, g: 0, b: 0 },
    }, { platforms: ["android"] });
    const night = await decodeImage(
      await Deno.readFile(join(dir, "android/app/src/main/res/drawable-night/splash.png")),
    );
    assertEquals([...night.px.subarray(0, 4)], [0, 0, 0, 255]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile assets: no native project, or an undecodable source, is an error", async () => {
  const dir = await project([]);
  try {
    await assertRejects(
      () =>
        generateMobileAssets(dir, {
          icon: join(dir, "assets/icon.png"),
          background: { r: 0, g: 0, b: 0 },
        }),
      Error,
      "npx cap add",
    );
    await Deno.mkdir(join(dir, "android"));
    await Deno.writeTextFile(join(dir, "assets/bad.png"), "<svg/>");
    await assertRejects(
      () =>
        generateMobileAssets(dir, {
          icon: join(dir, "assets/bad.png"),
          background: { r: 0, g: 0, b: 0 },
        }),
      Error,
      "cannot decode",
    );
    assertEquals(await findAssetSource(dir, "splash"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile assets: images the previous splash catalog named and the new one does not are removed", async () => {
  const dir = await project(["ios"]);
  const set = "ios/App/App/Assets.xcassets/Splash.imageset";
  const exists = async (rel: string) => {
    try {
      return (await Deno.stat(join(dir, rel))).isFile;
    } catch {
      return false;
    }
  };
  try {
    await Deno.mkdir(join(dir, set), { recursive: true });
    // A catalog an earlier run (with a dark splash) or a hand edit left: its own images, one it
    // shares with the new catalog, a name that leaves the folder, and one that does not exist.
    await Deno.writeTextFile(
      join(dir, set, "Contents.json"),
      JSON.stringify({
        images: [
          { idiom: "universal", filename: "splash-2732x2732.png", scale: "3x" },
          { idiom: "universal", filename: "splash-2732x2732-dark.png", scale: "3x" },
          { idiom: "universal", filename: "Default@2x~universal~anyany.png", scale: "2x" },
          { idiom: "universal", filename: "../escape.png", scale: "1x" },
          { idiom: "universal", filename: "missing.png", scale: "1x" },
        ],
        info: { version: 1, author: "xcode" },
      }),
    );
    for (
      const name of ["splash-2732x2732-dark.png", "Default@2x~universal~anyany.png", "notes.txt"]
    ) {
      await Deno.writeTextFile(join(dir, set, name), "old");
    }
    await Deno.writeTextFile(join(dir, set, "../escape.png"), "outside the set");
    const spec = { icon: join(dir, "assets/icon.png"), background: { r: 255, g: 255, b: 255 } };

    const dry = await generateMobileAssets(dir, spec, { dryRun: true });
    const dryText = formatAssetsReport(dry);
    assertStringIncludes(dryText, `would remove  ${set}/splash-2732x2732-dark.png`);
    assertStringIncludes(dryText, `would remove  ${set}/Default@2x~universal~anyany.png`);
    assert(await exists(`${set}/splash-2732x2732-dark.png`), "a dry run removes nothing");

    const report = await generateMobileAssets(dir, spec);
    const text = formatAssetsReport(report);
    assertStringIncludes(text, `removed  ${set}/splash-2732x2732-dark.png`);
    assert(!await exists(`${set}/splash-2732x2732-dark.png`), "the old dark splash is removed");
    assert(
      !await exists(`${set}/Default@2x~universal~anyany.png`),
      "an old named image is removed",
    );
    assert(await exists(`${set}/splash-2732x2732.png`), "an image the new catalog names stays");
    assert(await exists(`${set}/notes.txt`), "a file no catalog named stays");
    assert(await exists("ios/App/App/Assets.xcassets/escape.png"), "nothing outside the set");
    assert(!text.includes("escape.png") && !text.includes("missing.png"), text);

    // Run again: the catalog it wrote names exactly what is there, so nothing more goes.
    assert(!formatAssetsReport(await generateMobileAssets(dir, spec)).includes("removed"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
