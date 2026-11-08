// Node-API addons (`*.node`) a Linux desktop app ships that cannot load in it: one built against
// a distribution's shared Node.js (`NEEDED libnode.so.<abi>`, what `node-gyp` produces under
// Debian's / Fedora's `nodejs` package) needs a `libnode` the app's runtime does not provide, so it
// fails at the first `require()` on every machine without that package. Built against Node's own
// headers (or an npm prebuilt) an addon resolves the N-API symbols from the process, which the
// runtime provides.
//
// The check reads each ELF addon's dynamic section (`readelf -d`, else `objdump -p`, else `ldd`)
// for a `libnode.so*` NEEDED entry. The package script runs it over the bundle and the copied
// sidecar packages (`.deno-desktop/sidecars/`) and fails the build; `denext desktop doctor` runs
// it over the project's `node_modules` and `.deno-desktop/` and warns.

import { join } from "@std/path";
import { runToExit } from "./exited-output.ts";

/** How to fix an addon that links `libnode`. */
export const NATIVE_ADDON_LIBNODE_FIX =
  "rebuild the addon against Node's own headers (`npx node-gyp rebuild` with a Node.js from " +
  "nodejs.org, not the distribution's nodejs package) or install the package's npm prebuilt " +
  "(prebuilds/linux-<arch>/), which links no libnode";

/**
 * The shared libraries a dynamic-section listing names: `readelf -d`'s `(NEEDED) Shared library:
 * [x]`, `objdump -p`'s `NEEDED x`, or `ldd`'s `x => …` / `x (0x…)` lines.
 *
 * @param output The tool's output.
 * @returns The libraries, in order.
 */
export function neededLibraries(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split("\n")) {
    const readelf = /\(NEEDED\)\s+Shared library:\s*\[([^\]]+)\]/.exec(line);
    const objdump = /^\s*NEEDED\s+(\S+)\s*$/.exec(line);
    const ldd = /^\s*([^\s/]+\.so[^\s]*)\s+(?:=>|\(0x)/.exec(line);
    const lib = readelf?.[1] ?? objdump?.[1] ?? ldd?.[1];
    if (lib) out.push(lib);
  }
  return out;
}

/**
 * The `libnode.so*` an addon needs, if any.
 *
 * @param needed Its NEEDED libraries ({@linkcode neededLibraries}).
 * @returns The library, or `undefined`.
 */
export function libnodeNeeded(needed: readonly string[]): string | undefined {
  return needed.find((l) => /^libnode\.so(\.\d+)*$/.test(l));
}

/** Whether `path` starts with the ELF magic. */
async function isElf(path: string): Promise<boolean> {
  try {
    using f = await Deno.open(path);
    const head = new Uint8Array(4);
    const n = await f.read(head);
    return n === 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
  } catch {
    return false;
  }
}

/** The deepest directory level searched below a root (pnpm layouts nest about 8 deep). */
const MAX_DEPTH = 12;

/**
 * The ELF `*.node` files under `roots` (symlinked directories are not followed; a missing root
 * is skipped), sorted. A Mach-O or PE addon (a macOS / Windows build) is not listed.
 *
 * @param roots The directories to search.
 * @returns The addons' paths.
 */
export async function findElfAddons(roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory && depth < MAX_DEPTH) await walk(path, depth + 1);
      else if (e.isFile && e.name.endsWith(".node") && await isElf(path)) out.push(path);
    }
  };
  for (const root of roots) await walk(root, 0);
  return [...new Set(out)].sort();
}

/** One addon that links a distribution's `libnode`. */
export interface NativeAddonProblem {
  /** The addon's path. */
  readonly addon: string;
  /** The `libnode.so.<abi>` it needs. */
  readonly library: string;
}

/** What {@linkcode linuxNativeAddonProblems} found. */
export interface NativeAddonScan {
  /** Every ELF addon found. */
  readonly addons: readonly string[];
  /** Those that link `libnode`. */
  readonly problems: readonly NativeAddonProblem[];
  /** Why the addons were not checked (no `readelf`, `objdump` or `ldd`), when they weren't. */
  readonly note?: string;
}

