// The app-local VC++ runtime of a Windows desktop bundle: which DLLs each architecture's
// `deno desktop` binaries import, and copying them from System32 only when they are the target's
// machine type. Reached through `denext/desktop` from the scaffolded `scripts/package-windows.ts`.

import { join } from "@std/path";

/** A Windows bundle's architecture, as the package script names it. */
export type DesktopWindowsArch = "x86_64" | "arm64";

/**
 * The VC++ 2015-2022 runtime DLLs each architecture's `deno desktop` binaries import (read from
 * the pinned runtime's import tables). The x64 launcher also imports `vcruntime140_1.dll`, the
 * FH4 exception-handling runtime; the Arm64 launcher does not. On Windows on Arm, System32's
 * `vcruntime140_1.dll` (which the Arm64 redist installs there itself) is an x64 image, for x64
 * code under emulation, beside the Arm64 `vcruntime140.dll` and `msvcp140.dll`.
 */
export const DESKTOP_VC_RUNTIME_DLLS: Readonly<Record<DesktopWindowsArch, readonly string[]>> = {
  x86_64: ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"],
  arm64: ["vcruntime140.dll", "msvcp140.dll"],
};

/** PE `IMAGE_FILE_HEADER.Machine` values, by the names the package script uses. */
const PE_MACHINES: Readonly<Record<number, string>> = {
  0x8664: "x86_64",
  0xaa64: "arm64",
  0x14c: "x86",
};

/**
 * The VC++ 2015-2022 redistributable installer for `arch`.
 *
 * @param arch The target architecture.
 * @returns Its download URL.
 */
export function desktopVcRedistUrl(arch: DesktopWindowsArch): string {
  return `https://aka.ms/vs/17/release/vc_redist.${arch === "arm64" ? "arm64" : "x64"}.exe`;
}

/**
 * The machine a PE image is built for, read from its header (`MZ`, `e_lfanew` → `PE\0\0`, then
 * the file header's `Machine`): `"x86_64"`, `"arm64"`, `"x86"`, or `0x<hex>` for another one.
 * An Arm64X DLL reports `"arm64"`.
 *
 * @param head The file's first bytes (4 KiB is plenty).
 * @returns The machine, or `null` when `head` is not a PE image.
 */
export function desktopPeMachine(head: Uint8Array): string | null {
  if (head.length < 64 || head[0] !== 0x4d || head[1] !== 0x5a) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (pe < 64 || pe + 6 > head.length || view.getUint32(pe, false) !== 0x50450000) return null;
  const machine = view.getUint16(pe + 4, true);
  return PE_MACHINES[machine] ?? `0x${machine.toString(16)}`;
}

/** What {@linkcode bundleDesktopVcRuntime} reads the machine and files through (tests stub them). */
export interface DesktopVcRuntimeDeps {
  /** The host OS (default `Deno.build.os`). */
  readonly os?: string;
  /** The host architecture (default from `Deno.build.arch`). */
  readonly hostArch?: DesktopWindowsArch;
  /** Where the installed runtime lives (default `%SystemRoot%\System32`). */
  readonly systemDir?: string;
  /** Reads a file's first bytes; throws when it is missing (default: up to 4 KiB of the file). */
  readonly readHead?: (path: string) => Promise<Uint8Array>;
  /** Copies a file (default `Deno.copyFile`). */
  readonly copyFile?: (from: string, to: string) => Promise<void>;
  /** Prints progress (default `console.log`). */
  readonly log?: (message: string) => void;
  /** Prints a warning (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

/** Up to the first 4 KiB of `path`. */
async function readHead(path: string): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(4096);
    let n = 0;
    while (n < buf.length) {
      const got = await file.read(buf.subarray(n));
      if (got === null) break;
      n += got;
    }
    return buf.subarray(0, n);
  } finally {
    file.close();
  }
}

/** Why each of `dlls` in `sys` can't be bundled for `arch` (empty when all can). */
async function vcRuntimeProblems(
  sys: string,
  dlls: readonly string[],
  arch: DesktopWindowsArch,
  read: (path: string) => Promise<Uint8Array>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const dll of dlls) {
    let head: Uint8Array;
    try {
      head = await read(join(sys, dll));
    } catch {
      problems.push(`${dll} is missing`);
      continue;
    }
    const machine = desktopPeMachine(head);
    if (machine !== arch) {
      problems.push(`${dll} is ${machine ?? "not a PE image"}, not ${arch}`);
    }
  }
  return problems;
}

