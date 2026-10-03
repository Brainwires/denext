// The cross-built package check Desktop CI runs on every `--target-os` leg
// (scripts/ci/desktop-cross-package-check.ts): the PE / ELF / Mach-O sniffing, the tar / pax / ar
// readers, and a whole bundle + archives judged right or wrong.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  arMembers,
  binaryKind,
  checkCrossPackage,
  gunzip,
  tarEntries,
} from "../scripts/ci/desktop-cross-package-check.ts";
import { arArchive, buildDesktopDeb, packageMetaFrom } from "../src/build/desktop-installers.ts";

const ENC = new TextEncoder();

/** A minimal PE image head for `machine`. */
function pe(machine: number): Uint8Array {
  const b = new Uint8Array(256);
  b.set([0x4d, 0x5a]);
  const v = new DataView(b.buffer);
  v.setUint32(0x3c, 0x80, true);
  v.setUint32(0x80, 0x50450000, false);
  v.setUint16(0x84, machine, true);
  return b;
}

/** A minimal little-endian 64-bit ELF head for `machine`. */
function elf(machine: number): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  new DataView(b.buffer).setUint16(18, machine, true);
  return b;
}

const MACHO = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);

/** One ustar member (`type` "0" file, "2" symlink, "5" dir, "x" pax header). */
function tarMember(name: string, mode: number, body: Uint8Array, type = "0"): Uint8Array {
  const h = new Uint8Array(512);
  h.set(ENC.encode(name).subarray(0, 100), 0);
  h.set(ENC.encode(mode.toString(8).padStart(7, "0") + "\0"), 100);
  h.set(ENC.encode(body.length.toString(8).padStart(11, "0") + "\0"), 124);
  h[156] = type.charCodeAt(0);
  h.set(ENC.encode("ustar\0"), 257);
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  const out = new Uint8Array(512 + padded.length);
  out.set(h);
  out.set(padded, 512);
  return out;
}

