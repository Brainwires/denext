// Where a Capacitor shell's app icon comes from when `denext mobile assets` is given none: the
// icon the project already has, found without running any of its code. In priority order:
//
//   config            `mobile.icon` in denext.config.* (read statically, never imported)
//   assets            assets/icon.png (or resources/), the Capacitor convention
//   expo              an Expo app config in the project or a sibling app of the same monorepo:
//                     `icon` / `ios.icon` / `android.icon`, `android.adaptiveIcon`, `splash`
//                     (app.json, or app.config.* read statically by ./expo-app-config.ts; a value
//                     computed in code is reported and skipped, never executed)
//   manifest          the web manifest's largest square icon (`purpose: "maskable"` → the
//                     Android adaptive foreground), with `background_color`
//   apple-touch-icon  `<link rel="apple-touch-icon">` in index.html, then public/apple-touch-icon.png
//   favicon           the largest PNG favicon
//
// Every step that is skipped says why (`notes`), so the report names the source it chose and
// what it passed over. The same resolution backs `denext migrate` (which records the choice as
// `mobile.icon`), `denext mobile build` (which replaces Capacitor's placeholder icon) and
// `denext mobile doctor --store` (which flags the placeholder).

import { dirname, extname, join, resolve } from "@std/path";
import { posixRelative } from "./mobile-paths.ts";
import { CONFIG_FILES } from "./paths.ts";
import { readConfigModel } from "./config-edit.ts";
import { type ExpoIcons, readExpoAppConfig, readJsonFile } from "./expo-app-config.ts";
import { decodeImage, parseHexColor } from "./png-raster.ts";

/** Which rule picked the icon. */
export type IconSourceKind =
  | "config"
  | "assets"
  | "expo"
  | "manifest"
  | "apple-touch-icon"
  | "favicon";

/** The icon (and the layers and colours that came with it) the resolver chose. */
export interface IconSource {
  readonly kind: IconSourceKind;
  /** The icon file (absolute). */
  readonly icon: string;
  /** Where it was found, for the report (`public/manifest.webmanifest`, `app.json`, …). */
  readonly from: string;
  /** The icon's pixel size. */
  readonly width: number;
  readonly height: number;
  /** The background (`#rrggbb`): transparency is flattened onto it, the adaptive background. */
  readonly background?: string;
  /** Where the background came from (`background_color`, `android.adaptiveIcon.backgroundColor`). */
  readonly backgroundFrom?: string;
  /** Android's adaptive foreground (absolute). */
  readonly iconForeground?: string;
  /** Android's adaptive background image (absolute). */
  readonly iconBackgroundImage?: string;
  /** Android 13's themed (monochrome) layer (absolute). */
  readonly iconMonochrome?: string;
  /** A logo centred on the splash background (absolute). */
  readonly splashIcon?: string;
  /** The splash background (`#rrggbb`), when it differs from the icon's. */
  readonly splashBackground?: string;
  /** The dark splash background (`#rrggbb`). */
  readonly darkBackground?: string;
}

/** What {@linkcode resolveIconSource} found, and what it passed over and why. */
export interface IconSearch {
  /** The project the paths are reported against. */
  readonly root: string;
  readonly source: IconSource | null;
  readonly notes: readonly string[];
  /**
   * Problems with the chosen icon itself: one that looks pre-masked (rounded corners on
   * transparency), which iOS masks again.
   */
  readonly warnings: readonly string[];
  /** What to add for a sharper icon, when the chosen one is under 1024². */
  readonly hint: string;
}

/** The App Store icon side; a smaller source is upscaled (with a warning). */
const STORE_ICON_SIZE = 1024;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether `path` is a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * A raster image's pixel size: a PNG's from its header, a JPEG / WebP's by decoding it.
 *
 * @param path The image.
 * @returns The size, or null when the file is missing or not a raster the generator reads
 *   (SVG, ICO, an Icon Composer folder).
 */
