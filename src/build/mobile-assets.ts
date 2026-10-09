// `denext mobile assets`: every iOS and Android icon and splash a Capacitor shell ships, from
// one icon (and optionally a splash, a foreground layer and dark variants).
//
//   iOS      ios/App/App/Assets.xcassets/AppIcon.appiconset   AppIcon-512@2x.png (1024², RGB:
//            App Store Connect refuses an icon with an alpha channel) + a dark variant (iOS 18)
//            ios/App/App/Assets.xcassets/Splash.imageset      splash-2732x2732{,-1,-2}.png, and
//            the -dark set (Contents.json `appearances: luminosity dark`)
//   Android  mipmap-{m,h,xh,xxh,xxxh}dpi  ic_launcher.png (legacy), ic_launcher_round.png,
//            ic_launcher_foreground.png + ic_launcher_monochrome.png (the adaptive layers, 108dp)
//            mipmap-anydpi-v26            ic_launcher.xml / ic_launcher_round.xml
//            values/ic_launcher_background.xml   the adaptive background colour
//            drawable{,-port-*,-land-*}   splash.png, and drawable-night… for the dark splash
//
// Image work is @denext/photon (decode, Lanczos resize) plus ./png-raster.ts (compose, encode):
// no npm, no native tools. Nothing here loads the project's modules.

import { dirname, join } from "@std/path";
import { posixRelative } from "./mobile-paths.ts";
import {
  circleMasked,
  coverInto,
  decodeImage,
  drawOver,
  encodePng,
  fitInto,
  flatten,
  hexOf,
  parseHexColor,
  type Raster,
  resizeRaster,
  type Rgb,
  silhouette,
  solid,
} from "./png-raster.ts";

/** Android's density buckets and their scale over mdpi. */
const DENSITIES = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
] as const;

/** Capacitor's Android splash sizes (portrait; landscape swaps them), per density. */
const ANDROID_SPLASH: Record<string, readonly [number, number]> = {
  mdpi: [320, 480],
  hdpi: [480, 800],
  xhdpi: [720, 1280],
  xxhdpi: [960, 1600],
  xxxhdpi: [1280, 1920],
};

/** The iOS splash side (Capacitor's template: one universal square at three scales). */
const IOS_SPLASH = 2732;

/** Share of the splash's short side the icon takes when there is no splash image. */
const SPLASH_ICON_RATIO = 0.3;

/** Share of the 108dp adaptive canvas a full-bleed icon is scaled into (the 72dp viewport). */
const ADAPTIVE_VIEWPORT = 72 / 108;

/** The icon / splash sources and colours, resolved. */
export interface AssetSources {
  /** The app icon: a square, ideally 1024² or larger, full bleed. */
  readonly icon: string;
  /** Android's adaptive foreground (a logo on transparency, 108dp canvas); default: the icon. */
  readonly iconForeground?: string;
  /** Android's adaptive background image (108dp, full bleed); default: the background colour. */
  readonly iconBackgroundImage?: string;
  /** Android 13's themed-icon layer (a silhouette is made of it); default: the foreground. */
  readonly iconMonochrome?: string;
  /** The dark-appearance icon (iOS 18); none when omitted. */
  readonly iconDark?: string;
  /** The splash (a square, ideally 2732²); default: the icon centred on the background. */
  readonly splash?: string;
  /** The logo centred on the splash background when there is no splash image; default: the icon. */
  readonly splashIcon?: string;
  /** The dark splash; default when `darkBackground` is set: the icon on it. */
  readonly splashDark?: string;
  /** The icon and splash background. */
  readonly background: Rgb;
  /** Where {@linkcode AssetSources.background} came from, for the transparency warning. */
  readonly backgroundFrom?: string;
  /** The splash background, when it differs from the icon's; default: `background`. */
  readonly splashBackground?: Rgb;
  /** The dark splash background; dark variants are written only with it or `splashDark`. */
  readonly darkBackground?: Rgb;
  /** What to add for a sharper icon, named in the warning when the icon is under 1024². */
  readonly hint?: string;
}

