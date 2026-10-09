// Desktop app icon preparation for `deno desktop`. The app icon is CONFIG-DRIVEN:
// `spa.desktop.icon` in denext.config.ts points at any file (overriding auto-detection),
// and this module prepares it at build time — written to `desktop-icon.png`, which the
// generated `deno task desktop` consumes via `deno desktop --icon`. When no icon is
// configured, a web icon is auto-detected.
//
// Why compose instead of passing the raw file: `deno desktop --icon` bakes the image
// full-bleed, but a web `apple-touch-icon`/`favicon` fills the whole square, so the Dock
// renders it oversized next to native apps. macOS's grid puts the artwork in an ~824px
// "safe area" centered on a 1024² canvas with ~100px transparent margin — we reproduce
// that so the packaged app's icon sits at native size. 1024 is the correct master;
// deno desktop derives every smaller size from it. A configured icon is used verbatim
// (the user supplies a finished master), an auto-detected web favicon is composed.

import { exists } from "@std/fs";
import { join, relative, resolve } from "@std/path";
import type { SpaConfig } from "../server/config.ts";
import { resolveIconSource } from "./mobile-icon-source.ts";
import { decodeImage, encodePng, fitInto } from "./png-raster.ts";

/** The file the composed icon is written to (and the `--icon` the desktop task uses). */
export const DESKTOP_ICON_FILE = "desktop-icon.png";

// Icon canvas + macOS template geometry (Apple's grid): on macOS the artwork fills ~80%
// of the canvas (a transparent safe-area margin, so the Dock renders it at native size);
// other platforms fill the whole tile.
const MAC_ICON_CANVAS = 1024;
/** Apple's macOS icon grid: the tile is 824 of 1024 px (100 px margins). */
const MAC_ICON_SAFE = 824 / 1024;
/**
 * The macOS tile's corner radius as a fraction of the tile — Apple's continuous-curvature
 * shape is ~22.37 % of the side (185 px on the 824 px tile); circular corners at that radius
 * are visually indistinguishable in the Dock.
 */
const MAC_ICON_CORNER = 0.2237;

/**
 * The safe-area ratio for the build's target platform. macOS wants the ~80% margined
 * grid; Windows/Linux taskbar/dock icons fill the tile, so a margined icon would render
 * undersized there — use the full canvas. Keyed off the host OS (the platform `deno
 * desktop` builds for by default); a cross-compile still gets the host's convention.
 */
function iconSafeRatio(): number {
  return Deno.build.os === "darwin" ? MAC_ICON_SAFE : 1;
}

/** The 8-byte PNG signature. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether `bytes` starts with the PNG signature. */
function isPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Auto-detect a web app icon to compose (raster PNG only — `.ico`/`.icns` can't be
 * decoded here, so they are NOT candidates; a `.ico`-only app keeps deno desktop's
 * default icon rather than baking a `--icon` flag that has no file to point at).
 * Prefers `apple-touch-icon`, then a named `icon`/`logo`. Returns a path relative to
 * `dir`, or `undefined`. Only used when `spa.desktop.icon` is not set.
 */
export async function detectIconSource(dir: string): Promise<string | undefined> {
  const candidates = [
    "public/apple-touch-icon.png",
    "apple-touch-icon.png",
    "public/icon.png",
    "icon.png",
    "public/logo.png",
    "public/favicon.png",
  ];
  for (const rel of candidates) {
    if (await exists(join(dir, rel))) return rel;
  }
  return undefined;
}

/**
 * Compose raster icon bytes into a 1024² PNG: the artwork resized into `safeRatio` of the
 * canvas, centered on a transparent background (a `safeRatio` of 1 fills the whole tile;
 * < 1 leaves a transparent margin — macOS's grid). Returns the PNG bytes, or `null` when
 * the source can't be decoded — `@denext/photon` unavailable, or an unsupported format
 * like `.ico`/`.icns`. `safeRatio` defaults to the macOS margin ({@link iconSafeRatio}).
 */
