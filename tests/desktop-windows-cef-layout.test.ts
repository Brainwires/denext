// The Windows CEF bundle behind CEF's bootstrap (Chromium's sandbox): the stock `deno desktop`
// names laufey's CEF executable `<App>.exe` and the runtime `<App>.dll`, but the executable is
// CEF's bootstrap.exe, which loads its host (`laufey.dll`) as `<App>.dll`, and the host loads the
// runtime as `<App>.runtime.dll`. desktopWindowsCefLayout moves the two and gives `<App>.exe` the
// app's icon and version resources (pe-resources.ts), keeping the bootstrap's other resources.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  desktopWindowsBootstrapBundle,
  desktopWindowsCefLayout,
} from "../src/build/desktop-package-script.ts";
import {
  type PeResourceName,
  peVersionWords,
  readPeResources,
  stampPeResources,
  versionInfoResource,
  writePeResources,
} from "../src/build/pe-resources.ts";

/** A minimal PE32+ image: headers, one `.text` section, an empty resource data directory. */
function minimalPe(): Uint8Array {
  const b = new Uint8Array(0x400);
  const v = new DataView(b.buffer);
  b.set([0x4d, 0x5a]);
  v.setUint32(0x3c, 0x40, true);
  b.set([0x50, 0x45, 0, 0], 0x40);
  const coff = 0x44;
  v.setUint16(coff, 0x8664, true);
  v.setUint16(coff + 2, 1, true);
  v.setUint16(coff + 16, 240, true);
  v.setUint16(coff + 18, 0x22, true);
  const opt = coff + 20;
  v.setUint16(opt, 0x20b, true);
  v.setUint32(opt + 4, 0x200, true);
  v.setUint32(opt + 16, 0x1000, true);
  v.setUint32(opt + 20, 0x1000, true);
  v.setBigUint64(opt + 24, 0x140000000n, true);
  v.setUint32(opt + 32, 0x1000, true);
  v.setUint32(opt + 36, 0x200, true);
  v.setUint16(opt + 40, 6, true);
  v.setUint16(opt + 48, 6, true);
  v.setUint32(opt + 56, 0x2000, true);
  v.setUint32(opt + 60, 0x200, true);
  v.setUint16(opt + 68, 2, true);
  v.setUint32(opt + 108, 16, true);
  const sec = opt + 240;
  b.set(new TextEncoder().encode(".text"), sec);
  v.setUint32(sec + 8, 0x200, true);
  v.setUint32(sec + 12, 0x1000, true);
  v.setUint32(sec + 16, 0x200, true);
  v.setUint32(sec + 20, 0x200, true);
  v.setUint32(sec + 36, 0x60000020, true);
  b[0x200] = 0xc3;
  return b;
}

/** An `.ico` file with one image of `payload` bytes (a 32×32 entry). */
function ico(payload: string): Uint8Array {
  const data = new TextEncoder().encode(payload);
  const b = new Uint8Array(22 + data.length);
  const v = new DataView(b.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, 1, true);
  b.set([32, 32, 0, 0], 6);
  v.setUint16(10, 1, true);
  v.setUint16(12, 32, true);
  v.setUint32(14, data.length, true);
  v.setUint32(18, 22, true);
  b.set(data, 22);
  return b;
}

const RT_ICON = 3, RT_STRING = 6, RT_GROUP_ICON = 14, RT_VERSION = 16, RT_MANIFEST = 24;
const MANIFEST = '<assembly manifestVersion="1.0"><compatibility/></assembly>';
const enc = new TextEncoder();

type Tree = ReturnType<typeof readPeResources>;

/** One resource in a tree. */
function res(tree: Tree, type: number, name: PeResourceName, data: Uint8Array) {
  const names = tree.get(type) ?? new Map();
  names.set(name, new Map([[1033, { data, codepage: 0 }]]));
  tree.set(type, names);
}

/** A stand-in for CEF's bootstrap.exe: icon group 32512 with two icons, a string table, the
 * manifest and a version resource of its own, as the real one carries. */
function bootstrapLike(): Uint8Array {
  const tree: Tree = new Map();
  res(tree, RT_ICON, 1, enc.encode("CEF ICON 1"));
  res(tree, RT_ICON, 2, enc.encode("CEF ICON 2"));
  const group = new Uint8Array(6 + 2 * 14);
  const g = new DataView(group.buffer);
  g.setUint16(2, 1, true);
  g.setUint16(4, 2, true);
  g.setUint16(6 + 12, 1, true);
  g.setUint16(6 + 14 + 12, 2, true);
  res(tree, RT_GROUP_ICON, 32512, group);
  res(tree, RT_STRING, 7, new Uint8Array(32).fill(7));
  res(tree, RT_MANIFEST, 1, enc.encode(MANIFEST));
  res(
    tree,
    RT_VERSION,
    1,
    versionInfoResource([149, 0, 5, 0], { FileDescription: "CEF bootstrap" }),
  );
  return writePeResources(minimalPe(), tree);
}