/** Which platforms to write. */
export type AssetPlatform = "ios" | "android";

/** One file `mobile assets` writes. */
export interface PlannedAsset {
  /** Path relative to the Capacitor project. */
  readonly path: string;
  /** What it is, for the listing. */
  readonly what: string;
  /** Pixel size (`w×h`), or undefined for a JSON / XML file. */
  readonly size?: string;
}

/** What {@linkcode generateMobileAssets} did (or, in a dry run, would do). */
export interface AssetsReport {
  readonly root: string;
  readonly platforms: readonly AssetPlatform[];
  readonly files: readonly PlannedAsset[];
  readonly warnings: readonly string[];
  /**
   * Images the previous Splash.imageset `Contents.json` referenced and the new one does not
   * (paths relative to the project): removed, or in a dry run, to be removed.
   */
  readonly removed: readonly string[];
  readonly dryRun: boolean;
}

/** The conventional source names, looked for in `assets/` then `resources/`. */
const SOURCE_NAMES: Record<string, readonly string[]> = {
  icon: ["icon.png", "icon-only.png", "icon.jpg"],
  iconForeground: ["icon-foreground.png"],
  iconDark: ["icon-dark.png"],
  splash: ["splash.png", "splash.jpg"],
  splashDark: ["splash-dark.png", "splash-dark.jpg"],
};

/** Whether `path` is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * The first conventional source for `kind` under `root` (`assets/<name>`, then `resources/`).
 *
 * @param root The Capacitor project.
 * @param kind A key of the source names (`icon`, `splash`, …).
 * @returns The path, or undefined.
 */
export async function findAssetSource(root: string, kind: string): Promise<string | undefined> {
  for (const dir of ["assets", "resources"]) {
    for (const name of SOURCE_NAMES[kind] ?? []) {
      const path = join(root, dir, name);
      if (await isFile(path)) return path;
    }
  }
  return undefined;
}

/**
 * Parse a colour flag, throwing a message that names it.
 *
 * @param value The flag's value.
 * @param flag The flag, for the message.
 */
export function colorFlag(value: string, flag: string): Rgb {
  const color = parseHexColor(value);
  if (!color) {
    throw new Error(`${flag} takes a hex colour like #0f172a (got ${JSON.stringify(value)})`);
  }
  return color;
}

/** One output: the path, a label and how to make its bytes. */
interface Job extends PlannedAsset {
  readonly make: () => Promise<Uint8Array>;
  /**
   * For an asset catalog's `Contents.json` that replaces the set's images: the file names the
   * new one references. The previous one's other images are removed (see `supersededImages`).
   */
  readonly replacesImages?: readonly string[];
}

/** Decoded sources, and their resized copies, each made once. */
class Sources {
  #cache = new Map<string, Promise<Raster>>();
  constructor(readonly spec: AssetSources) {}
  #memo(key: string, make: () => Promise<Raster>): Promise<Raster> {
    let hit = this.#cache.get(key);
    if (!hit) this.#cache.set(key, hit = make());
    return hit;
  }
  load(path: string): Promise<Raster> {
    return this.#memo(path, () =>
      Deno.readFile(path).then(decodeImage).catch((err) => {
        throw new Error(`${path}: cannot decode it (${err instanceof Error ? err.message : err})`);
      }));
  }
  /** `path` stretched to `w`×`h`. */
  resized(path: string, w: number, h: number): Promise<Raster> {
    return this.#memo(`${path}|${w}x${h}`, async () => resizeRaster(await this.load(path), w, h));
  }
  /** `path` fitted into a transparent `box`². */
  fitted(path: string, box: number): Promise<Raster> {
    return this.#memo(`${path}|fit${box}`, async () => fitInto(await this.load(path), box));
  }
}

