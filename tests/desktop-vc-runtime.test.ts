// The app-local VC++ runtime of a Windows bundle (bundleDesktopVcRuntime): each arch gets only
// the DLLs its `deno desktop` binaries import (the Arm64 launcher imports no vcruntime140_1.dll,
// the FH4 runtime), and every DLL copied from System32 must be a PE image of the target's machine:
// a Windows on Arm System32 holds an x64 vcruntime140_1.dll (the Arm64 redist installs it there
// for emulated x64 code), which once landed in Arm64 bundles. A mismatch bundles nothing and warns
// with the redistributable for the target's arch.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  bundleDesktopVcRuntime,
  DESKTOP_VC_RUNTIME_DLLS,
  desktopPeMachine,
  desktopVcRedistUrl,
  type DesktopVcRuntimeDeps,
  type DesktopWindowsArch,
} from "../src/build/desktop.ts";
import { desktopWindowExitHint } from "../src/build/desktop-vc-runtime.ts";

const MACHINES = { x86_64: 0x8664, arm64: 0xaa64, x86: 0x14c } as const;

/** A minimal PE header: `MZ`, `e_lfanew` → `PE\0\0`, then the file header's `Machine`. */
function pe(machine: number, peAt = 0x80): Uint8Array {
  const bytes = new Uint8Array(peAt + 24);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  const view = new DataView(bytes.buffer);
  view.setUint32(0x3c, peAt, true);
  bytes.set([0x50, 0x45, 0, 0], peAt);
  view.setUint16(peAt + 4, machine, true);
  return bytes;
}

Deno.test("desktopPeMachine reads the PE header's machine", () => {
  assertEquals(desktopPeMachine(pe(MACHINES.x86_64)), "x86_64");
  assertEquals(desktopPeMachine(pe(MACHINES.arm64, 0xf8)), "arm64");
  assertEquals(desktopPeMachine(pe(MACHINES.x86)), "x86");
  assertEquals(desktopPeMachine(pe(0x1c4)), "0x1c4"); // ARMNT
  // A view into a larger buffer reads from its own offset.
  const padded = new Uint8Array(512);
  padded.set(pe(MACHINES.arm64), 100);
  assertEquals(desktopPeMachine(padded.subarray(100)), "arm64");
  // Not a PE image.
  assertEquals(desktopPeMachine(new Uint8Array(0)), null);
  assertEquals(desktopPeMachine(new TextEncoder().encode("MZ".padEnd(128, "."))), null);
  const elf = new Uint8Array(128);
  elf.set([0x7f, 0x45, 0x4c, 0x46]);
  assertEquals(desktopPeMachine(elf), null);
  const truncated = pe(MACHINES.x86_64).subarray(0, 0x82);
  assertEquals(desktopPeMachine(truncated), null);
});

Deno.test("DESKTOP_VC_RUNTIME_DLLS: the Arm64 launcher imports no vcruntime140_1.dll", () => {
  assertEquals(DESKTOP_VC_RUNTIME_DLLS.x86_64, [
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
  ]);
  assertEquals(DESKTOP_VC_RUNTIME_DLLS.arm64, ["vcruntime140.dll", "msvcp140.dll"]);
  assertEquals(desktopVcRedistUrl("x86_64"), "https://aka.ms/vs/17/release/vc_redist.x64.exe");
  assertEquals(desktopVcRedistUrl("arm64"), "https://aka.ms/vs/17/release/vc_redist.arm64.exe");
});

/** A fake host: System32's DLLs by name, the copies and the output it made. */
function host(
  system32: Record<string, Uint8Array>,
  over: Partial<DesktopVcRuntimeDeps> = {},
) {
  const copies: Array<[string, string]> = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const deps: DesktopVcRuntimeDeps = {
    os: "windows",
    systemDir: "SYS",
    readHead: (path) => {
      const bytes = system32[path.slice("SYS/".length)];
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Deno.errors.NotFound(path));
    },
    copyFile: (from, to) => {
      copies.push([from, to]);
      return Promise.resolve();
    },
    log: (m) => logs.push(m),
    warn: (m) => warnings.push(m),
    ...over,
  };
  return { deps, copies, logs, warnings };
}

