// The app-icon source resolver (src/build/mobile-icon-source.ts) behind `denext mobile assets`
// with no `--icon`, the placeholder-icon replacement in `denext mobile build`, the
// `mobile doctor --store` placeholder check and the icon `denext migrate` records: the priority
// order, Expo app.json / app.config.ts (literal and computed), the web manifest, the
// apple-touch-icon, the 180 → 1024 upscale warning and the transparency flatten. NETWORK on a cold
// cache (photon wasm, swc wasm).

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { decodeImage, encodePng, type Raster, solid } from "../src/build/png-raster.ts";
import { generateMobileAssets } from "../src/build/mobile-assets.ts";
import {
  capacitorPlaceholders,
  formatIconSearch,
  mobileIconConfig,
  resolveIconSource,
} from "../src/build/mobile-icon-source.ts";
import { runMobileDoctor } from "../src/build/mobile-doctor.ts";
import { migrateProject } from "../src/build/migrate.ts";
import { checkMigration } from "../src/build/migrate-check.ts";

/** A PNG's width, height and colour type from its IHDR. */
function ihdr(bytes: Uint8Array): { width: number; height: number; colorType: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20), colorType: bytes[25] };
}

/** A `w`×`h` PNG filled with an opaque colour, or (`hole`) with a transparent top-left pixel. */
async function png(w: number, h = w, opts: { hole?: boolean } = {}): Promise<Uint8Array> {
  const r: Raster = solid(w, h, { r: 220, g: 20, b: 60 });
  if (opts.hole) r.px.set([0, 0, 0, 0], 0);
  return await encodePng(r);
}

type Files = Record<string, string | Uint8Array>;

async function tree(files: Files): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_icon_source_" });
  await write(dir, files);
  return dir;
}

async function write(dir: string, files: Files): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await Deno.mkdir(join(dir, path, ".."), { recursive: true });
    if (typeof content === "string") await Deno.writeTextFile(join(dir, path), content);
    else await Deno.writeFile(join(dir, path), content);
  }
}

const MANIFEST = (icons: unknown[], background = "#161616") =>
  JSON.stringify({ name: "x", background_color: background, icons });