/** A splash: the splash image covering the size, else the icon centred on the background. */
async function splashRaster(
  src: Sources,
  image: string | undefined,
  background: Rgb,
  width: number,
  height: number,
): Promise<Raster> {
  if (image) return flatten(await coverInto(await src.load(image), width, height), background);
  const canvas = solid(width, height, background);
  const box = Math.round(Math.min(width, height) * SPLASH_ICON_RATIO);
  const icon = await src.fitted(src.spec.splashIcon ?? src.spec.icon, box);
  drawOver(canvas, icon, (width - box) >> 1, (height - box) >> 1);
  return canvas;
}

/** A JSON file's bytes. */
function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}

const APPICONSET = "ios/App/App/Assets.xcassets/AppIcon.appiconset";
const SPLASHSET = "ios/App/App/Assets.xcassets/Splash.imageset";
const DARK = [{ appearance: "luminosity", value: "dark" }];

/** The iOS icon (and its dark variant) plus the asset catalog's Contents.json. */
function iosIconJobs(src: Sources): Job[] {
  const { spec } = src;
  const jobs: Job[] = [{
    path: `${APPICONSET}/AppIcon-512@2x.png`,
    what: "App icon (RGB, no alpha)",
    size: "1024×1024",
    make: async () =>
      await encodePng(flatten(await src.resized(spec.icon, 1024, 1024), spec.background), {
        alpha: false,
      }),
  }];
  const images: Record<string, unknown>[] = [
    { filename: "AppIcon-512@2x.png", idiom: "universal", platform: "ios", size: "1024x1024" },
  ];
  if (spec.iconDark) {
    const dark = spec.iconDark;
    jobs.push({
      path: `${APPICONSET}/AppIcon-512@2x-dark.png`,
      what: "App icon, dark appearance",
      size: "1024×1024",
      make: async () => await encodePng(await src.resized(dark, 1024, 1024)),
    });
    images.push({ ...images[0], filename: "AppIcon-512@2x-dark.png", appearances: DARK });
  }
  jobs.push({
    path: `${APPICONSET}/Contents.json`,
    what: "asset catalog",
    make: () => Promise.resolve(jsonBytes({ images, info: { author: "xcode", version: 1 } })),
  });
  return jobs;
}

/** The iOS splash set (three scales of one square) and its dark twin. */
function iosSplashJobs(src: Sources): Job[] {
  const { spec } = src;
  const variants: { suffix: string; image?: string; bg: Rgb; dark: boolean }[] = [
    { suffix: "", image: spec.splash, bg: spec.splashBackground ?? spec.background, dark: false },
  ];
  if (spec.splashDark || spec.darkBackground) {
    variants.push({
      suffix: "-dark",
      image: spec.splashDark,
      bg: spec.darkBackground ?? spec.background,
      dark: true,
    });
  }
  const jobs: Job[] = [];
  const images: Record<string, unknown>[] = [];
  for (const v of variants) {
    let bytes: Promise<Uint8Array> | undefined;
    const make = () =>
      bytes ??= splashRaster(src, v.image, v.bg, IOS_SPLASH, IOS_SPLASH).then((r) =>
        encodePng(r, { alpha: false })
      );
    ["", "-1", "-2"].forEach((n, i) => {
      const filename = `splash-2732x2732${n}${v.suffix}.png`;
      jobs.push({
        path: `${SPLASHSET}/${filename}`,
        what: `splash${v.dark ? ", dark" : ""} @${3 - i}x`,
        size: "2732×2732",
        make,
      });
      images.push({
        idiom: "universal",
        filename,
        scale: `${3 - i}x`,
        ...(v.dark ? { appearances: DARK } : {}),
      });
    });
  }
  jobs.push({
    path: `${SPLASHSET}/Contents.json`,
    what: "asset catalog",
    make: () => Promise.resolve(jsonBytes({ images, info: { version: 1, author: "xcode" } })),
    replacesImages: images.map((image) => String(image.filename)),
  });
  return jobs;
}

/** Whether `name` is a file name inside its folder (no separator, not `.` / `..`). */
function isPlainFileName(name: unknown): name is string {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." &&
    !/[\\/]/.test(name);
}