// What a Windows on Arm System32 holds once the VC++ redist is installed (14.44): Arm64
// vcruntime140 / msvcp140, and an x64 vcruntime140_1.dll.
const WINDOWS_ON_ARM = {
  "vcruntime140.dll": pe(MACHINES.arm64),
  "msvcp140.dll": pe(MACHINES.arm64),
  "vcruntime140_1.dll": pe(MACHINES.x86_64),
};
const WINDOWS_X64 = {
  "vcruntime140.dll": pe(MACHINES.x86_64),
  "vcruntime140_1.dll": pe(MACHINES.x86_64),
  "msvcp140.dll": pe(MACHINES.x86_64),
};

Deno.test("bundleDesktopVcRuntime: Arm64 on Windows on Arm bundles only its own two DLLs", async () => {
  const h = host(WINDOWS_ON_ARM, { hostArch: "arm64" });
  assertEquals(await bundleDesktopVcRuntime("dist/app-arm64", "arm64", h.deps), true);
  assertEquals(h.copies, [
    [join("SYS", "vcruntime140.dll"), join("dist/app-arm64", "vcruntime140.dll")],
    [join("SYS", "msvcp140.dll"), join("dist/app-arm64", "msvcp140.dll")],
  ]);
  assert(!h.copies.some(([from]) => from.endsWith("vcruntime140_1.dll")), "no x64 FH4 DLL");
  assertEquals(h.warnings, []);
  assertStringIncludes(h.logs.join("\n"), "bundled the arm64 VC++ runtime app-local");
});

Deno.test("bundleDesktopVcRuntime: x64 on Windows x64 bundles all three", async () => {
  const h = host(WINDOWS_X64, { hostArch: "x86_64" });
  assertEquals(await bundleDesktopVcRuntime("d", "x86_64", h.deps), true);
  assertEquals(
    h.copies.map(([, to]) => to),
    DESKTOP_VC_RUNTIME_DLLS.x86_64.map((d) => join("d", d)),
  );
  assertEquals(h.warnings, []);
});

Deno.test("bundleDesktopVcRuntime: a DLL of another machine bundles nothing and warns", async () => {
  const cases: Array<[DesktopWindowsArch, Record<string, Uint8Array>, string]> = [
    // An Arm64 bundle whose System32 vcruntime140.dll is an x64 image.
    [
      "arm64",
      { ...WINDOWS_ON_ARM, "vcruntime140.dll": pe(MACHINES.x86_64) },
      "vcruntime140.dll is x86_64, not arm64",
    ],
    [
      "x86_64",
      { ...WINDOWS_X64, "msvcp140.dll": pe(MACHINES.arm64) },
      "msvcp140.dll is arm64, not x86_64",
    ],
    [
      "x86_64",
      { ...WINDOWS_X64, "msvcp140.dll": new Uint8Array(8) },
      "msvcp140.dll is not a PE image",
    ],
  ];
  for (const [arch, system32, said] of cases) {
    const h = host(system32, { hostArch: arch });
    assertEquals(await bundleDesktopVcRuntime("d", arch, h.deps), false, said);
    assertEquals(h.copies, [], `nothing is copied: ${said}`);
    assertEquals(h.warnings.length, 1);
    assertStringIncludes(h.warnings[0], said);
    assertStringIncludes(h.warnings[0], desktopVcRedistUrl(arch));
  }
});