Deno.test("icon source: the priority order — config, assets/, Expo, manifest, apple-touch-icon, favicon", async () => {
  const dir = await tree({
    "denext.config.ts":
      `export default { mode: "spa", mobile: { icon: "./brand/icon.png", backgroundColor: "#0f172a" } };\n`,
    "brand/icon.png": await png(1024),
    "assets/icon.png": await png(900),
    "app.json": JSON.stringify({ expo: { icon: "./expo-icon.png" } }),
    "expo-icon.png": await png(800),
    "public/manifest.webmanifest": MANIFEST([{ src: "/m-512.png", sizes: "512x512" }]),
    "public/m-512.png": await png(512),
    "public/apple-touch-icon.png": await png(180),
    "public/favicon-32x32.png": await png(32),
  });
  try {
    const order: [string, string][] = [];
    const steps = [
      "denext.config.ts",
      "assets/icon.png",
      "app.json",
      "public/manifest.webmanifest",
      "public/apple-touch-icon.png",
      "public/favicon-32x32.png",
    ];
    for (const remove of steps) {
      const { source } = await resolveIconSource(dir);
      order.push([source!.kind, `${source!.width}`]);
      await Deno.remove(join(dir, remove));
    }
    assertEquals(order, [
      ["config", "1024"],
      ["assets", "900"],
      ["expo", "800"],
      ["manifest", "512"],
      ["apple-touch-icon", "180"],
      ["favicon", "32"],
    ]);
    const none = await resolveIconSource(dir);
    assertEquals(none.source, null);
    assertStringIncludes(formatIconSearch(none)[0], "none found");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("icon source: mobile.icon naming a missing file is an error, not a silent fallback", async () => {
  const dir = await tree({
    "denext.config.ts": `export default { mobile: { icon: "./nope.png" } };\n`,
    "public/apple-touch-icon.png": await png(180),
  });
  try {
    await assertRejects(() => resolveIconSource(dir), Error, "mobile.icon in denext.config names");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("icon source: Expo app.json — icon, adaptiveIcon layers and colour, splash", async () => {
  const dir = await tree({
    "app.json": JSON.stringify({
      expo: {
        // Not assets/icon.png, which the Capacitor convention (rule 2) would take first.
        icon: "./assets/app-icon.png",
        splash: { image: "./assets/splash-icon.png", backgroundColor: "#ffffff" },
        android: {
          adaptiveIcon: {
            foregroundImage: "./assets/adaptive-fg.png",
            backgroundColor: "#347FF8",
            backgroundImage: "./assets/adaptive-bg.png",
            monochromeImage: "./assets/mono.png",
          },
        },
        plugins: [["expo-splash-screen", { dark: { backgroundColor: "#0a0a0a" } }]],
      },
    }),
    "assets/app-icon.png": await png(1024),
    "assets/adaptive-fg.png": await png(432),
    "assets/adaptive-bg.png": await png(432),
    "assets/mono.png": await png(432),
    "assets/splash-icon.png": await png(200),
  });
  try {
    const source = (await resolveIconSource(dir)).source!;
    assertEquals(source.kind, "expo");
    assertEquals(source.from, "app.json");
    assertEquals(source.icon, join(dir, "assets/app-icon.png"));
    assertEquals(source.background, "#347ff8");
    assertEquals(source.backgroundFrom, "android.adaptiveIcon.backgroundColor");
    assertEquals(source.iconForeground, join(dir, "assets/adaptive-fg.png"));
    assertEquals(source.iconBackgroundImage, join(dir, "assets/adaptive-bg.png"));
    assertEquals(source.iconMonochrome, join(dir, "assets/mono.png"));
    assertEquals(source.splashIcon, join(dir, "assets/splash-icon.png"));
    assertEquals(source.splashBackground, "#ffffff");
    assertEquals(source.darkBackground, "#0a0a0a");
    assertEquals(mobileIconConfig(dir, source), {
      icon: "./assets/app-icon.png",
      backgroundColor: "#347ff8",
      adaptiveIcon: {
        foreground: "./assets/adaptive-fg.png",
        backgroundImage: "./assets/adaptive-bg.png",
        monochrome: "./assets/mono.png",
      },
      splashIcon: "./assets/splash-icon.png",
      splashBackgroundColor: "#ffffff",
      darkBackgroundColor: "#0a0a0a",
    });

    // The Expo adaptive layers reach the Android output: a background image layer per density,
    // referenced by the adaptive XML, and the monochrome layer from its own image.
    await Deno.mkdir(join(dir, "android"));
    const report = await generateMobileAssets(dir, {
      icon: source.icon,
      iconForeground: source.iconForeground,
      iconBackgroundImage: source.iconBackgroundImage,
      iconMonochrome: source.iconMonochrome,
      background: { r: 52, g: 127, b: 248 },
    }, { platforms: ["android"], kinds: ["icon"] });
    assert(report.files.every((f) => !f.path.includes("splash")), "icons only");
    const res = join(dir, "android/app/src/main/res");
    assertEquals(
      ihdr(await Deno.readFile(join(res, "mipmap-xxxhdpi/ic_launcher_background.png"))).width,
      432,
    );
    assertStringIncludes(
      await Deno.readTextFile(join(res, "mipmap-anydpi-v26/ic_launcher.xml")),
      "@mipmap/ic_launcher_background",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A t3code-shaped monorepo: apps/web (a Vite SPA) beside apps/mobile (an Expo app). */
async function monorepo(mobileConfig: string, extra: Files = {}): Promise<string> {
  return await tree({
    "package.json": JSON.stringify({ name: "mono", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "scripts/lib/brand-assets.ts":
      `export const BRAND_ASSET_PATHS = { productionIosIconPng: "assets/prod/icon.png" } as const;\n`,
    "assets/prod/icon.png": await png(1024),
    "apps/mobile/package.json": JSON.stringify({ dependencies: { expo: "^54.0.0" } }),
    "apps/mobile/app.config.ts": mobileConfig,
    "apps/mobile/assets/literal-icon.png": await png(1024),
    "apps/web/package.json": JSON.stringify({
      name: "web",
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
      devDependencies: { vite: "^7.0.0" },
    }),
    "apps/web/vite.config.ts": "export default {};\n",
    "apps/web/index.html": `<!doctype html><html><head><title>T3</title>
<link rel="icon" href="/favicon.ico" sizes="48x48" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
</head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
    "apps/web/src/main.tsx": "export {};\n",
    "apps/web/capacitor.config.ts":
      `export default { appId: "com.example.t3", appName: "T3", webDir: "out" };\n`,
    "apps/web/public/manifest.webmanifest": MANIFEST([
      { src: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ]),
    "apps/web/public/apple-touch-icon.png": await png(180, 180, { hole: true }),
    "apps/web/public/favicon-32x32.png": await png(32),
    "apps/web/public/favicon.ico": "ico",
    ...extra,
  });
}

/** Expo's dynamic config with the icon computed from an imported constant (t3code's shape). */
const COMPUTED_CONFIG = `import { BRAND_ASSET_PATHS } from "../../scripts/lib/brand-assets.ts";
const fromRepoRoot = (p: string) => \`../../\${p}\`;
const ASSETS = { appIcon: fromRepoRoot(BRAND_ASSET_PATHS.productionIosIconPng) } as const;
const variant = { assets: ASSETS };
const config = {
  name: "T3 Code",
  icon: variant.assets.appIcon,
  android: { adaptiveIcon: { backgroundColor: "#000000", foregroundImage: variant.assets.appIcon } },
};
export default config;
`;

Deno.test("icon source: a sibling app.config.ts with a literal icon path is resolved", async () => {
  const dir = await monorepo(
    `export default { expo: { name: "M", icon: "./assets/literal-icon.png" } };\n`,
  );
  try {
    const search = await resolveIconSource(join(dir, "apps/web"));
    assertEquals(search.source?.kind, "expo");
    assertEquals(search.source?.from, "../mobile/app.config.ts");
    assertEquals(search.source?.icon, join(dir, "apps/mobile/assets/literal-icon.png"));
    assertEquals(
      mobileIconConfig(join(dir, "apps/web"), search.source!).icon,
      "../mobile/assets/literal-icon.png",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("icon source: a computed app.config.ts icon falls through to the web icons, with a note", async () => {
  const dir = await monorepo(COMPUTED_CONFIG);
  try {
    const search = await resolveIconSource(join(dir, "apps/web"));
    // The manifest's largest square icon (180, the apple-touch-icon), not the 32px favicon.
    assertEquals(search.source?.kind, "manifest");
    assertEquals(search.source?.icon, join(dir, "apps/web/public/apple-touch-icon.png"));
    assertEquals([search.source?.width, search.source?.height], [180, 180]);
    assertEquals(search.source?.background, "#161616");
    const notes = search.notes.join("\n");
    assertStringIncludes(
      notes,
      "../mobile/app.config.ts: `icon`, `android.adaptiveIcon.foregroundImage` are computed in code",
    );
    assertStringIncludes(notes, "../mobile: the Expo app config names no usable icon");
    assertStringIncludes(notes, "denext never runs the app config");
    assertStringIncludes(search.hint, "../mobile/app.config.ts");
    const lines = formatIconSearch(search).join("\n");
    assertStringIncludes(lines, "public/apple-touch-icon.png (180×180) from the web manifest");
    assertStringIncludes(lines, "upscaled to the 1024×1024 App Store icon");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("icon source: manifest — the largest square icon, a maskable one as the adaptive foreground", async () => {
  const dir = await tree({
    "index.html": `<html><head><link rel="manifest" href="/app.webmanifest"></head></html>`,
    "public/app.webmanifest": MANIFEST([
      { src: "icons/192.png", sizes: "192x192" },
      { src: "icons/wide.png", sizes: "2048x1024" },
      { src: "icons/1024.png", sizes: "1024x1024", purpose: "any" },
      { src: "icons/mask.png", sizes: "512x512", purpose: "maskable" },
      { src: "icons/logo.svg", sizes: "any", type: "image/svg+xml" },
    ], "white"),
    "public/icons/192.png": await png(192),
    "public/icons/wide.png": await png(2048, 1024),
    "public/icons/1024.png": await png(1024),
    "public/icons/mask.png": await png(512),
    "public/icons/logo.svg": "<svg/>",
  });
  try {
    const search = await resolveIconSource(dir);
    assertEquals(search.source?.icon, join(dir, "public/icons/1024.png"));
    assertEquals(search.source?.iconForeground, join(dir, "public/icons/mask.png"));
    assertEquals(search.source?.background, undefined);
    assertStringIncludes(search.notes.join("\n"), "background_color is not a hex colour");
    // No size warning at 1024.
    assert(!formatIconSearch(search).some((l) => l.startsWith("warning")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("icon source: the apple-touch-icon a link tag names, wherever it lives", async () => {
  const dir = await tree({
    "index.html":
      `<html><head><link href="/brand/touch.png" rel="apple-touch-icon" sizes="180x180"></head></html>`,
    "public/brand/touch.png": await png(180),
    "public/favicon.png": await png(64),
  });
  try {
    const { source } = await resolveIconSource(dir);
    assertEquals(source?.kind, "apple-touch-icon");
    assertEquals(source?.icon, join(dir, "public/brand/touch.png"));
    assertEquals(source?.from, `index.html <link rel="apple-touch-icon">`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile assets: a 180px icon is upscaled to 1024 with a warning; transparency is flattened", async () => {
  const dir = await monorepo(COMPUTED_CONFIG);
  const web = join(dir, "apps/web");
  try {
    await Deno.mkdir(join(web, "ios"));
    const search = await resolveIconSource(web);
    const s = search.source!;
    const report = await generateMobileAssets(web, {
      icon: s.icon,
      background: { r: 0x16, g: 0x16, b: 0x16 },
      backgroundFrom: s.backgroundFrom,
      hint: search.hint,
    }, { platforms: ["ios"] });
    const warnings = report.warnings.join("\n");
    assertStringIncludes(
      warnings,
      "the icon is 180×180: it is UPSCALED to the 1024×1024 App Store",
    );
    assertStringIncludes(warnings, "../mobile/app.config.ts");
    assertStringIncludes(
      warnings,
      "flattened onto #161616 (public/manifest.webmanifest background_color)",
    );

    const bytes = await Deno.readFile(
      join(web, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"),
    );
    assertEquals(ihdr(bytes), { width: 1024, height: 1024, colorType: 2 });
    const icon = await decodeImage(bytes);
    // The transparent corner became the manifest's background; the rest stays the icon colour.
    assertEquals([...icon.px.subarray(0, 3)], [0x16, 0x16, 0x16]);
    const mid = (512 * 1024 + 512) * 4;
    assertEquals([...icon.px.subarray(mid, mid + 3)], [220, 20, 60]);
    for (const n of ["", "-1", "-2"]) {
      const splash = await Deno.readFile(
        join(web, `ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732${n}.png`),
      );
      assertEquals(ihdr(splash), { width: 2732, height: 2732, colorType: 2 });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const PLACEHOLDER_IOS = new URL(
  "./fixtures/capacitor8/placeholder/AppIcon-512@2x.png",
  import.meta.url,
);
const PLACEHOLDER_ANDROID = new URL(
  "./fixtures/capacitor8/placeholder/ic_launcher-mdpi.png",
  import.meta.url,
);
const APPICON = "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png";
const MDPI = "android/app/src/main/res/mipmap-mdpi/ic_launcher.png";

/** A Capacitor project fresh from `npx cap add`: the placeholder icons. */
async function placeholderProject(extra: Files = {}): Promise<string> {
  return await tree({
    "capacitor.config.json": JSON.stringify({ appId: "dev.example", appName: "Ex", webDir: "out" }),
    "ios/App/App/Info.plist": `<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>`,
    "ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json": JSON.stringify({
      images: [{ filename: "AppIcon-512@2x.png", idiom: "universal" }],
    }),
    [APPICON]: await Deno.readFile(PLACEHOLDER_IOS),
    "ios/App/App/Base.lproj/LaunchScreen.storyboard": "<document/>",
    "android/app/src/main/AndroidManifest.xml": "<manifest><application></application></manifest>",
    [MDPI]: await Deno.readFile(PLACEHOLDER_ANDROID),
    "android/app/src/main/res/drawable/splash.png": "png",
    ...extra,
  });
}

Deno.test("mobile doctor --store: Capacitor's placeholder icon is an error until it is replaced", async () => {
  const dir = await placeholderProject();
  try {
    assertEquals(await capacitorPlaceholders(dir, "ios", "icon"), [APPICON]);
    assertEquals(await capacitorPlaceholders(dir, "android", "icon"), [MDPI]);
    const before = await runMobileDoctor({ root: dir, profile: "store" });
    const placeholder = before.findings.filter((f) => f.message.includes("placeholder icon"));
    assertEquals(placeholder.map((f) => [f.check, f.level]), [
      ["app-icons", "error"],
      ["app-icons", "error"],
    ]);
    assertStringIncludes(placeholder[0].message, APPICON);
    assertStringIncludes(placeholder[1].message, MDPI);
    assertStringIncludes(placeholder[0].fix, "denext mobile assets");

    await write(dir, { "public/apple-touch-icon.png": await png(180) });
    const { source } = await resolveIconSource(dir);
    await generateMobileAssets(dir, {
      icon: source!.icon,
      background: { r: 255, g: 255, b: 255 },
    }, { kinds: ["icon"] });
    assertEquals(await capacitorPlaceholders(dir, "ios", "icon"), []);
    const after = await runMobileDoctor({ root: dir, profile: "store" });
    assertEquals(after.findings.filter((f) => f.message.includes("placeholder")), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Run the `mobile` verb, capturing console.log. */
async function runVerb(positionals: string[], flags: Record<string, string | boolean>) {
  const { createMobileCommand } = await import("../src/cli/commands/mobile.ts");
  const log = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await createMobileCommand().run({
      positionals,
      flags,
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    });
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

Deno.test("denext mobile assets / build --dry-run: no --icon resolves the project's icon and says which", async () => {
  const dir = await placeholderProject({
    "public/manifest.webmanifest": MANIFEST([{ src: "/apple-touch-icon.png", sizes: "180x180" }]),
    "public/apple-touch-icon.png": await png(180),
  });
  try {
    const assets = await runVerb(["assets"], { dir, "dry-run": true, platform: "ios" });
    assertStringIncludes(
      assets,
      "icon source: public/apple-touch-icon.png (180×180) from the web manifest",
    );
    assertStringIncludes(assets, "background #161616");
    assertStringIncludes(assets, "UPSCALED");

    const { replacePlaceholderIcons } = await import("../src/cli/commands/mobile-build.ts");
    const lines: string[] = [];
    const ctx = {
      positionals: ["build", "ios"],
      flags: { dir },
      global: { json: false, verbose: false, quiet: false },
      rest: [],
    };
    await replacePlaceholderIcons(ctx, dir, "ios", true, (l) => lines.push(l));
    assertStringIncludes(lines.join("\n"), "ios has Capacitor's placeholder icon: would replace");
    assertEquals(await capacitorPlaceholders(dir, "ios", "icon"), [APPICON], "dry run");
    await replacePlaceholderIcons(ctx, dir, "ios", false, (l) => lines.push(l));
    assertEquals(await capacitorPlaceholders(dir, "ios", "icon"), []);
    assertEquals(
      ihdr(await Deno.readFile(join(dir, APPICON))),
      { width: 1024, height: 1024, colorType: 2 },
    );
    // Android was not built, so its placeholder stays for `mobile build android`.
    assertEquals(await capacitorPlaceholders(dir, "android", "icon"), [MDPI]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext migrate (t3code layout): the icon is recorded as mobile.icon and reported", async () => {
  const dir = await monorepo(COMPUTED_CONFIG);
  const web = join(dir, "apps/web");
  try {
    const check = await checkMigration(web);
    assertEquals(check.appIcon?.icon, "./public/apple-touch-icon.png");
    assertEquals(check.appIcon?.kind, "manifest");
    // A Capacitor app whose icon is upscaled for the App Store gets a review item.
    const small = check.review.find((f) => f.item === "app icon ./public/apple-touch-icon.png");
    assertStringIncludes(small?.reason ?? "", "upscaled to the 1024×1024 App Store icon");
    assertStringIncludes(
      check.appIcon!.lines.join("\n"),
      "`icon`, `android.adaptiveIcon.foregroundImage` are computed",
    );

    const result = await migrateProject(web);
    assertEquals(result.spa?.appIcon?.recorded, true);
    const config = await Deno.readTextFile(join(web, "denext.config.ts"));
    assertStringIncludes(config, `    icon: "./public/apple-touch-icon.png",\n`);
    assertStringIncludes(config, `    backgroundColor: "#161616",\n`);
    assertStringIncludes(config, "found by migrate\n  // in public/manifest.webmanifest");
    // The recorded icon is what the resolver now picks first, so later builds are deterministic.
    const again = await resolveIconSource(web);
    assertEquals(again.source?.kind, "config");
    assertEquals(again.source?.icon, join(web, "public/apple-touch-icon.png"));
    assertEquals(again.source?.background, "#161616");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext migrate --check: a Capacitor app with no icon gets a review item", async () => {
  const dir = await monorepo(COMPUTED_CONFIG);
  const web = join(dir, "apps/web");
  try {
    for (
      const f of [
        "public/apple-touch-icon.png",
        "public/favicon-32x32.png",
        "public/manifest.webmanifest",
      ]
    ) await Deno.remove(join(web, f));
    const check = await checkMigration(web);
    assertEquals(check.appIcon?.icon, null);
    const item = check.review.find((f) => f.item === "app icon");
    assert(item, JSON.stringify(check.review));
    assertStringIncludes(item.reason, "Capacitor's placeholder icon");
    assertEquals(check.verdict, "review");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denext migrate --from expo: the app's own icon is recorded with its adaptive layers", async () => {
  const dir = await tree({
    "package.json": JSON.stringify({
      name: "exp",
      main: "index.ts",
      dependencies: { expo: "^54.0.0", react: "^19.0.0", "react-native": "^0.81.0" },
    }),
    "index.ts": "export {};\n",
    "app.json": JSON.stringify({
      expo: {
        name: "Exp",
        icon: "./art/icon.png",
        android: {
          adaptiveIcon: { foregroundImage: "./art/fg.png", backgroundColor: "#112233" },
        },
      },
    }),
    "art/icon.png": await png(1024),
    "art/fg.png": await png(432),
  });
  try {
    const result = await migrateProject(dir, { from: "expo" });
    assertEquals(result.spa?.appIcon?.kind, "expo");
    const config = await Deno.readTextFile(join(dir, "denext.config.ts"));
    assertStringIncludes(config, `    icon: "./art/icon.png",\n`);
    assertStringIncludes(config, `    backgroundColor: "#112233",\n`);
    assertStringIncludes(config, `    adaptiveIcon: { foreground: "./art/fg.png" },\n`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