/**
 * The images a catalog's current `Contents.json` references that its replacement does not:
 * plain file names in the set's folder (a name with a path separator, or `..`, is never
 * touched), that exist as files. A missing or unreadable `Contents.json` supersedes nothing.
 *
 * @param root The Capacitor project.
 * @param contents The `Contents.json` path, relative to `root`.
 * @param keep The file names the new `Contents.json` references.
 * @returns The superseded images, relative to `root`.
 */
async function supersededImages(
  root: string,
  contents: string,
  keep: readonly string[],
): Promise<string[]> {
  let images: unknown;
  try {
    images = (JSON.parse(await Deno.readTextFile(join(root, contents))) as { images?: unknown })
      .images;
  } catch {
    return [];
  }
  if (!Array.isArray(images)) return [];
  const set = dirname(contents);
  const names = new Set<string>();
  for (const image of images) {
    const name = (image as { filename?: unknown } | null)?.filename;
    if (isPlainFileName(name) && !keep.includes(name)) names.add(name);
  }
  const out: string[] = [];
  for (const name of names) if (await isFile(join(root, set, name))) out.push(`${set}/${name}`);
  return out;
}

const RES = "android/app/src/main/res";

/** The adaptive foreground at `size` px: an explicit layer fills the canvas, an icon the 72dp viewport. */
async function foreground(src: Sources, size: number): Promise<Raster> {
  const { spec } = src;
  if (spec.iconForeground) return await src.fitted(spec.iconForeground, size);
  const inner = Math.round(size * ADAPTIVE_VIEWPORT);
  const canvas = solid(size, size);
  drawOver(canvas, await src.fitted(spec.icon, inner), (size - inner) >> 1, (size - inner) >> 1);
  return canvas;
}

/** Android launcher icons: legacy + round per density, and the adaptive layers. */
function androidIconJobs(src: Sources): Job[] {
  const { spec } = src;
  const jobs: Job[] = [];
  for (const [density, scale] of DENSITIES) {
    const legacy = 48 * scale;
    const layer = 108 * scale;
    const dir = `${RES}/mipmap-${density}`;
    const square = async () =>
      flatten(await src.resized(spec.icon, legacy, legacy), spec.background);
    jobs.push(
      {
        path: `${dir}/ic_launcher.png`,
        what: "launcher icon (legacy)",
        size: `${legacy}×${legacy}`,
        make: async () => await encodePng(await square()),
      },
      {
        path: `${dir}/ic_launcher_round.png`,
        what: "launcher icon (round)",
        size: `${legacy}×${legacy}`,
        make: async () => await encodePng(circleMasked(await square())),
      },
      {
        path: `${dir}/ic_launcher_foreground.png`,
        what: "adaptive foreground",
        size: `${layer}×${layer}`,
        make: async () => await encodePng(await foreground(src, layer)),
      },
      {
        path: `${dir}/ic_launcher_monochrome.png`,
        what: "themed icon (Android 13+)",
        size: `${layer}×${layer}`,
        make: async () =>
          await encodePng(
            silhouette(
              spec.iconMonochrome
                ? await src.fitted(spec.iconMonochrome, layer)
                : await foreground(src, layer),
            ),
          ),
      },
    );
    const backgroundImage = spec.iconBackgroundImage;
    if (backgroundImage) {
      jobs.push({
        path: `${dir}/ic_launcher_background.png`,
        what: "adaptive background",
        size: `${layer}×${layer}`,
        make: async () =>
          await encodePng(await coverInto(await src.load(backgroundImage), layer, layer)),
      });
    }
  }
  const background = spec.iconBackgroundImage
    ? "@mipmap/ic_launcher_background"
    : "@color/ic_launcher_background";
  const adaptive = new TextEncoder().encode(
    `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="${background}" />
  <foreground android:drawable="@mipmap/ic_launcher_foreground" />
  <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />
</adaptive-icon>
`,
  );
  for (const name of ["ic_launcher", "ic_launcher_round"]) {
    jobs.push({
      path: `${RES}/mipmap-anydpi-v26/${name}.xml`,
      what: "adaptive icon",
      make: () => Promise.resolve(adaptive),
    });
  }
  jobs.push({
    path: `${RES}/values/ic_launcher_background.xml`,
    what: `adaptive background ${hexOf(spec.background)}`,
    make: () =>
      Promise.resolve(
        new TextEncoder().encode(
          `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${
            hexOf(spec.background)
          }</color>\n</resources>\n`,
        ),
      ),
  });
  return jobs;
}