Deno.test("bundleDesktopVcRuntime: a missing DLL bundles nothing; the URL names the arch", async () => {
  const { "msvcp140.dll": _, ...noMsvcp } = WINDOWS_ON_ARM;
  const h = host(noMsvcp, { hostArch: "arm64" });
  assertEquals(await bundleDesktopVcRuntime("d", "arm64", h.deps), false);
  assertEquals(h.copies, []);
  assertStringIncludes(h.warnings[0], "msvcp140.dll is missing");
  assertStringIncludes(h.warnings[0], "vc_redist.arm64.exe");
  assert(!h.warnings[0].includes("vc_redist.x64.exe"), "not the x64 redist for an Arm64 bundle");
});

Deno.test("bundleDesktopVcRuntime: off Windows or for the other arch, nothing is read", async () => {
  for (
    const [os, hostArch, arch] of [
      ["darwin", "arm64", "arm64"],
      ["windows", "x86_64", "arm64"],
      ["windows", "arm64", "x86_64"],
    ] as const
  ) {
    let reads = 0;
    const h = host(WINDOWS_X64, {
      os,
      hostArch,
      readHead: () => {
        reads++;
        return Promise.resolve(new Uint8Array());
      },
    });
    assertEquals(await bundleDesktopVcRuntime("d", arch, h.deps), false);
    assertEquals([reads, h.copies.length], [0, 0]);
    assertStringIncludes(h.warnings[0], `${arch} packaged on ${os}/${hostArch}`);
    assertStringIncludes(h.warnings[0], desktopVcRedistUrl(arch));
  }
});

Deno.test("bundleDesktopVcRuntime: reads real files by default", async () => {
  const sys = await Deno.makeTempDir({ prefix: "denext_vcrt_sys_" });
  const dir = await Deno.makeTempDir({ prefix: "denext_vcrt_bundle_" });
  try {
    for (const [name, bytes] of Object.entries(WINDOWS_ON_ARM)) {
      // Larger than the 4 KiB head that is read.
      const big = new Uint8Array(10_000);
      big.set(bytes);
      await Deno.writeFile(join(sys, name), big);
    }
    const warnings: string[] = [];
    const ok = await bundleDesktopVcRuntime(dir, "arm64", {
      os: "windows",
      hostArch: "arm64",
      systemDir: sys,
      log: () => {},
      warn: (m) => warnings.push(m),
    });
    assertEquals([ok, warnings], [true, []]);
    const names = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assertEquals(names.sort(), ["msvcp140.dll", "vcruntime140.dll"]);
    assertEquals((await Deno.stat(join(dir, "msvcp140.dll"))).size, 10_000);
  } finally {
    await Deno.remove(sys, { recursive: true });
    await Deno.remove(dir, { recursive: true });
  }
});

// An unpackaged window (`desktop run` / `dev`) loads the VC++ runtime from System32: without the
// redistributable it exits with STATUS_DLL_NOT_FOUND before printing anything (seen on a fresh
// Windows on Arm VM), so the verb names the missing redistributable.
Deno.test("desktopWindowExitHint explains a window that Windows refused to start", () => {
  const signed = -1073741515; // 0xC0000135 as Deno reports it
  const arm = desktopWindowExitHint(signed, "windows", "arm64");
  assert(arm !== null);
  assertStringIncludes(arm, "0xC0000135");
  assertStringIncludes(arm, "vcruntime140.dll, msvcp140.dll");
  assertStringIncludes(arm, desktopVcRedistUrl("arm64"));
  const x64 = desktopWindowExitHint(0xc0000135, "windows", "x86_64");
  assert(x64 !== null);
  assertStringIncludes(x64, "vcruntime140_1.dll");
  assertStringIncludes(x64, desktopVcRedistUrl("x86_64"));
  // Any other exit, or another OS, gets no hint.
  assertEquals(desktopWindowExitHint(0, "windows", "arm64"), null);
  assertEquals(desktopWindowExitHint(1, "windows", "arm64"), null);
  assertEquals(desktopWindowExitHint(signed, "linux", "x86_64"), null);
});