/** The strings of a VS_VERSIONINFO resource (key → value), read the simple way: every UTF-16
 * key/value pair after "040904B0". */
function versionStrings(data: Uint8Array): Record<string, string> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = (at: number): [string, number] => {
    let s = "";
    while (at + 1 < data.length) {
      const c = v.getUint16(at, true);
      at += 2;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return [s, at];
  };
  const out: Record<string, string> = {};
  // Walk the String blocks: [wLength, wValueLength, wType, key, pad, value].
  const walk = (at: number, end: number) => {
    while (at + 6 <= end) {
      const len = v.getUint16(at, true);
      if (len === 0) break;
      const valueLen = v.getUint16(at + 2, true);
      const [key, afterKey] = text(at + 6);
      const valueAt = (afterKey + 3) & ~3;
      if (/^[0-9A-F]{8}$/i.test(key) || key.endsWith("FileInfo") || key === "VS_VERSION_INFO") {
        walk(key === "VS_VERSION_INFO" ? (valueAt + valueLen + 3) & ~3 : valueAt, at + len);
      } else if (v.getUint16(at + 4, true) === 1) {
        out[key] = text(valueAt)[0];
      }
      at = (at + len + 3) & ~3;
    }
  };
  walk(0, data.length);
  return out;
}

Deno.test("stampPeResources: the app's icon under the old group's name, its version, the rest kept", () => {
  const stamped = stampPeResources(bootstrapLike(), {
    icon: ico("THE APP'S ICON"),
    version: peVersionWords("2.5.1-rc.1"),
    strings: { FileDescription: "My App", ProductVersion: "2.5.1-rc.1" },
  });
  const tree = readPeResources(stamped);
  // Kept: the manifest and the string table, byte for byte.
  assertEquals(
    new TextDecoder().decode(tree.get(RT_MANIFEST)!.get(1)!.get(1033)!.data),
    MANIFEST,
  );
  assertEquals(tree.get(RT_STRING)!.get(7)!.get(1033)!.data, new Uint8Array(32).fill(7));
  // One icon group, still named 32512, pointing at the app's image; CEF's icons are gone.
  const groups = tree.get(RT_GROUP_ICON)!;
  assertEquals([...groups.keys()], [32512]);
  const group = groups.get(32512)!.get(1033)!.data;
  const gv = new DataView(group.buffer, group.byteOffset);
  assertEquals(gv.getUint16(4, true), 1);
  const id = gv.getUint16(6 + 12, true);
  assertEquals([...tree.get(RT_ICON)!.keys()], [id]);
  assertEquals(
    new TextDecoder().decode(tree.get(RT_ICON)!.get(id)!.get(1033)!.data),
    "THE APP'S ICON",
  );
  assertEquals(gv.getUint32(6 + 8, true), "THE APP'S ICON".length); // dwBytesInRes
  // The version resource: one, naming the app, with the fixed file version 2.5.1.0.
  assertEquals([...tree.get(RT_VERSION)!.keys()], [1]);
  const version = tree.get(RT_VERSION)!.get(1)!.get(1033)!.data;
  assertEquals(versionStrings(version), {
    FileDescription: "My App",
    ProductVersion: "2.5.1-rc.1",
  });
  const fixed = new DataView(version.buffer, version.byteOffset + 40);
  assertEquals(fixed.getUint32(0, true), 0xfeef04bd);
  assertEquals(fixed.getUint32(8, true), (2 << 16) | 5);
  assertEquals(fixed.getUint32(12, true), 1 << 16);
});

