// The desktop app-icon preparation (src/build/desktop-icon.ts): a configured
// `spa.desktop.icon` is used verbatim; an auto-detected web icon is composed into the
// 1024² macOS template; nothing → no icon. NETWORK on a cold cache (photon wasm).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { decodeBase64 } from "@std/encoding/base64";
import {
  composeMacOsIcon,
  DESKTOP_ICON_FILE,
  detectIconSource,
  prepareDesktopIcon,
} from "../src/build/desktop-icon.ts";

// A small valid 16×16 PNG (photon decodes it, then resizes into the safe area).
const TINY_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAQMAAAAlPW0iAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURRRQyP///7Z01nIAAAABYktHRAH/Ai3eAAAAB3RJTUUH6ggcDx4zMXkoVgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOC0yOFQxNTozMDo1MSswMDowMCe2H8sAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDgtMjhUMTU6MzA6NTErMDA6MDBW66d3AAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA4LTI4VDE1OjMwOjUxKzAwOjAwAf6GqAAAAAxJREFUCNdjYCANAAAAMAABx6qFjgAAAABJRU5ErkJggg==",
);

/** Read a PNG's IHDR width (bytes 16–20, big-endian). */
function pngWidth(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(16, false);
}

Deno.test("prepareDesktopIcon: a configured PNG is used verbatim", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_icon_" });
  try {
    // A finished PNG master the user points the config at — used byte-for-byte.
    await Deno.writeFile(join(dir, "my-app-icon.png"), TINY_PNG);

    const result = await prepareDesktopIcon(dir, {
      entry: "./main.tsx",
      desktop: { icon: "./my-app-icon.png" },
    });
    assertEquals(result, DESKTOP_ICON_FILE);
    // Verbatim: the output is a byte-for-byte copy — NOT re-encoded/composed.
    assertEquals(await Deno.readFile(join(dir, DESKTOP_ICON_FILE)), TINY_PNG);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prepareDesktopIcon: a non-PNG configured icon falls back to auto-detect", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_icon_" });
  try {
    // A configured path that isn't a decodable image (e.g. a stray .icns/.ico) must not
    // be copied to desktop-icon.png; it falls back to the auto-detected web icon.
    await Deno.writeFile(join(dir, "bad.icns"), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await Deno.mkdir(join(dir, "public"));
    await Deno.writeFile(join(dir, "public", "apple-touch-icon.png"), TINY_PNG);

    const result = await prepareDesktopIcon(dir, {
      entry: "./main.tsx",
      desktop: { icon: "./bad.icns" },
    });
    assertEquals(result, DESKTOP_ICON_FILE);
    // The written icon is the composed 1024² master from the fallback, not the bad bytes.
    assertEquals(pngWidth(await Deno.readFile(join(dir, DESKTOP_ICON_FILE))), 1024);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prepareDesktopIcon: an auto-detected web icon is composed to a 1024² PNG", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_icon_" });
  try {
    await Deno.mkdir(join(dir, "public"));
    await Deno.writeFile(join(dir, "public", "apple-touch-icon.png"), TINY_PNG);

    // No config → auto-detect + compose into the macOS template.
    const result = await prepareDesktopIcon(dir, { entry: "./main.tsx" });
    assertEquals(result, DESKTOP_ICON_FILE);
    const out = await Deno.readFile(join(dir, DESKTOP_ICON_FILE));
    assertEquals(pngWidth(out), 1024, "composed icon is the 1024px macOS master");
    assert(out.length > TINY_PNG.length, "composed (not the tiny source copied through)");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("composeMacOsIcon: safe-area ratio controls the margin (macOS vs other platforms)", async () => {
  const margined = await composeMacOsIcon(TINY_PNG, 0.8); // macOS: ~80% + transparent margin
  const fullBleed = await composeMacOsIcon(TINY_PNG, 1); // Windows/Linux: fills the tile
  assert(margined && fullBleed, "both compose");
  assertEquals(pngWidth(margined), 1024);
  assertEquals(pngWidth(fullBleed), 1024);
  // Different geometry → different output (the ratio actually takes effect).
  assert(
    margined.length !== fullBleed.length,
    "margined and full-bleed icons must differ",
  );
});

Deno.test("prepareDesktopIcon: no icon source → undefined (deno desktop default)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_icon_" });
  try {
    assertEquals(await detectIconSource(dir), undefined);
    assertEquals(await prepareDesktopIcon(dir, { entry: "./main.tsx" }), undefined);
    let exists = false;
    try {
      await Deno.stat(join(dir, DESKTOP_ICON_FILE));
      exists = true;
    } catch { /* expected: nothing written */ }
    assert(!exists, "no desktop-icon.png when there is no source");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("composeMacOsIcon: a square web icon becomes Apple's 824px rounded tile", async () => {
  const { PhotonImage } = await import("@denext/photon");
  // An opaque 180² square (the shape of every apple-touch-icon).
  const solid = new PhotonImage(new Uint8Array(180 * 180 * 4).fill(255), 180, 180).get_bytes();
  const out = await composeMacOsIcon(solid, 824 / 1024);
  assert(out, "composed");
  const img = PhotonImage.new_from_byteslice(out);
  const w = img.get_width(), px = img.get_raw_pixels();
  const alpha = (x: number, y: number) => px[(y * w + x) * 4 + 3];
  assertEquals(w, 1024);
  // Tile spans x = 100..923 (824 px) — the margin is transparent, the edge midpoints opaque.
  assertEquals(alpha(99, 512), 0, "left margin transparent");
  assertEquals(alpha(100, 512), 255, "tile left edge opaque");
  assertEquals(alpha(923, 512), 255, "tile right edge opaque");
  assertEquals(alpha(924, 512), 0, "right margin transparent");
  // Corners are rounded: the tile's corner pixel is transparent, well inside the arc it is opaque.
  assertEquals(alpha(100, 100), 0, "sharp corner removed");
  assertEquals(alpha(923, 923), 0, "sharp corner removed (opposite)");
  assertEquals(alpha(512, 512), 255, "center opaque");
  assertEquals(alpha(160, 160), 255, "inside the corner arc stays opaque");
});