export async function composeMacOsIcon(
  src: Uint8Array,
  safeRatio: number = iconSafeRatio(),
): Promise<Uint8Array | null> {
  try {
    const { PhotonImage, resize, SamplingFilter } = await import("@denext/photon");
    const img = PhotonImage.new_from_byteslice(src);
    const inner = Math.round(MAC_ICON_CANVAS * safeRatio);
    const small = resize(img, inner, inner, SamplingFilter.Lanczos3);
    const px = small.get_raw_pixels(); // RGBA, inner*inner*4
    // A web icon (apple-touch-icon, favicon) is a full-bleed square; the Dock does NOT mask
    // it, so without this it renders as a sharp-cornered box that reads smaller than its
    // rounded neighbours. Only applied on the margined (macOS) composition.
    if (safeRatio < 1) roundTileCorners(px, inner, Math.round(inner * MAC_ICON_CORNER));
    const canvas = new Uint8Array(MAC_ICON_CANVAS * MAC_ICON_CANVAS * 4); // transparent
    const off = Math.floor((MAC_ICON_CANVAS - inner) / 2);
    for (let y = 0; y < inner; y++) {
      const s = y * inner * 4;
      const d = ((y + off) * MAC_ICON_CANVAS + off) * 4;
      canvas.set(px.subarray(s, s + inner * 4), d);
    }
    return new PhotonImage(canvas, MAC_ICON_CANVAS, MAC_ICON_CANVAS).get_bytes();
  } catch (err) {
    // Say WHY (a refused `@denext/photon` import under the min-dep-age policy, an
    // undecodable format, …) — a bare "could not process" hid the real cause.
    console.warn(`  desktop icon: compose failed — ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Clear the alpha of every pixel outside a rounded rectangle of radius `r` covering the whole
 * `size`×`size` RGBA tile (circular corners), so a square source takes the macOS tile shape.
 */
function roundTileCorners(px: Uint8Array, size: number, r: number): void {
  const last = size - 1;
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < r; x++) {
      // Distance from this corner pixel's center to the corner arc's center.
      const dx = r - 0.5 - x;
      const dy = r - 0.5 - y;
      if (dx * dx + dy * dy <= r * r) continue; // inside the arc → keep
      for (const [cx, cy] of [[x, y], [last - x, y], [x, last - y], [last - x, last - y]]) {
        px[(cy * size + cx) * 4 + 3] = 0;
      }
    }
  }
}

/**
 * Write `bytes` to `<projectDir>/desktop-icon.png`. Removes any existing entry first so a
 * symlink planted at this predictable path can't redirect the write to an arbitrary file
 * (`Deno.writeFile` follows symlinks) — the same guard `writeMergedModuleConfig` uses.
 */
async function writeDesktopIcon(projectDir: string, bytes: Uint8Array): Promise<void> {
  const out = join(projectDir, DESKTOP_ICON_FILE);
  await Deno.remove(out).catch(() => {});
  await Deno.writeFile(out, bytes);
}

/**
 * Prepare the desktop app icon for `projectDir`, writing it to `desktop-icon.png` there
 * (which the generated `deno desktop --icon` consumes). Source + treatment:
 *   1. `spa.desktop.icon` (config) — the explicit override. A PNG is used **verbatim**
 *      (the user supplies a finished master); a JPEG/WebP is composed into the macOS
 *      template. An undecodable format (`.ico`/`.icns`) is refused with a clear message
 *      and the build falls back to auto-detection.
 *   2. otherwise an auto-detected web icon ({@link detectIconSource}) — **composed** into
 *      Apple's macOS template (a web `apple-touch-icon`/`favicon` is small and full-bleed,
 *      so it needs the safe-area margin to render at native Dock size).
 * Returns {@link DESKTOP_ICON_FILE} when an icon was written, or `undefined` (no source,
 * or a configured path missing / undecodable and no fallback — all logged).
 *
 * @param projectDir The app's project root.
 * @param spa The resolved SPA config (for `desktop.icon`).
 */
export async function prepareDesktopIcon(
  projectDir: string,
  spa: SpaConfig | undefined,
): Promise<string | undefined> {
  // 1. Explicit config override wins — used verbatim (PNG) or composed (other raster).
  const configured = spa?.desktop?.icon;
  if (configured) {
    const bytes = await Deno.readFile(resolve(projectDir, configured)).catch(() => null);
    if (!bytes) {
      console.warn(`  desktop icon: configured spa.desktop.icon not found: ${configured}`);
    } else if (isPng(bytes)) {
      await writeDesktopIcon(projectDir, bytes); // finished PNG master → verbatim
      console.log(`  desktop icon: ${configured} (verbatim) -> ${DESKTOP_ICON_FILE}`);
      return DESKTOP_ICON_FILE;
    } else {
      const composed = await composeMacOsIcon(bytes);
      if (composed) {
        await writeDesktopIcon(projectDir, composed);
        console.log(`  desktop icon: ${configured} (macOS-composed) -> ${DESKTOP_ICON_FILE}`);
        return DESKTOP_ICON_FILE;
      }
      console.warn(
        `  desktop icon: could not process spa.desktop.icon "${configured}" — use a ` +
          `PNG (or JPEG/WebP); .ico/.icns aren't supported. Falling back to auto-detection.`,
      );
    }
    // Configured icon unusable — fall through to auto-detection below.
  }

  // 2. Auto-detected web icon → composed into the macOS template.
  const srcRel = await detectIconSource(projectDir);
  if (!srcRel) return undefined; // nothing to use → deno desktop's default icon

  const composed = await composeMacOsIcon(await Deno.readFile(resolve(projectDir, srcRel)));
  if (!composed) {
    console.warn(
      `  desktop icon: could not process ${srcRel} — using deno desktop's default icon.`,
    );
    return undefined;
  }
  await writeDesktopIcon(projectDir, composed);
  console.log(`  desktop icon: ${srcRel} (macOS-composed) -> ${DESKTOP_ICON_FILE}`);
  return DESKTOP_ICON_FILE;
}