async function imageSize(path: string): Promise<{ width: number; height: number } | null> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch {
    return null;
  }
  if (bytes.length >= 24 && PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (!/\.(jpe?g|webp)$/i.test(path)) return null;
  try {
    const r = await decodeImage(bytes);
    return { width: r.width, height: r.height };
  } catch {
    return null;
  }
}

/** `value` as `#rrggbb` when it is a hex colour, else undefined. */
function hex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const c = parseHexColor(value);
  return c ? "#" + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("") : undefined;
}

/** The resolver's working state: the project, its notes, and the report's path labels. */
class Search {
  readonly notes: string[] = [];
  hint = "";
  constructor(readonly root: string) {}
  rel(path: string): string {
    return posixRelative(this.root, path);
  }
}

// ---- (a) denext.config `mobile` -----------------------------------------------------------

/** The `mobile` block of denext.config.*, read statically; null when absent or code. */
async function configMobile(s: Search): Promise<Record<string, unknown> | null> {
  for (const name of CONFIG_FILES) {
    let source: string;
    try {
      source = await Deno.readTextFile(join(s.root, name));
    } catch {
      continue;
    }
    const mobile = (await readConfigModel(source)).keys.mobile;
    if (!mobile) return null;
    if (mobile.kind !== "editable" || !mobile.value || typeof mobile.value !== "object") {
      s.notes.push(
        `${name}: \`mobile\` is computed in code, so its icon is not read (denext never ` +
          "runs the config for this); write `mobile.icon` as a plain string",
      );
      return null;
    }
    return mobile.value as Record<string, unknown>;
  }
  return null;
}

/** A config path, resolved against the project. */
function configFile(s: Search, value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? resolve(s.root, value) : undefined;
}

/** (a) `mobile.icon` in denext.config.*. A named icon that is missing or unreadable throws. */
async function fromConfig(s: Search): Promise<IconSource | null> {
  const m = await configMobile(s);
  const icon = configFile(s, m?.icon);
  if (!m || !icon) return null;
  const size = await imageSize(icon);
  if (!size) {
    throw new Error(
      `mobile.icon in denext.config names ${s.rel(icon)}, which is missing or not a PNG / ` +
        "JPEG / WebP",
    );
  }
  const adaptive = (m.adaptiveIcon ?? {}) as Record<string, unknown>;
  const background = hex(m.backgroundColor);
  return {
    kind: "config",
    icon,
    from: "denext.config mobile.icon",
    ...size,
    ...(background ? { background, backgroundFrom: "mobile.backgroundColor" } : {}),
    ...optionalFiles({
      iconForeground: configFile(s, adaptive.foreground),
      iconBackgroundImage: configFile(s, adaptive.backgroundImage),
      iconMonochrome: configFile(s, adaptive.monochrome),
      splashIcon: configFile(s, m.splashIcon),
    }),
    ...optionalColors({
      splashBackground: hex(m.splashBackgroundColor),
      darkBackground: hex(m.darkBackgroundColor),
    }),
  };
}

/** The defined entries of `files`. */
function optionalFiles(files: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) if (v) out[k] = v;
  return out;
}
const optionalColors = optionalFiles;

// ---- (a2) assets/icon.png ------------------------------------------------------------------

/** The Capacitor convention: assets/icon.png (or icon-only.png, icon.jpg), then resources/. */
async function fromAssets(s: Search): Promise<IconSource | null> {
  for (const dir of ["assets", "resources"]) {
    for (const name of ["icon.png", "icon-only.png", "icon.jpg"]) {
      const icon = join(s.root, dir, name);
      const size = await imageSize(icon);
      if (size) return { kind: "assets", icon, from: `${dir}/${name}`, ...size };
    }
  }
  return null;
}

// ---- (b) an Expo app config ----------------------------------------------------------------

const EXPO_CONFIG_FILES = [
  "app.config.ts",
  "app.config.mts",
  "app.config.js",
  "app.config.mjs",
  "app.config.cjs",
];