Deno.test("stampPeResources: the image's code doesn't move, and the headers stay consistent", () => {
  const before = bootstrapLike();
  const after = stampPeResources(before, { version: [1, 0, 0, 0], strings: {} });
  const b = new DataView(before.buffer);
  const a = new DataView(after.buffer);
  // .text keeps its bytes at the same offset and RVA.
  assertEquals(after.subarray(0x200, 0x400), before.subarray(0x200, 0x400));
  const opt = 0x58;
  const sections = a.getUint16(0x46, true);
  assertEquals(sections, b.getUint16(0x46, true) + 1);
  const last = opt + 240 + (sections - 1) * 40;
  assertEquals(new TextDecoder().decode(after.subarray(last, last + 5)), ".rsrc");
  // The resource directory is the new section; SizeOfImage covers it; the file ends with it.
  const rva = a.getUint32(last + 12, true);
  assertEquals(a.getUint32(opt + 112 + 2 * 8, true), rva);
  assert(a.getUint32(opt + 56, true) >= rva + a.getUint32(last + 8, true));
  assertEquals(after.length, a.getUint32(last + 20, true) + a.getUint32(last + 16, true));
  // The checksum is the image's own.
  assert(a.getUint32(opt + 64, true) !== 0);
  // Stamping again works on the stamped image (the next package run starts from a fresh copy,
  // but nothing breaks if it doesn't).
  const twice = stampPeResources(after, { icon: ico("X"), version: [2, 0, 0, 0], strings: {} });
  assertEquals([...readPeResources(twice).get(RT_GROUP_ICON)!.keys()], [32512]);
});

Deno.test("stampPeResources: an image with no resources gets them; bad input is refused", () => {
  const stamped = stampPeResources(minimalPe(), {
    icon: ico("ICON"),
    version: [3, 1, 0, 0],
    strings: { ProductName: "App" },
  });
  const tree = readPeResources(stamped);
  assertEquals([...tree.get(RT_GROUP_ICON)!.keys()], [1]);
  assertEquals(versionStrings(tree.get(RT_VERSION)!.get(1)!.get(1033)!.data), {
    ProductName: "App",
  });
  assertThrows(
    () =>
      stampPeResources(minimalPe(), {
        icon: enc.encode("nope"),
        version: [1, 0, 0, 0],
        strings: {},
      }),
    Error,
    ".ico",
  );
  assertThrows(
    () =>
      stampPeResources(enc.encode("MZ not a PE at all"), { version: [1, 0, 0, 0], strings: {} }),
    Error,
    "not a PE",
  );
  // Data past the last section (other than a signature) is not something this can keep.
  const overlay = new Uint8Array([...minimalPe(), ...new Uint8Array(0x300)]);
  assertThrows(
    () => stampPeResources(overlay, { version: [1, 0, 0, 0], strings: {} }),
    Error,
    "past its last section",
  );
});

Deno.test("readPeResources: an RVA in a section's virtual-only tail is refused, not read from the next section", () => {
  // `.text` has 0x200 bytes in the file but 0x800 in memory, and `.data` follows it in the file.
  const b = new Uint8Array(0x600);
  b.set(minimalPe());
  const v = new DataView(b.buffer);
  const coff = 0x44, opt = coff + 20, text = opt + 240, data = text + 40;
  v.setUint16(coff + 2, 2, true);
  v.setUint32(opt + 56, 0x3000, true);
  v.setUint32(text + 8, 0x800, true);
  b.set(enc.encode(".data"), data);
  v.setUint32(data + 8, 0x200, true);
  v.setUint32(data + 12, 0x2000, true);
  v.setUint32(data + 16, 0x200, true);
  v.setUint32(data + 20, 0x400, true);
  v.setUint32(data + 36, 0xc0000040, true);
  // The resource directory at `.text` + 0x300: zeros once loaded. Mapped like raw data, it would
  // land on `.data`'s bytes (file offset 0x500) and read as an empty directory.
  v.setUint32(opt + 112 + 2 * 8, 0x1300, true);
  v.setUint32(opt + 112 + 2 * 8 + 4, 0x10, true);
  assertThrows(() => readPeResources(b), Error, "uninitialized tail of section .text");
  // The same directory inside `.text`'s raw data reads (as empty).
  v.setUint32(opt + 112 + 2 * 8, 0x1100, true);
  assertEquals(readPeResources(b).size, 0);
});

Deno.test("peVersionWords: numeric fields padded to four, clamped, 1.0.0.0 otherwise", () => {
  assertEquals(peVersionWords(undefined), [1, 0, 0, 0]);
  assertEquals(peVersionWords("2.5.1"), [2, 5, 1, 0]);
  assertEquals(peVersionWords("3.1.0-rc.2+b7"), [3, 1, 0, 0]);
  assertEquals(peVersionWords("2"), [2, 0, 0, 0]);
  assertEquals(peVersionWords("2026.70000.1"), [2026, 65535, 1, 0]);
  assertEquals(peVersionWords("weird"), [1, 0, 0, 0]);
});

