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
import { join, resolve } from "@std/path";
import type { SpaConfig } from "../server/config.ts";

/** The file the composed icon is written to (and the `--icon` the desktop task uses). */
export const DESKTOP_ICON_FILE = "desktop-icon.png";

// macOS icon template geometry (Apple's grid): the artwork fills ~80% of the canvas.
const MAC_ICON_CANVAS = 1024;
const MAC_ICON_SAFE = 0.8; // inner ≈ 819px, margin ≈ 102px — within Apple's ~824/~100.

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
 * Compose raster icon bytes into a macOS-template PNG (artwork resized into the safe
 * area, centered on a transparent 1024² canvas). Returns the PNG bytes, or `null` when
 * the source can't be decoded — `@denext/photon` unavailable, or an unsupported format
 * like `.ico`/`.icns`.
 */
export async function composeMacOsIcon(src: Uint8Array): Promise<Uint8Array | null> {
  try {
    const { PhotonImage, resize, SamplingFilter } = await import("@denext/photon");
    const img = PhotonImage.new_from_byteslice(src);
    const inner = Math.round(MAC_ICON_CANVAS * MAC_ICON_SAFE);
    const small = resize(img, inner, inner, SamplingFilter.Lanczos3);
    const px = small.get_raw_pixels(); // RGBA, inner*inner*4
    const canvas = new Uint8Array(MAC_ICON_CANVAS * MAC_ICON_CANVAS * 4); // transparent
    const off = Math.floor((MAC_ICON_CANVAS - inner) / 2);
    for (let y = 0; y < inner; y++) {
      const s = y * inner * 4;
      const d = ((y + off) * MAC_ICON_CANVAS + off) * 4;
      canvas.set(px.subarray(s, s + inner * 4), d);
    }
    return new PhotonImage(canvas, MAC_ICON_CANVAS, MAC_ICON_CANVAS).get_bytes();
  } catch {
    return null;
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