/**
 * Ship the VC++ 2015-2022 runtime DLLs `arch`'s `deno desktop` binaries import
 * ({@linkcode DESKTOP_VC_RUNTIME_DLLS}) next to the bundle's .exe, so the packaged app runs with
 * NO redistributable installed on the target (otherwise it dies at launch with a silent
 * 0xC0000135 DLL-not-found). Microsoft permits this app-local deployment. They come from System32
 * (the installed redist) when packaging on Windows for the host's architecture, and each one must
 * be a PE image of `arch` — a Windows on Arm System32 holds x64 VC++ DLLs beside the Arm64 ones.
 * All or nothing: when any is missing or another machine's (or packaging off Windows, or for the
 * other architecture), none is copied and a warning names the redistributable the target needs.
 *
 * @param dir The bundle directory.
 * @param arch The bundle's architecture.
 * @param deps The host, file access and output sinks.
 * @returns Whether the runtime was bundled.
 */
export async function bundleDesktopVcRuntime(
  dir: string,
  arch: DesktopWindowsArch,
  deps: DesktopVcRuntimeDeps = {},
): Promise<boolean> {
  const os = deps.os ?? Deno.build.os;
  const hostArch = deps.hostArch ?? (Deno.build.arch === "aarch64" ? "arm64" : "x86_64");
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const redist = `the target must install the VC++ 2015-2022 redistributable: ${
    desktopVcRedistUrl(arch)
  }`;
  if (os !== "windows" || arch !== hostArch) {
    warn(
      `  not bundling the VC++ runtime (${arch} packaged on ${os}/${hostArch}) — ${redist}`,
    );
    return false;
  }
  const sys = deps.systemDir ??
    join(Deno.env.get("SystemRoot") ?? "C:\\Windows", "System32");
  const dlls = DESKTOP_VC_RUNTIME_DLLS[arch];
  const problems = await vcRuntimeProblems(sys, dlls, arch, deps.readHead ?? readHead);
  if (problems.length > 0) {
    warn(
      `  not bundling the VC++ runtime: in ${sys}, ${problems.join("; ")} — package on Windows ` +
        `with the ${arch} VC++ 2015-2022 redistributable installed, or ${redist}`,
    );
    return false;
  }
  const copy = deps.copyFile ?? Deno.copyFile;
  for (const dll of dlls) await copy(join(sys, dll), join(dir, dll));
  (deps.log ?? ((message: string) => console.log(message)))(
    `  bundled the ${arch} VC++ runtime app-local (${dlls.join(", ")}; the target needs no ` +
      "VC++ redistributable)",
  );
  return true;
}

/** Windows' `STATUS_DLL_NOT_FOUND`, the exit status of a process whose imports didn't load. */
const STATUS_DLL_NOT_FOUND = 0xc0000135;

/**
 * Why an unpackaged window (`denext desktop run` / `dev`) exited at once, when its exit code says
 * Windows refused to start it: `0xC0000135`, an imported DLL not found. The scratch build loads
 * the VC++ 2015-2022 runtime from System32 (only a packaged bundle carries it app-local), so on a
 * machine without the redistributable for its architecture (a fresh Windows on Arm one, say) the
 * window exits before it prints anything.
 *
 * @param code The window process's exit code (Deno reports it signed: `-1073741515`).
 * @param os The host OS (default `Deno.build.os`).
 * @param hostArch The host architecture (default from `Deno.build.arch`).
 * @returns The lines to print, or `null` for any other exit.
 */
export function desktopWindowExitHint(
  code: number,
  os: string = Deno.build.os,
  hostArch: DesktopWindowsArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64",
): string | null {
  if (os !== "windows" || code >>> 0 !== STATUS_DLL_NOT_FOUND) return null;
  return `denext: the desktop window could not start: Windows did not find a DLL it imports ` +
    `(0xC0000135).\n  It loads the VC++ 2015-2022 runtime (${
      DESKTOP_VC_RUNTIME_DLLS[hostArch].join(", ")
    }) from System32; install the ${hostArch} redistributable: ${desktopVcRedistUrl(hostArch)}`;
}
