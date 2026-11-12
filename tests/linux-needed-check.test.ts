// scripts/ci/linux-needed-check.ts: the Linux packages' NEEDED check, on ELF files built here
// (64- and 32-bit, both byte orders) and on the libraries the pinned runtime's launchers really
// need (read from 3.0.0-denext.17's x86_64 webview and CEF archives; 3.0.0-denext.21's pass
// `checkTree` against the same dependencies with no problem).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  checkTree,
  declaredSonames,
  type ElfDynamic,
  neededProblems,
  readElfDynamic,
} from "../scripts/ci/linux-needed-check.ts";
import { LINUX_RUNTIME_DEPS } from "../src/build/desktop-installers.ts";

/** Header, program-header and dynamic-entry sizes and offsets, per ELF class. */
const CLASSES = {
  64: { ehsize: 64, phentsize: 56, dyn: 16, phoff: 0x20, phent: 0x36, phnum: 0x38, p: [8, 16, 32] },
  32: { ehsize: 52, phentsize: 32, dyn: 8, phoff: 0x1c, phent: 0x2a, phnum: 0x2c, p: [4, 8, 16] },
} as const;

/** The string table for `names` (index 0 is the empty string) and each name's offset. */
function stringTable(names: readonly string[]): { bytes: Uint8Array; offsets: number[] } {
  let text = "\0";
  const offsets = names.map((n) => {
    const at = text.length;
    text += `${n}\0`;
    return at;
  });
  return { bytes: new TextEncoder().encode(text), offsets };
}

/** A minimal dynamically linked ELF file: one PT_LOAD over the file, a PT_DYNAMIC, a string table. */
function elf(
  needed: readonly string[],
  opts: { soname?: string; is64?: boolean; le?: boolean } = {},
): Uint8Array {
  const { is64 = true, le = true } = opts;
  const c = CLASSES[is64 ? 64 : 32];
  const base = 0x400000;
  const names = opts.soname ? [...needed, opts.soname] : [...needed];
  const str = stringTable(names);
  const tags: [number, number][] = names.map((
    _,
    i,
  ) => [i < needed.length ? 1 : 14, str.offsets[i]]);
  const dynOff = c.ehsize + 2 * c.phentsize;
  const strOff = dynOff + (tags.length + 3) * c.dyn;
  tags.push([5, base + strOff], [10, str.bytes.length], [0, 0]);
  const out = new Uint8Array(strOff + str.bytes.length);
  const v = new DataView(out.buffer);
  const w = (at: number, val: number) =>
    is64 ? v.setBigUint64(at, BigInt(val), le) : v.setUint32(at, val, le);
  out.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, le ? 1 : 2, 1], 0);
  v.setUint16(0x10, 3, le); // ET_DYN
  w(c.phoff, c.ehsize);
  v.setUint16(c.phent, c.phentsize, le);
  v.setUint16(c.phnum, 2, le);
  const segs: [number, number, number][] = [[1, 0, out.length], [2, dynOff, strOff - dynOff]];
  segs.forEach(([type, offset, filesz], i) => {
    const at = c.ehsize + i * c.phentsize;
    v.setUint32(at, type, le);
    [offset, base + offset, filesz].forEach((val, j) => w(at + c.p[j], val));
  });
  tags.forEach(([tag, val], i) => {
    w(dynOff + i * c.dyn, tag);
    w(dynOff + i * c.dyn + c.dyn / 2, val);
  });
  out.set(str.bytes, strOff);
  return out;
}

/** The launcher, runtime library and helpers of the pinned runtime, as their NEEDED lists. */
const WEBVIEW_RUNTIME = new Map<string, ElfDynamic>([
  ["laufey/webview/build/laufey_webview", {
    needed: [
      "libwebkit2gtk-4.1.so.0",
      "libgtk-3.so.0",
      "libgdk-3.so.0",
      "libsoup-3.0.so.0",
      "libgio-2.0.so.0",
      "libjavascriptcoregtk-4.1.so.0",
      "libgobject-2.0.so.0",
      "libglib-2.0.so.0",
      "libcairo.so.2",
      "libgdk_pixbuf-2.0.so.0",
      "libxcb.so.1",
      "libwayland-client.so.0",
      "libstdc++.so.6",
      "libm.so.6",
      "libgcc_s.so.1",
      "libc.so.6",
      "ld-linux-x86-64.so.2",
    ],
  }],
  ["laufey/webview/build/liblaufey_webauthn.so", {
    needed: ["libudev.so.1", "libgcc_s.so.1", "libm.so.6", "libc.so.6", "ld-linux-x86-64.so.2"],
  }],
  ["libdenort.so", {
    needed: ["libz.so.1", "libgcc_s.so.1", "libm.so.6", "libc.so.6", "ld-linux-x86-64.so.2"],
  }],
]);

/** CEF's own NEEDED lists beyond the declared CEF libraries (libcef.so ships in the package). */
const CEF_RUNTIME = new Map<string, ElfDynamic>([
  ["laufey/cef/build/Release/laufey", {
    needed: ["libcef.so", "libgtk-3.so.0", "libgdk-3.so.0", "libX11.so.6", "libXi.so.6"],
  }],
  ["laufey/cef/build/Release/libcef.so", {
    soname: "libcef.so",
    needed: [
      ...LINUX_RUNTIME_DEPS.cef.map(([so]) => so),
      "libatspi.so.0",
      "libgio-2.0.so.0",
      "libglib-2.0.so.0",
      "libgobject-2.0.so.0",
      "libwayland-client.so.0",
      "libdl.so.2",
      "libpthread.so.0",
    ],
  }],
  ["laufey/cef/build/Release/libvulkan.so.1", { soname: "libvulkan.so.1", needed: ["libc.so.6"] }],
]);