/** Android splash drawables: the default, then portrait and landscape per density (and night). */
function androidSplashJobs(src: Sources): Job[] {
  const { spec } = src;
  const variants: { night: string; image?: string; bg: Rgb }[] = [
    { night: "", image: spec.splash, bg: spec.splashBackground ?? spec.background },
  ];
  if (spec.splashDark || spec.darkBackground) {
    variants.push({
      night: "-night",
      image: spec.splashDark,
      bg: spec.darkBackground ?? spec.background,
    });
  }
  const jobs: Job[] = [];
  for (const v of variants) {
    const one = (dir: string, w: number, h: number) => ({
      path: `${RES}/${dir}/splash.png`,
      what: `splash${v.night ? ", dark" : ""}`,
      size: `${w}×${h}`,
      make: async () =>
        await encodePng(await splashRaster(src, v.image, v.bg, w, h), { alpha: false }),
    });
    jobs.push(one(`drawable${v.night}`, 480, 320));
    for (const [density] of DENSITIES) {
      const [w, h] = ANDROID_SPLASH[density];
      jobs.push(one(`drawable-port${v.night}-${density}`, w, h));
      jobs.push(one(`drawable-land${v.night}-${density}`, h, w));
    }
  }
  return jobs;
}

/** Whether any pixel of `r` is not fully opaque. */
function hasTransparency(r: Raster): boolean {
  for (let i = 3; i < r.px.length; i += 4) if (r.px[i] !== 255) return true;
  return false;
}

/** The icon's warnings: not square, under 1024² (upscaled), transparent (flattened for iOS). */
function iconWarnings(
  spec: AssetSources,
  icon: Raster,
  platforms: readonly AssetPlatform[],
): string[] {
  const size = `${icon.width}×${icon.height}`;
  const warnings: string[] = [];
  if (icon.width !== icon.height) warnings.push(`the icon is ${size}; it is stretched to a square`);
  if (Math.min(icon.width, icon.height) < 1024) {
    warnings.push(
      `the icon is ${size}: it is UPSCALED to the 1024×1024 App Store icon and will look ` +
        "soft. For a sharp icon, " +
        (spec.hint ?? "pass --icon a 1024×1024 PNG (or save one as assets/icon.png)"),
    );
  }
  if (platforms.includes("ios") && hasTransparency(icon)) {
    const from = spec.backgroundFrom ? ` (${spec.backgroundFrom})` : "";
    warnings.push(
      `the icon has transparent pixels: the iOS icon is flattened onto ` +
        `${hexOf(spec.background)}${from}, since App Store icons cannot have an alpha ` +
        "channel. Use an opaque icon, or set the background colour you want",
    );
  }
  return warnings;
}

/**
 * Warnings about the sources: an icon under 1024² (upscaled for the App Store), one with
 * transparency (flattened, since App Store icons have no alpha), and small splashes.
 */
async function sourceWarnings(
  src: Sources,
  platforms: readonly AssetPlatform[],
): Promise<string[]> {
  const { spec } = src;
  const warnings = iconWarnings(spec, await src.load(spec.icon), platforms);
  for (const path of [spec.splash, spec.splashDark]) {
    if (!path) continue;
    const s = await src.load(path);
    if (Math.min(s.width, s.height) < IOS_SPLASH) {
      warnings.push(
        `${path} is ${s.width}×${s.height}; ${IOS_SPLASH}×${IOS_SPLASH} avoids upscaling`,
      );
    }
  }
  return warnings;
}