// ---------------------------------------------------------------------------------------------
// The packaged app's icon when none is configured
// ---------------------------------------------------------------------------------------------

/** The sizes a derived Windows `.ico` carries (256 is the largest an .ico entry describes). */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

/** Where a derived icon is written for each target OS (relative to the project). */
const DERIVED_DESKTOP_ICONS: Readonly<Record<"darwin" | "linux" | "windows", string>> = {
  darwin: ".deno-desktop/icon-macos.png",
  linux: ".deno-desktop/icon-linux.png",
  windows: ".deno-desktop/icon.ico",
};

/**
 * An `.ico` file holding `images` (PNG-compressed entries, which Windows reads since Vista).
 *
 * @param images Each image's square size and PNG bytes, smallest first.
 * @returns The `.ico` bytes.
 */
function encodeIco(images: readonly { size: number; png: Uint8Array }[]): Uint8Array {
  const header = 6 + images.length * 16;
  const total = images.reduce((n, img) => n + img.png.length, header);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true); // type 1: icon
  view.setUint16(4, images.length, true);
  let offset = header;
  images.forEach((img, i) => {
    const entry = 6 + i * 16;
    out[entry] = img.size >= 256 ? 0 : img.size; // 0 means 256
    out[entry + 1] = img.size >= 256 ? 0 : img.size;
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, img.png.length, true);
    view.setUint32(entry + 12, offset, true);
    out.set(img.png, offset);
    offset += img.png.length;
  });
  return out;
}

/** The icon bytes for `os` from a raster source's bytes, or `null` when they can't be decoded. */
async function derivedIconBytes(
  os: "darwin" | "linux" | "windows",
  src: Uint8Array,
): Promise<Uint8Array | null> {
  if (os !== "windows") return await composeMacOsIcon(src, os === "darwin" ? MAC_ICON_SAFE : 1);
  try {
    const raster = await decodeImage(src);
    const images = [];
    for (const size of ICO_SIZES) {
      images.push({ size, png: await encodePng(await fitInto(raster, size)) });
    }
    return encodeIco(images);
  } catch (err) {
    console.warn(`  desktop icon: .ico failed — ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Derive the packaged app's icon for `os` from the app's own icon, found the way
 * `denext mobile assets` finds it (`mobile.icon`, the Capacitor `assets/` folder, the Expo config,
 * the web manifest, the apple-touch-icon, the largest PNG favicon): a Windows `.ico` (16 to 256 px),
 * a macOS 1024 px PNG on Apple's icon grid, or a full-tile Linux 1024 px PNG, written to
 * {@linkcode DERIVED_DESKTOP_ICONS}. Used when `desktop.app.icons.<os>` is unset and none of the
 * package script's default icon files exists, so the app does not get `deno desktop`'s generic
 * icon.
 *
 * @param root The project.
 * @param os The target OS.
 * @returns The icon's path relative to the project, or `undefined` when the app has no icon.
 */
export async function deriveDesktopIcon(
  root: string,
  os: "darwin" | "linux" | "windows",
): Promise<string | undefined> {
  let icon: string | undefined;
  try {
    icon = (await resolveIconSource(root)).source?.icon;
  } catch (err) {
    console.warn(`  desktop icon: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
  if (!icon) return undefined;
  const bytes = await derivedIconBytes(os, await Deno.readFile(icon));
  if (!bytes) return undefined;
  const rel = DERIVED_DESKTOP_ICONS[os];
  const out = join(root, rel);
  await Deno.mkdir(join(root, ".deno-desktop"), { recursive: true });
  await Deno.remove(out).catch(() => {}); // never write through a planted symlink
  await Deno.writeFile(out, bytes);
  console.log(`  desktop icon: ${relative(root, icon)} -> ${rel}`);
  return rel;
}