/** A tar archive of `members`, with its end blocks. */
function tar(...members: Uint8Array[]): Uint8Array {
  const parts = [...members, new Uint8Array(1024)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** gzip `bytes`. */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

Deno.test("binaryKind: PE, ELF and Mach-O machines; anything else is null", () => {
  assertEquals(binaryKind(pe(0x8664)), { format: "pe", arch: "x64" });
  assertEquals(binaryKind(pe(0xaa64)), { format: "pe", arch: "arm64" });
  assertEquals(binaryKind(elf(62)), { format: "elf", arch: "x64" });
  assertEquals(binaryKind(elf(183)), { format: "elf", arch: "arm64" });
  assertEquals(binaryKind(MACHO)?.format, "macho");
  assertEquals(binaryKind(ENC.encode("MZ but not a PE image at all, just text")), null);
  assertEquals(binaryKind(ENC.encode("{}")), null);
});

Deno.test("tarEntries: ustar modes and types, a pax path, ./ stripped", () => {
  const long = "d/" + "x".repeat(120);
  const entries = tarEntries(tar(
    tarMember("./app/", 0o755, new Uint8Array(), "5"),
    tarMember("./app/run", 0o755, ENC.encode("#!/bin/sh\n")),
    tarMember("PaxHeader", 0o644, ENC.encode(`${12 + long.length} path=${long}\n`), "x"),
    tarMember("truncated", 0o644, ENC.encode("data")),
    tarMember("link", 0o777, new Uint8Array(), "2"),
  ));
  assertEquals(entries.map((e) => [e.path, e.mode, e.type]), [
    ["app", 0o755, "5"],
    ["app/run", 0o755, "0"],
    [long, 0o644, "0"],
    ["link", 0o777, "2"],
  ]);
});

Deno.test("arMembers: reads back what arArchive writes", () => {
  const m = arMembers(arArchive([["a", new Uint8Array([1])], ["bb", new Uint8Array([2, 3])]], 0));
  assertEquals([...m.keys()], ["a", "bb"]);
  assertEquals([...m.get("bb")!], [2, 3]);
});

/** A dist/ holding a Windows bundle (`exe` and `dll` heads) and its .zip. */
async function windowsDist(exe: Uint8Array, dll: Uint8Array): Promise<string> {
  const dist = await Deno.makeTempDir();
  const dir = join(dist, "app-x64");
  await Deno.mkdir(dir);
  await Deno.writeFile(join(dir, "app-x64.exe"), exe);
  await Deno.writeFile(join(dir, "WebView2Loader.dll"), dll);
  await Deno.writeTextFile(join(dir, "laufey-launch.json"), "{}");
  await Deno.writeFile(
    join(dist, "app-x64-windows.zip"),
    new Uint8Array([0x50, 0x4b, 3, 4, ...ENC.encode("app-x64/app-x64.exe")]),
  );
  return dist;
}

Deno.test("checkCrossPackage: a Windows x64 bundle + .zip of the target's binaries passes", async () => {
  const dist = await windowsDist(pe(0x8664), pe(0x8664));
  try {
    const x = { dist, name: "app", os: "windows", label: "x64", formats: ["zip"] } as const;
    assertEquals(await checkCrossPackage(x), []);
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});

Deno.test("checkCrossPackage: a host binary in a Windows bundle, or the wrong arch, fails", async () => {
  const dist = await windowsDist(pe(0xaa64), MACHO);
  try {
    const x = { dist, name: "app", os: "windows", label: "x64", formats: ["zip"] } as const;
    const problems = (await checkCrossPackage(x)).join("\n");
    assertStringIncludes(problems, "app-x64.exe is pe arm64, not pe x64");
    assertStringIncludes(problems, "WebView2Loader.dll is macho");
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});

Deno.test("checkCrossPackage: no bundle and no archive are each a problem", async () => {
  const dist = await Deno.makeTempDir();
  try {
    const x = { dist, name: "app", os: "linux", label: "x64", formats: ["tar.gz", "deb"] } as const;
    const problems = await checkCrossPackage(x);
    assertEquals(problems.length, 3);
    assertStringIncludes(problems[0], "no bundle directory");
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});

/** A dist/ holding a Linux bundle and its .tar.gz with the launcher at `mode`. */
async function linuxDist(mode: number): Promise<string> {
  const dist = await Deno.makeTempDir();
  const dir = join(dist, "app-x64");
  await Deno.mkdir(dir);
  await Deno.writeFile(join(dir, "app-x64"), elf(62));
  await Deno.writeFile(join(dir, "libwebview.so"), elf(62));
  await Deno.writeFile(
    join(dist, "app-x64-linux.tar.gz"),
    await gzip(tar(
      tarMember("app-x64/", 0o755, new Uint8Array(), "5"),
      tarMember("app-x64/app-x64", mode, elf(62)),
    )),
  );
  return dist;
}

Deno.test("checkCrossPackage: the .tar.gz launcher must be executable", async () => {
  const ok = await linuxDist(0o755);
  const bad = await linuxDist(0o644);
  try {
    const x = { name: "app", os: "linux", label: "x64", formats: ["tar.gz"] } as const;
    assertEquals(await checkCrossPackage({ ...x, dist: ok }), []);
    assertEquals(await checkCrossPackage({ ...x, dist: bad }), [
      `${join(bad, "app-x64-linux.tar.gz")}: app-x64/app-x64 is not executable (mode 644)`,
    ]);
  } finally {
    await Deno.remove(ok, { recursive: true });
    await Deno.remove(bad, { recursive: true });
  }
});

Deno.test({
  name: "checkCrossPackage: a .deb from buildDesktopDeb passes",
  ignore: Deno.build.os === "windows", // symlinks in the staging tree need privileges there
}, async () => {
  const dist = await linuxDist(0o755);
  try {
    const bundle = join(dist, "app-x64");
    await Deno.chmod(join(bundle, "app-x64"), 0o755).catch(() => {});
    const meta = packageMetaFrom(
      { version: "1.0.0" },
      { desktop: { app: { name: "app", identifier: "com.example.app" } } },
      "app",
    );
    await buildDesktopDeb({
      meta,
      bundleDir: bundle,
      exe: "app-x64",
      arch: "x86_64",
      out: join(dist, "app-x64.deb"),
    });
    const x = { dist, name: "app", os: "linux", label: "x64", formats: ["deb"] } as const;
    assertEquals(await checkCrossPackage(x), []);
    const data = arMembers(await Deno.readFile(join(dist, "app-x64.deb"))).get("data.tar.gz");
    assert(tarEntries(await gunzip(data!)).some((e) => e.path === "usr/bin/app"));
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});