/** The seams of {@linkcode linuxNativeAddonProblems}. */
export interface NativeAddonScanDeps {
  /**
   * Runs a tool and answers its stdout, or `null` when the tool is not installed (default
   * `Deno.Command`).
   */
  readonly run?: (cmd: string, args: string[]) => Promise<string | null>;
}

/** The dynamic-section readers, in order of preference, with their argv. */
const READERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["readelf", ["-d"]],
  ["objdump", ["-p"]],
  ["ldd", []],
];

/** Runs `cmd args` and answers its stdout; `null` when it cannot be started (not installed). */
async function runText(cmd: string, args: string[]): Promise<string | null> {
  try {
    const out = await runToExit(cmd, { args, stdout: "piped", stderr: "null" });
    return new TextDecoder().decode(out.stdout);
  } catch {
    return null;
  }
}

/**
 * Check every ELF Node-API addon under `roots` for a `libnode.so*` dependency. With no addon there
 * is nothing to check (and no note); with addons but no `readelf`, `objdump` or `ldd` to run the
 * scan says so in `note` and reports no problem.
 *
 * @param roots The directories to search ({@linkcode findElfAddons}).
 * @param deps Seams.
 * @returns The addons, the problems and any note.
 */
export async function linuxNativeAddonProblems(
  roots: readonly string[],
  deps: NativeAddonScanDeps = {},
): Promise<NativeAddonScan> {
  const addons = await findElfAddons(roots);
  if (addons.length === 0) return { addons, problems: [] };
  const run = deps.run ?? runText;
  const problems: NativeAddonProblem[] = [];
  // The first reader that runs reads them all (tried in order on the first addon).
  let readers = READERS;
  for (const addon of addons) {
    let output: string | null = null;
    while (readers.length > 0 && output === null) {
      output = await run(readers[0][0], [...readers[0][1], addon]);
      if (output === null) readers = readers.slice(1);
    }
    if (output === null) {
      return {
        addons,
        problems: [],
        note: `${addons.length} Node-API addon(s) not checked for a libnode dependency: no ` +
          "readelf (binutils), objdump or ldd on PATH",
      };
    }
    const library = libnodeNeeded(neededLibraries(output));
    if (library) problems.push({ addon, library });
  }
  return { addons, problems };
}

/**
 * One line per addon that links `libnode`, for an error or a doctor finding.
 *
 * @param problems The problems.
 * @returns The message.
 */
export function nativeAddonMessage(problems: readonly NativeAddonProblem[]): string {
  return problems.map((p) =>
    `${p.addon} links ${p.library} (a distribution's shared Node.js), which the app's runtime ` +
    "does not provide: it fails to load"
  ).join("; ");
}

/**
 * The package script's check of a finished Linux bundle: the addons in the bundle and in the
 * project's copied sidecar packages (`.deno-desktop/sidecars/`). Throws when one links `libnode`;
 * prints the note when the addons could not be checked.
 *
 * @param projectDir The project directory.
 * @param bundleDir The finished bundle directory.
 * @param deps Seams.
 * @throws {Error} Naming each addon and the fix.
 */
export async function assertLinuxNativeAddons(
  projectDir: string,
  bundleDir: string,
  deps: NativeAddonScanDeps = {},
): Promise<void> {
  const scan = await linuxNativeAddonProblems(
    [bundleDir, join(projectDir, ".deno-desktop", "sidecars")],
    deps,
  );
  if (scan.note) console.warn(`  note: ${scan.note}.`);
  if (scan.problems.length > 0) {
    throw new Error(
      `cannot package for Linux: ${nativeAddonMessage(scan.problems)}. To fix it, ` +
        `${NATIVE_ADDON_LIBNODE_FIX}.`,
    );
  }
}