/** Whether `dir` holds an Expo app config (`app.config.*`, or an app.json with `expo`). */
async function hasExpoConfig(dir: string): Promise<boolean> {
  for (const f of EXPO_CONFIG_FILES) if (await isFile(join(dir, f))) return true;
  const json = await readJsonFile(join(dir, "app.json"));
  return !!json && typeof json.expo === "object" && json.expo !== null;
}

/** Files that make a folder a monorepo root. */
const WORKSPACE_MARKERS = [
  "pnpm-workspace.yaml",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "rush.json",
];

/** Whether `dir` is a monorepo root (a workspace marker, or a manifest declaring workspaces). */
async function isWorkspaceRoot(dir: string): Promise<boolean> {
  for (const f of WORKSPACE_MARKERS) if (await isFile(join(dir, f))) return true;
  const pkg = await readJsonFile(join(dir, "package.json"));
  if (pkg && pkg.workspaces) return true;
  const deno = await readJsonFile(join(dir, "deno.json"));
  return !!deno && Array.isArray(deno.workspace);
}

/** Whether `dir` sits inside a monorepo (a workspace root at most four levels above it). */
async function inMonorepo(dir: string): Promise<boolean> {
  let cur = dirname(dir);
  for (let i = 0; i < 4; i++) {
    if (await isWorkspaceRoot(cur)) return true;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return false;
}

/** The project, then (in a monorepo) its sibling app folders, that hold an Expo app config. */
async function expoDirs(root: string): Promise<string[]> {
  const candidates = [root, ...(await inMonorepo(root) ? await siblingDirs(root) : [])];
  const dirs: string[] = [];
  for (const dir of candidates) if (await hasExpoConfig(dir)) dirs.push(dir);
  return dirs;
}

/** The other app folders beside `root` (sorted; no dot folders, no node_modules). */
async function siblingDirs(root: string): Promise<string[]> {
  const parent = dirname(root);
  const siblings: string[] = [];
  try {
    for await (const e of Deno.readDir(parent)) {
      const skip = !e.isDirectory || e.name.startsWith(".") || e.name === "node_modules";
      if (!skip && join(parent, e.name) !== root) siblings.push(join(parent, e.name));
    }
  } catch { /* unreadable parent: no siblings */ }
  return siblings.sort();
}

/** A raster file an Expo field names, or a note saying why it cannot be used. */
async function expoFile(
  s: Search,
  dir: string,
  label: string,
  key: string,
  value: string | undefined,
): Promise<string | undefined> {
  if (!value) return undefined;
  const path = resolve(dir, value);
  if (await imageSize(path)) return path;
  s.notes.push(
    `${label}: ${key} names ${s.rel(path)}, which is missing or not a PNG / JPEG / WebP ` +
      (value.endsWith(".icon") ? "(an Icon Composer file; export a 1024×1024 PNG from it)" : ""),
  );
  return undefined;
}

/** Note the icon fields an Expo config computes in code (and so cannot be read). */
function noteUnresolved(s: Search, label: string, unresolved: readonly string[]): void {
  if (unresolved.length === 0) return;
  const keys = unresolved.map((k) => `\`${k}\``);
  s.notes.push(
    `${label}: ${keys.join(", ")} ${keys.length > 1 ? "are" : "is"} computed in code, so ` +
      "cannot be read statically (denext never runs the app config)",
  );
  s.hint = `export the icon ${label} computes as a 1024×1024 PNG and set \`mobile.icon\` to ` +
    "it in denext.config.ts";
}

/** The Expo icon background and where it came from (the adaptive colour, else `backgroundColor`). */
function expoBackground(icons: ExpoIcons): { background?: string; backgroundFrom?: string } {
  const adaptive = hex(icons.adaptive.backgroundColor);
  if (adaptive) {
    return { background: adaptive, backgroundFrom: "android.adaptiveIcon.backgroundColor" };
  }
  const top = hex(icons.backgroundColor);
  return top ? { background: top, backgroundFrom: "backgroundColor" } : {};
}

/** The adaptive layers, splash logo and splash colours an Expo config adds to its icon. */
async function expoExtras(
  icons: ExpoIcons,
  background: string | undefined,
  file: (key: string, value: string | undefined) => Promise<string | undefined>,
): Promise<Record<string, string>> {
  const a = icons.adaptive;
  const splashBackground = hex(icons.splash.backgroundColor);
  return optionalFiles({
    iconForeground: await file("android.adaptiveIcon.foregroundImage", a.foregroundImage),
    iconBackgroundImage: await file("android.adaptiveIcon.backgroundImage", a.backgroundImage),
    iconMonochrome: await file("android.adaptiveIcon.monochromeImage", a.monochromeImage),
    splashIcon: await file("splash.image", icons.splash.image),
    splashBackground: splashBackground === background ? undefined : splashBackground,
    darkBackground: hex(icons.splash.darkBackgroundColor),
  });
}

/** The icon one Expo app's config yields, or null with notes. */
async function expoSource(s: Search, dir: string): Promise<IconSource | null> {
  const config = await readExpoAppConfig(dir);
  const label = s.rel(join(dir, config.source?.split(" + ")[0] ?? "app.json"));
  for (const n of config.notes) s.notes.push(`${s.rel(dir) || "."}: ${n}`);
  const icons: ExpoIcons = config.icons;
  noteUnresolved(s, label, icons.unresolved);
  const file = (key: string, value: string | undefined) => expoFile(s, dir, label, key, value);
  const icon = await file("icon", icons.icon) ?? await file("ios.icon", icons.iosIcon) ??
    await file("android.icon", icons.androidIcon);
  if (!icon) return null;
  const bg = expoBackground(icons);
  return {
    kind: "expo",
    icon,
    from: label,
    ...(await imageSize(icon))!,
    ...bg,
    ...(await expoExtras(icons, bg.background, file)),
  };
}

/** (b) The first Expo app config (the project's, then a sibling's) that names a usable icon. */
async function fromExpo(s: Search): Promise<IconSource | null> {
  for (const dir of await expoDirs(s.root)) {
    const found = await expoSource(s, dir);
    if (found) return found;
    s.notes.push(
      `${s.rel(dir) || "."}: the Expo app config names no usable icon, so the web icons are used`,
    );
  }
  return null;
}

// ---- (c)–(e) the web icons -------------------------------------------------------------------

/** One `<link>` tag's attributes (lower-cased names). */
type LinkTag = Record<string, string>;

/** The `<link>` tags of an HTML document. */
function linkTags(html: string): LinkTag[] {
  const tags: LinkTag[] = [];
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs: LinkTag = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    tags.push(attrs);
  }
  return tags;
}

