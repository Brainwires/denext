// The desktop app-icon preparation (src/build/desktop-icon.ts): a configured
// `spa.desktop.icon` is used verbatim; an auto-detected web icon is composed into the
// 1024² macOS template; nothing → no icon. NETWORK on a cold cache (photon wasm).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { decodeBase64 } from "@std/encoding/base64";
import {
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

Deno.test("prepareDesktopIcon: a configured icon is used verbatim", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_icon_" });
  try {
    // An arbitrary "already-finished" icon the user points the config at.
    const finished = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await Deno.writeFile(join(dir, "my-app-icon.png"), finished);

    const result = await prepareDesktopIcon(dir, {
      entry: "./main.tsx",
      desktop: { icon: "./my-app-icon.png" },
    });
    assertEquals(result, DESKTOP_ICON_FILE);
    // Verbatim: the output is a byte-for-byte copy — NOT re-encoded/composed.
    assertEquals(await Deno.readFile(join(dir, DESKTOP_ICON_FILE)), finished);
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