/** A Debian `Depends` field like the package script writes for `backend`. */
function depends(backend: string, extra: string[] = []): string {
  return [...new Set([...LINUX_RUNTIME_DEPS[backend].map(([, p]) => p), ...extra])].join(", ");
}

/** `rpm -qpR` output like the package script's spec gives for `backend`. */
function rpmRequires(backend: string): string {
  return [
    ...LINUX_RUNTIME_DEPS[backend].map(([so]) => `${so}()(64bit)`),
    "libsecret",
    "rpmlib(CompressedFileNames) <= 3.0.4-1",
    "/bin/sh",
  ].join("\n");
}

Deno.test("readElfDynamic: NEEDED and SONAME from 64- and 32-bit files of either byte order", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const [is64, le] of [[true, true], [true, false], [false, true], [false, false]]) {
      const path = join(dir, `lib-${is64}-${le}.so`);
      await Deno.writeFile(
        path,
        elf(["libgtk-3.so.0", "libc.so.6"], { soname: "libx.so.1", is64, le }),
      );
      assertEquals(await readElfDynamic(path), {
        needed: ["libgtk-3.so.0", "libc.so.6"],
        soname: "libx.so.1",
      }, `is64=${is64} le=${le}`);
    }
    await Deno.writeTextFile(join(dir, "script.sh"), "#!/bin/sh\necho hi\n");
    assertEquals(await readElfDynamic(join(dir, "script.sh")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("declaredSonames: Debian Depends by package, RPM Requires by soname", () => {
  assertEquals(
    [...declaredSonames("libwebkit2gtk-4.1-0 (>= 2.40), libgtk-3-0 | libgtk3, libsecret-1-0")]
      .sort(),
    ["libgtk-3.so.0", "libwebkit2gtk-4.1.so.0"],
  );
  const rpm = declaredSonames(rpmRequires("webview"));
  assert(rpm.has("libwebkit2gtk-4.1.so.0") && rpm.has("libgtk-3.so.0"));
  assert(![...rpm].some((s) => s.startsWith("rpmlib") || s.startsWith("/")));
  // Debian's libnss3 covers three of CEF's sonames.
  const cef = declaredSonames(depends("cef"));
  for (const so of ["libnss3.so", "libnssutil3.so", "libsmime3.so"]) assert(cef.has(so), so);
});

Deno.test("the pinned runtime's real needs pass against the packages' own dependencies", () => {
  for (const declared of [depends("webview", ["libsecret-1-0"]), rpmRequires("webview")]) {
    assertEquals(neededProblems(WEBVIEW_RUNTIME, declaredSonames(declared), new Set()), []);
  }
  for (const declared of [depends("cef"), rpmRequires("cef")]) {
    assertEquals(neededProblems(CEF_RUNTIME, declaredSonames(declared), new Set()), []);
  }
});

Deno.test("an undeclared library fails, naming the file and the soname", () => {
  // CEF's launcher against the webview backend's dependencies: libX11 comes with GTK, libXi doesn't.
  const problems = neededProblems(
    new Map([["laufey", CEF_RUNTIME.get("laufey/cef/build/Release/laufey")!]]),
    declaredSonames(depends("webview")),
    new Set(["libcef.so"]),
  );
  assertEquals(problems.map((p) => [p.file, p.library]), [["laufey", "libXi.so.6"]]);
  // Without libcef.so in the package, its absence fails too.
  const missing = neededProblems(
    new Map([["laufey", { needed: ["libcef.so"] }]]),
    declaredSonames(depends("cef")),
    new Set(),
  );
  assertEquals(missing.map((p) => p.library), ["libcef.so"]);
});

Deno.test("libnode.so* fails whatever is declared", () => {
  const files = new Map<string, ElfDynamic>([
    ["usr/lib/app/node_modules/pty/pty.node", { needed: ["libnode.so.115", "libc.so.6"] }],
  ]);
  const problems = neededProblems(files, new Set(["libnode.so.115"]), new Set(["libnode.so.115"]));
  assertEquals(problems.map((p) => p.library), ["libnode.so.115"]);
  assert(problems[0].reason.includes("shared Node.js"));
});

Deno.test("checkTree: an unpacked package, read from disk", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lib = join(dir, "usr", "lib", "app");
    await Deno.mkdir(lib, { recursive: true });
    await Deno.writeFile(
      join(lib, "app-x64"),
      elf(["libwebkit2gtk-4.1.so.0", "libsoup-3.0.so.0", "libdenort.so", "libc.so.6"]),
    );
    await Deno.writeFile(join(lib, "libdenort.so"), elf(["libz.so.1"], { soname: "libdenort.so" }));
    await Deno.writeTextFile(join(lib, "laufey-launch.json"), "{}");
    const ok = await checkTree(dir, depends("webview"));
    assertEquals(ok.files.size, 2);
    assertEquals(ok.problems, []);
    await Deno.writeFile(join(lib, "addon.node"), elf(["libnode.so.109", "libfoo.so.3"]));
    const bad = await checkTree(dir, depends("webview"));
    assertEquals(bad.problems.map((p) => [p.file, p.library]).sort(), [
      [join("usr", "lib", "app", "addon.node"), "libfoo.so.3"],
      [join("usr", "lib", "app", "addon.node"), "libnode.so.109"],
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