/** The project's web shell facts: its `<link>` tags and public folder. */
interface Web {
  readonly links: LinkTag[];
  readonly html: string | null;
  readonly publicDir: string;
}

async function readWeb(root: string): Promise<Web> {
  for (const name of ["index.html", "public/index.html"]) {
    try {
      const text = await Deno.readTextFile(join(root, name));
      return { links: linkTags(text), html: name, publicDir: join(root, "public") };
    } catch { /* next */ }
  }
  return { links: [], html: null, publicDir: join(root, "public") };
}

/** A URL from the page or the manifest, as a file: `/x` under public/, `x` beside `base`. */
function webFile(web: Web, url: string, baseDir: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return null;
  const path = url.split(/[?#]/)[0];
  if (path === "") return null;
  return path.startsWith("/")
    ? join(web.publicDir, decodeURIComponent(path))
    : join(baseDir, decodeURIComponent(path));
}

/** The `<link>` hrefs whose `rel` holds one of `rels`. */
function linkHrefs(web: Web, rels: readonly string[]): string[] {
  return web.links.flatMap((l) => {
    const rel = (l.rel ?? "").toLowerCase().split(/\s+/);
    return l.href && rels.some((r) => rel.includes(r)) ? [l.href] : [];
  });
}

/** A measured candidate. */
interface Candidate {
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

/** The best of `candidates`: square before not, then the largest. */
function best(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort((a, b) =>
    Number(b.width === b.height) - Number(a.width === a.height) ||
    Math.min(b.width, b.height) - Math.min(a.width, a.height)
  )[0];
}

/** Measure each path that is a raster; drop the rest (and duplicates). */
async function measured(paths: readonly (string | null)[]): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const path of new Set(paths.filter((p): p is string => !!p))) {
    const size = await imageSize(path);
    if (size) out.push({ path, ...size });
  }
  return out;
}

/** A web manifest file and its JSON. */
interface Manifest {
  readonly path: string;
  readonly json: Record<string, unknown>;
}

/** The web manifest: the page's `<link rel="manifest">`, else a conventional file. */
async function findManifest(s: Search, web: Web): Promise<Manifest | null> {
  const linked = linkHrefs(web, ["manifest"]).map((h) => webFile(web, h, s.root));
  const conventional = [
    "public/manifest.webmanifest",
    "public/manifest.json",
    "public/site.webmanifest",
    "app/manifest.webmanifest",
    "app/manifest.json",
  ].map((f) => join(s.root, f));
  for (const path of [...linked, ...conventional]) {
    if (!path) continue;
    const json = await readJsonFile(path);
    if (json) return { path, json };
  }
  return null;
}

/** Whether a manifest icon of `purpose` is a plain (`any`) icon. */
function isAnyPurpose(purpose: string[]): boolean {
  return purpose.includes("any") ||
    !(purpose.includes("maskable") || purpose.includes("monochrome"));
}

/** The manifest's icon files, split into plain (`any`) and `maskable` ones. */
function manifestIconFiles(web: Web, manifest: Manifest): { any: string[]; maskable: string[] } {
  const any: string[] = [];
  const maskable: string[] = [];
  const icons = Array.isArray(manifest.json.icons) ? manifest.json.icons : [];
  for (const entry of icons) {
    const icon = manifestIcon(web, manifest, entry);
    if (icon?.purpose.includes("maskable")) maskable.push(icon.path);
    if (icon && isAnyPurpose(icon.purpose)) any.push(icon.path);
  }
  return { any, maskable };
}

/** One manifest `icons[]` entry as a file and its purposes, or null when it names none. */
function manifestIcon(
  web: Web,
  manifest: Manifest,
  entry: unknown,
): { path: string; purpose: string[] } | null {
  const e = (entry ?? {}) as { src?: unknown; purpose?: unknown };
  const path = typeof e.src === "string" ? webFile(web, e.src, dirname(manifest.path)) : null;
  if (!path) return null;
  return { path, purpose: String(e.purpose ?? "any").toLowerCase().split(/\s+/) };
}

/** The manifest's `background_color` as hex, noting a value that is not hex. */
function manifestBackground(s: Search, manifest: Manifest, label: string) {
  const raw = manifest.json.background_color;
  const background = hex(raw);
  if (raw !== undefined && !background) {
    s.notes.push(`${label}: background_color is not a hex colour, so it is not used`);
  }
  return background ? { background, backgroundFrom: `${label} background_color` } : {};
}

/** (c) The manifest's largest square icon (a maskable one becomes the adaptive foreground). */
async function fromManifest(
  s: Search,
  web: Web,
  manifest: Manifest | null,
): Promise<IconSource | null> {
  if (!manifest) return null;
  const files = manifestIconFiles(web, manifest);
  const maskable = best(await measured(files.maskable));
  const main = best(await measured(files.any)) ?? maskable;
  const label = s.rel(manifest.path);
  if (!main) {
    s.notes.push(`${label}: no icon in it is a PNG / JPEG / WebP on disk`);
    return null;
  }
  const adaptive = maskable && maskable.path !== main.path ? { iconForeground: maskable.path } : {};
  return {
    kind: "manifest",
    icon: main.path,
    from: label,
    width: main.width,
    height: main.height,
    ...manifestBackground(s, manifest, label),
    ...adaptive,
  };
}

/** (d) `<link rel="apple-touch-icon">`, then public/apple-touch-icon.png (and Next's app/apple-icon). */
async function fromAppleTouchIcon(s: Search, web: Web): Promise<IconSource | null> {
  const linked = await measured(
    linkHrefs(web, ["apple-touch-icon", "apple-touch-icon-precomposed"]).map((h) =>
      webFile(web, h, s.root)
    ),
  );
  const pick = best(linked) ?? best(
    await measured([
      join(web.publicDir, "apple-touch-icon.png"),
      join(web.publicDir, "apple-touch-icon-precomposed.png"),
      join(s.root, "app/apple-icon.png"),
    ]),
  );
  if (!pick) return null;
  return {
    kind: "apple-touch-icon",
    icon: pick.path,
    from: linked.length && web.html
      ? `${web.html} <link rel="apple-touch-icon">`
      : s.rel(pick.path),
    width: pick.width,
    height: pick.height,
  };
}

/** (e) The largest PNG favicon: `<link rel="icon">` PNGs, public/favicon*.png, Next's app/icon.png. */
async function fromFavicon(s: Search, web: Web): Promise<IconSource | null> {
  const paths: (string | null)[] = linkHrefs(web, ["icon"]).map((h) => webFile(web, h, s.root))
    .filter((p) => !!p && extname(p).toLowerCase() === ".png");
  try {
    for await (const e of Deno.readDir(web.publicDir)) {
      if (e.isFile && /^favicon.*\.png$/i.test(e.name)) paths.push(join(web.publicDir, e.name));
    }
  } catch { /* no public/ */ }
  paths.push(join(s.root, "app/icon.png"));
  const pick = best(await measured(paths));
  if (!pick) return null;
  return {
    kind: "favicon",
    icon: pick.path,
    from: s.rel(pick.path),
    width: pick.width,
    height: pick.height,
  };
}

/**
 * Find the app icon a Capacitor shell should use, without running any project code.
 *
 * @param root The project (the folder with denext.config.* and, usually, capacitor.config.*).
 * @returns The chosen source (null when there is none) and why each earlier rule was skipped.
 * @throws {Error} When `mobile.icon` names a file that is missing or not a raster.
 */
export async function resolveIconSource(root: string): Promise<IconSearch> {
  const s = new Search(root);
  let source = await fromConfig(s) ?? await fromAssets(s) ?? await fromExpo(s);
  if (!source) {
    const web = await readWeb(root);
    const manifest = await findManifest(s, web);
    source = await fromManifest(s, web, manifest) ?? await fromAppleTouchIcon(s, web) ??
      await fromFavicon(s, web);
    // Every web rule shares the manifest's background colour.
    const background = hex(manifest?.json.background_color);
    if (source && !source.background && background) {
      source = {
        ...source,
        background,
        backgroundFrom: `${s.rel(manifest!.path)} background_color`,
      };
    }
  }
  const hint = s.hint ||
    "add a 1024×1024 PNG and set `mobile.icon` to it in denext.config.ts (or save it as " +
      "assets/icon.png)";
  const warnings = source && await isPreMasked(source.icon)
    ? [
      `${s.rel(source.icon)} looks pre-masked (rounded corners on transparency): iOS applies ` +
      "its own rounded mask, so the app shows a rounded rectangle inside a rounded rectangle. " +
      "Use a full-bleed square icon (the artwork to the edges, no rounding, no transparency)",
    ]
    : [];
  return { root, source, notes: s.notes, warnings, hint };
}

/** An alpha at or above this counts as part of the icon's shape. */
const SHAPE_ALPHA = 128;

/** Whether pixel (`x`, `y`) of `r` (rounded to the grid) is part of the shape. */
type ShapeTest = (x: number, y: number) => boolean;

/** The bounding box of the opaque pixels (inclusive), or null when there are none. */
interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The bounding box of `solid`'s pixels in a `width`×`height` image. */
function shapeBox(width: number, height: number, solid: ShapeTest): Box | null {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!solid(x, y)) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Whether `box` is a near square covering most of a `width`×`height` image. */
function coversSquare(box: Box, width: number, height: number): boolean {
  const [bw, bh] = [box.x1 - box.x0 + 1, box.y1 - box.y0 + 1];
  return bw >= 0.6 * width && bh >= 0.6 * height &&
    Math.abs(bw - bh) <= 0.05 * Math.max(bw, bh);
}

/** Whether each corner of `box`, and a point just inside it on the diagonal, is transparent. */
function cornersCut(box: Box, solid: ShapeTest): boolean {
  const inset = Math.max(1, Math.round(0.02 * (box.x1 - box.x0 + 1)));
  return [[box.x0, 1], [box.x1, -1]].every(([x, dx]) =>
    [[box.y0, 1], [box.y1, -1]].every(([y, dy]) =>
      !solid(x, y) && !solid(x + dx * inset, y + dy * inset)
    )
  );
}

/** Whether `box`'s four edges are part of the shape from 30% to 70% of their length. */
function straightEdges(box: Box, solid: ShapeTest): boolean {
  return [0.3, 0.5, 0.7].every((t) => {
    const x = box.x0 + t * (box.x1 - box.x0);
    const y = box.y0 + t * (box.y1 - box.y0);
    return solid(x, box.y0) && solid(x, box.y1) && solid(box.x0, y) && solid(box.x1, y);
  });
}

/**
 * Whether the icon is a rounded rectangle on transparency: the bounding box of its opaque
 * pixels is a near square covering most of the image, every corner of that box is transparent
 * (cut by the rounding), and its four edges are opaque from 30% to 70% of their length (straight
 * sides, which rules out a round logo). A full-bleed square, or one with a few transparent
 * pixels, is not.
 *
 * @param path The icon (a PNG / JPEG / WebP; JPEG has no transparency).
 * @returns Whether it looks pre-masked; false when it cannot be decoded.
 */
async function isPreMasked(path: string): Promise<boolean> {
  if (/\.jpe?g$/i.test(path)) return false;
  const r = await Deno.readFile(path).then(decodeImage).catch(() => null);
  if (!r) return false;
  const solid: ShapeTest = (x, y) =>
    r.px[(Math.round(y) * r.width + Math.round(x)) * 4 + 3] >= SHAPE_ALPHA;
  const box = shapeBox(r.width, r.height, solid);
  return box !== null && coversSquare(box, r.width, r.height) && cornersCut(box, solid) &&
    straightEdges(box, solid);
}

/** A short description of a source's kind, for the report. */
const KIND_LABEL: Record<IconSourceKind, string> = {
  config: "denext.config mobile.icon",
  assets: "the Capacitor assets/ folder",
  expo: "the Expo app config",
  manifest: "the web manifest",
  "apple-touch-icon": "the apple-touch-icon",
  favicon: "the largest PNG favicon",
};

/**
 * The search as report lines (no indent): the chosen icon, its size and background, then the
 * notes on what was passed over.
 *
 * @param search What {@linkcode resolveIconSource} returned.
 * @param opts `warnSize: false` leaves out the under-1024² warning (`mobile assets` prints its own).
 * @returns The lines.
 */
export function formatIconSearch(
  search: IconSearch,
  opts: { warnSize?: boolean } = {},
): string[] {
  const s = search.source;
  const lines = s
    ? [
      `icon source: ${search.root === s.icon ? s.icon : posixRelative(search.root, s.icon)} ` +
      `(${s.width}×${s.height}) from ${KIND_LABEL[s.kind]} (${s.from})` +
      (s.background ? `, background ${s.background} (${s.backgroundFrom})` : ""),
    ]
    : [
      "icon source: none found (no mobile.icon, Expo icon, manifest icon, apple-touch-icon " +
      "or PNG favicon)",
    ];
  if (s && opts.warnSize !== false && Math.min(s.width, s.height) < STORE_ICON_SIZE) {
    lines.push(
      `warning: ${s.width}×${s.height} is upscaled to the ${STORE_ICON_SIZE}×${STORE_ICON_SIZE} ` +
        `App Store icon and will look soft; ${search.hint}`,
    );
  }
  for (const w of search.warnings) lines.push(`warning: ${w}`);
  for (const n of search.notes) lines.push(`note: ${n}`);
  return lines;
}

/** The icon's path for `mobile.icon` in a generated config (`./`-relative to the project). */
function configRelative(root: string, path: string): string {
  const rel = posixRelative(root, path);
  return rel.startsWith("../") ? rel : `./${rel}`;
}

/**
 * The `mobile` config block that pins a resolved source (what `denext migrate` writes), so
 * later builds use the same icon even if the project gains another.
 *
 * @param root The project.
 * @param s The resolved source.
 * @returns Plain data for `mobile` in denext.config.ts.
 */
export function mobileIconConfig(root: string, s: IconSource): Record<string, unknown> {
  const rel = (p: string | undefined) => (p ? configRelative(root, p) : undefined);
  const adaptive = optionalFiles({
    foreground: rel(s.iconForeground),
    backgroundImage: rel(s.iconBackgroundImage),
    monochrome: rel(s.iconMonochrome),
  });
  return {
    icon: configRelative(root, s.icon),
    ...(s.background ? { backgroundColor: s.background } : {}),
    ...(Object.keys(adaptive).length ? { adaptiveIcon: adaptive } : {}),
    ...optionalFiles({
      splashIcon: rel(s.splashIcon),
      splashBackgroundColor: s.splashBackground,
      darkBackgroundColor: s.darkBackground,
    }),
  };
}

// ---- Capacitor's placeholder icon --------------------------------------------------------------

/**
 * SHA-256 of the icon and splash files `npx cap add` copies from @capacitor/cli's templates
 * (identical in Capacitor 7 and 8, CocoaPods and SPM templates): the Capacitor logo, which App
 * Review rejects as a placeholder.
 */
const CAPACITOR_DEFAULTS: Record<string, readonly string[]> = {
  "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png": [
    "29e4777e319de3ee5a52c3a8004ec19d0568414004257e36d7c94a077d71c93b",
  ],
  "ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png": [
    "1b5002b74a5500e697298ced06ca2811ac33f2771f236f3c720ff23243890530",
  ],
  "android/app/src/main/res/mipmap-mdpi/ic_launcher.png": [
    "27ed3603010ebc278f64f8645741ab132ff517abb5308eb9df6c8e42a48956b2",
  ],
  "android/app/src/main/res/mipmap-hdpi/ic_launcher.png": [
    "72b71c3581ca3b5a23b1c168d69b9d855b3f184fa079902a01f088eb4f0607d5",
  ],
  "android/app/src/main/res/mipmap-xhdpi/ic_launcher.png": [
    "d35dbfff175b83c13ef59cf924abfc810f7b6a158595d7417c5498ea8c7c7ed1",
  ],
  "android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png": [
    "ed346eb1e3f0280f15709393705899b3ff55c20b88f4e0308006b3c33cf5fe14",
  ],
  "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png": [
    "87cb2f2ffe992652bb4fa768c73719a37b5852ab17fbf8e170e888f7a42b0761",
  ],
  "android/app/src/main/res/drawable/splash.png": [
    "5cf98b4451bd99b20df26f9e608a46946118be6b0ae90762f9ca1786a30c76ff",
  ],
};

/** Whether `root/rel` is the file Capacitor's template ships there. */
async function isTemplateFile(root: string, rel: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(join(root, rel));
  } catch {
    return false;
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  const hexDigest = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return CAPACITOR_DEFAULTS[rel].includes(hexDigest);
}

/**
 * The Capacitor placeholder files still in a native project.
 *
 * @param root The Capacitor project.
 * @param platform The native project to look in.
 * @param what `icon` (the launcher / App Store icon) or `splash`.
 * @returns The project-relative paths that are still the template's bytes.
 */
export async function capacitorPlaceholders(
  root: string,
  platform: "ios" | "android",
  what: "icon" | "splash",
): Promise<string[]> {
  const out: string[] = [];
  for (const rel of Object.keys(CAPACITOR_DEFAULTS)) {
    if (!rel.startsWith(`${platform}/`)) continue;
    if ((what === "splash") !== /splash/.test(rel)) continue;
    if (await isTemplateFile(root, rel)) out.push(rel);
  }
  return out;
}