/** A bundle as the stock `deno desktop` writes it for a CEF runtime with the bootstrap. */
async function stockCefBundle(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "denext_cef_layout_" });
  const dir = join(root, "MyApp-x64");
  await Deno.mkdir(dir);
  await Deno.writeFile(join(dir, "MyApp-x64.exe"), bootstrapLike());
  await Deno.writeFile(join(dir, "MyApp-x64.dll"), enc.encode("THE RUNTIME"));
  await Deno.writeFile(join(dir, "laufey.dll"), enc.encode("THE HOST"));
  await Deno.writeFile(join(dir, "libcef.dll"), enc.encode("CEF"));
  await Deno.writeFile(join(dir, "AppIcon.ico"), ico("APP ICON"));
  return dir;
}

const META = { name: "My App", publisher: "Example Co", version: "2.5.1" };

Deno.test("desktopWindowsCefLayout: host to <App>.dll, runtime to <App>.runtime.dll, the app's resources", async () => {
  const dir = await stockCefBundle();
  try {
    assertEquals(await desktopWindowsCefLayout(dir, META), true);
    const read = (f: string) =>
      Deno.readFile(join(dir, f)).then((b) => new TextDecoder().decode(b));
    assertEquals(await read("MyApp-x64.dll"), "THE HOST");
    assertEquals(await read("MyApp-x64.runtime.dll"), "THE RUNTIME");
    await assertRejects(() => Deno.stat(join(dir, "laufey.dll")), Deno.errors.NotFound);
    const tree = readPeResources(await Deno.readFile(join(dir, "MyApp-x64.exe")));
    const group = tree.get(RT_GROUP_ICON)!.get(32512)!.get(1033)!.data;
    const id = new DataView(group.buffer, group.byteOffset).getUint16(6 + 12, true);
    assertEquals(new TextDecoder().decode(tree.get(RT_ICON)!.get(id)!.get(1033)!.data), "APP ICON");
    assertEquals(versionStrings(tree.get(RT_VERSION)!.get(1)!.get(1033)!.data), {
      CompanyName: "Example Co",
      FileDescription: "My App",
      FileVersion: "2.5.1.0",
      InternalName: "MyApp-x64",
      OriginalFilename: "MyApp-x64.exe",
      ProductName: "My App",
      ProductVersion: "2.5.1",
    });
    assertEquals(
      new TextDecoder().decode(tree.get(RT_MANIFEST)!.get(1)!.get(1033)!.data),
      MANIFEST,
    );
  } finally {
    await Deno.remove(join(dir, ".."), { recursive: true });
  }
});

Deno.test("desktopWindowsCefLayout: a bundle without laufey.dll (webview, a runtime without the sandbox) is left alone", async () => {
  const dir = await stockCefBundle();
  try {
    await Deno.remove(join(dir, "laufey.dll"));
    const exe = await Deno.readFile(join(dir, "MyApp-x64.exe"));
    assertEquals(await desktopWindowsCefLayout(dir, META), false);
    assertEquals(await Deno.readFile(join(dir, "MyApp-x64.exe")), exe);
    assertEquals(
      new TextDecoder().decode(await Deno.readFile(join(dir, "MyApp-x64.dll"))),
      "THE RUNTIME",
    );
  } finally {
    await Deno.remove(join(dir, ".."), { recursive: true });
  }
});

Deno.test("desktopWindowsBootstrapBundle: the stock CLI's bundle is laid out; a forked CLI's is already; webview isn't", async () => {
  const dir = await stockCefBundle();
  try {
    // The stock `deno desktop`: laufey.dll is moved into place.
    assertEquals(await desktopWindowsBootstrapBundle(dir, META), true);
    await assertRejects(() => Deno.stat(join(dir, "laufey.dll")), Deno.errors.NotFound);
    // A `deno desktop` that writes the layout itself: no laufey.dll, `<App>.runtime.dll`. Left
    // as it is, and still the bootstrap layout (the launch passes LAUFEY_CWD).
    const exe = await Deno.readFile(join(dir, "MyApp-x64.exe"));
    assertEquals(await desktopWindowsBootstrapBundle(dir, META), true);
    assertEquals(await Deno.readFile(join(dir, "MyApp-x64.exe")), exe);
    assertEquals(
      new TextDecoder().decode(await Deno.readFile(join(dir, "MyApp-x64.runtime.dll"))),
      "THE RUNTIME",
    );
    // Neither file: the webview backend, or a CEF runtime without the sandbox.
    await Deno.remove(join(dir, "MyApp-x64.runtime.dll"));
    assertEquals(await desktopWindowsBootstrapBundle(dir, META), false);
  } finally {
    await Deno.remove(join(dir, ".."), { recursive: true });
  }
});