/** The jobs for each platform and kind asked for. */
function assetJobs(
  src: Sources,
  platforms: readonly AssetPlatform[],
  kinds: readonly ("icon" | "splash")[],
): Job[] {
  const makers: Record<string, (src: Sources) => Job[]> = {
    "ios:icon": iosIconJobs,
    "ios:splash": iosSplashJobs,
    "android:icon": androidIconJobs,
    "android:splash": androidSplashJobs,
  };
  return (["ios", "android"] as const).flatMap((p) =>
    platforms.includes(p) ? kinds.flatMap((k) => makers[`${p}:${k}`](src)) : []
  );
}

/** Whether `root/<dir>` exists as a directory. */
async function hasDir(root: string, dir: string): Promise<boolean> {
  try {
    return (await Deno.stat(join(root, dir))).isDirectory;
  } catch {
    return false;
  }
}

/**
 * Generate every icon and splash for the platforms whose native project exists.
 *
 * @param root The Capacitor project (with `ios/` and / or `android/`).
 * @param spec The sources and colours.
 * @param opts `platforms` limits the output; `kinds` to the icons or the splash (default
 *   both); `dryRun` lists the files and writes nothing.
 * @returns What was (or would be) written, and warnings about the sources.
 * @throws {Error} When a source cannot be read or decoded, or no native project exists.
 */
export async function generateMobileAssets(
  root: string,
  spec: AssetSources,
  opts: {
    platforms?: readonly AssetPlatform[];
    kinds?: readonly ("icon" | "splash")[];
    dryRun?: boolean;
  } = {},
): Promise<AssetsReport> {
  const wanted = opts.platforms ?? ["ios", "android"];
  const platforms: AssetPlatform[] = [];
  for (const p of wanted) if (await hasDir(root, p)) platforms.push(p);
  if (platforms.length === 0) {
    throw new Error(
      `no ${
        wanted.join(" or ")
      } project in ${root} (run \`npx cap add ios\` / \`npx cap add android\` first)`,
    );
  }
  const src = new Sources(spec);
  const warnings = await sourceWarnings(src, platforms);
  const jobs = assetJobs(src, platforms, opts.kinds ?? ["icon", "splash"]);
  // Read the catalogs being replaced before writing over them.
  const removed: string[] = [];
  for (const job of jobs) {
    if (job.replacesImages) {
      removed.push(...await supersededImages(root, job.path, job.replacesImages));
    }
  }
  if (!opts.dryRun) {
    for (const job of jobs) {
      const path = join(root, job.path);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeFile(path, await job.make());
    }
    for (const path of removed) await Deno.remove(join(root, path));
  }
  const files = jobs.map(({ path, what, size }) => (size ? { path, what, size } : { path, what }));
  return { root, platforms, files, warnings, removed, dryRun: opts.dryRun === true };
}

/**
 * The report as the listing `denext mobile assets` prints.
 *
 * @param report What {@linkcode generateMobileAssets} returned.
 * @returns The lines, joined.
 */
export function formatAssetsReport(report: AssetsReport): string {
  const verb = report.dryRun ? "would write" : "wrote";
  const lines = report.files.map((f) =>
    `  ${verb}  ${posixRelative(report.root, join(report.root, f.path))}  ${f.size ?? ""} ${f.what}`
      .trimEnd()
  );
  const remove = report.dryRun ? "would remove" : "removed";
  for (const path of report.removed) {
    lines.push(
      `  ${remove}  ${
        posixRelative(report.root, join(report.root, path))
      }  (no longer in the splash catalog)`,
    );
  }
  for (const w of report.warnings) lines.push(`  warning: ${w}`);
  lines.push(
    "",
    `  ${report.files.length} files for ${report.platforms.join(" + ")}.` +
      (report.dryRun
        ? " Nothing was written."
        : " Rebuild the app to see them (icons and splash are native)."),
  );
  return lines.join("\n");
}
