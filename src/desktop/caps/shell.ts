/**
 * The `shell` capability: `openExternal` / `openPath` / `revealInFileManager` / `moveToTrash` on
 * Deno Desktop (see `src/desktop/native.ts`). Each runs a system tool through {@link Deno.Command}.
 *
 * SECURITY:
 * - `Deno.Command` takes an argv ARRAY and never a shell string, and every path/URL is passed as a
 *   discrete argument (never interpolated into a script), so there is no shell/AppleScript/PowerShell
 *   injection sink — the Windows opener reuses {@link browserLaunchArgs} (which already avoids
 *   `cmd /c start`'s `&` splitting), and the macOS trash uses `osascript … on run argv` (the path is
 *   absolute, so never dash-led). The Windows trash passes the path in an ENVIRONMENT variable:
 *   `powershell.exe -Command` joins trailing argv into the command text, so argv there is code.
 * - `openPath` refuses executables/scripts/launchers ({@link isExecutableOpenTarget}): the page can
 *   write into the app dirs through `fs`, and "open with the default app" would otherwise run them.
 * - `openExternal` only hands the system opener a URL whose scheme is in the configured allowlist
 *   (default `https:` / `mailto:`); `openPath`/`reveal`/`trash` confine the path to the app's own
 *   directories ({@link confineWithinRoots}) and each is individually gated by config.
 * - `moveToTrash` moves to the OS Trash / Recycle Bin (Finder delete / `gio trash` / VisualBasic
 *   SendToRecycleBin) — never an unrecoverable `rm`.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import { browserLaunchArgs } from "../auth-session-runtime.ts";
import { confineWithinRoots, refuseReservedDataPath } from "../path-scope.ts";
import type { DesktopAppDirs } from "../app-dirs.ts";
import type { PickedPaths } from "../picked-paths.ts";

/** The OS spelling the command builders branch on. */
type Os = "darwin" | "windows" | "linux";

/** Spawn a tool (argv, no shell; optional extra env); rejects on a non-zero exit. Injected so tests
 * never launch anything. */
export type ShellSpawn = (
  cmd: string,
  args: string[],
  env?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<void>;

/** The env var the Windows trash script reads its path from (never argv — see {@link shellPathCommand}). */
export const SHELL_PATH_ENV = "DENEXT_SHELL_PATH";

/**
 * File extensions `openPath` refuses (on every OS — a denylist per OS would miss a file copied
 * between them): programs, scripts and launchers the OS default handler would EXECUTE, or hand to an
 * installer, rather than display. Windows runs `.bat`/`.vbs`/`.hta`/`.lnk`… with no exec bit; macOS
 * Terminal runs a `.terminal` file's CommandString; `.fileloc`/`.webloc`/`.inetloc` point Finder at
 * another (local) target, so they are launchers too; `.pkg`/`.mpkg` open the Installer (one click
 * from running install scripts). The page can write files into the app dirs through `fs`, so without
 * this `fs.writeFile` + `shell.openPath` would be code execution. Best-effort by nature — an opt-in
 * allowlist is the stronger policy; `reveal` (no execution) is unaffected.
 */
// deno-fmt-ignore
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Windows
  "exe", "com", "bat", "cmd", "scr", "pif", "cpl", "msi", "msp", "mst", "msc", "vb", "vbs", "vbe",
  "js", "jse", "ws", "wsf", "wsh", "wsc", "hta", "lnk", "url", "ps1", "ps1xml", "ps2", "ps2xml",
  "psc1", "psc2", "psm1", "psd1", "msh", "msh1", "msh2", "mshxml", "reg", "inf", "scf", "jar",
  "appref-ms", "application", "gadget", "settingcontent-ms", "library-ms", "search-ms",
  "searchconnector-ms", "diagcab", "chm", "hlp", "appx", "appxbundle", "msix", "msixbundle",
  "xbap", "xll", "cab", "iqy", "slk", "ade", "adp", "mde", "mda", "sct", "vsix",
  // macOS
  "app", "command", "tool", "terminal", "scpt", "scptd", "applescript", "workflow", "action",
  "pkg", "mpkg", "fileloc", "webloc", "inetloc", "prefpane", "saver", "kext", "osax", "dylib",
  // Linux / generic
  "desktop", "sh", "bash", "zsh", "csh", "ksh", "fish", "run", "appimage", "bin", "elf", "out",
  "py", "pyw", "pyz", "pyzw", "pyc", "pl", "rb", "php", "deb", "rpm", "flatpakref", "flatpak",
  "snap",
  // Windows, run by their handlers: themes (fetch remote resources), Remote Desktop, Sandbox.
  "theme", "themepack", "rdp", "wsb",
]);

/** A path's final component, Windows-normalized (trailing dots/spaces stripped), lower-cased. */
function normalizedName(path: string): string {
  const base = path.split(/[\\/]/).filter((s) => s.length > 0).pop() ?? "";
  return base.replace(/[. ]+$/, "").toLowerCase();
}

/**
 * Whether `path`'s final extension names something the OS would execute on open. Trailing dots and
 * spaces are ignored (Windows strips them, so `x.bat.` opens as `x.bat`), and the check is
 * case-insensitive. On Windows an extension-LESS file is refused too (its handler is unpredictable).
 *
 * @param path The path (check the symlink-resolved real path as well — see {@link openPathRefusal}).
 * @param os The target OS (only Windows refuses a missing extension).
 * @returns `true` when `openPath` must refuse it.
 */
export function isExecutableOpenTarget(
  path: string,
  os?: Os,
  allow?: ReadonlySet<string>,
): boolean {
  const name = normalizedName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return os === "windows"; // no extension (or a dotfile's only dot)
  const ext = name.slice(dot + 1);
  if (allow?.has(ext)) return false; // opted back in via shell.openPathAllowExtensions
  return EXECUTABLE_EXTENSIONS.has(ext);
}

/**
 * Why `openPath` must refuse `path`, or `undefined` to allow it: an executable extension on the
 * requested path OR its symlink-resolved target (a `doc.pdf` link to `run.bat` opens the `.bat`), an
 * extension-less FILE on Windows, or — on macOS/Linux — a regular file with an execute bit (`open`
 * runs a Unix executable in Terminal). Directories are only judged by name (`.app` bundles).
 *
 * @param path The confined absolute path.
 * @param os The target OS.
 * @returns The refusal reason, or `undefined`.
 */
export async function openPathRefusal(
  path: string,
  os: Os,
  allow?: ReadonlySet<string>,
): Promise<string | undefined> {
  const real = await Deno.realPath(path).catch(() => path);
  const info = await Deno.stat(real).catch(() => undefined);
  const isFile = info?.isFile === true;
  for (const p of real === path ? [path] : [path, real]) {
    if (isExecutableOpenTarget(p, isFile ? os : undefined, allow)) {
      return "openPath refuses programs, scripts and launchers (the OS would run them)";
    }
  }
  // Exec-bit: `open` would run a Unix executable in Terminal. Skip only when the RESOLVED file's own
  // extension is explicitly allowlisted (keyed off `real`, so a `.sh`→extension-less-binary symlink
  // can't slip a program past this).
  const realName = normalizedName(real);
  const rdot = realName.lastIndexOf(".");
  const realExtAllowed = rdot > 0 && allow?.has(realName.slice(rdot + 1)) === true;
  if (
    isFile && !realExtAllowed && os !== "windows" && info?.mode != null && (info.mode & 0o111) !== 0
  ) {
    return "openPath refuses an executable file (the OS would run it)";
  }
  return undefined;
}

/** The `shell` capability's resolved allowlist. */
export interface ShellCapabilityConfig {
  /** URL schemes (with the colon, e.g. `"https:"`) `openExternal` may hand the system browser. */
  readonly openExternal: readonly string[];
  /** Whether `openPath` (open a path with its default app) is allowed. */
  readonly openPath: boolean;
  /** Whether `reveal` (show a path in the file manager) is allowed. */
  readonly reveal: boolean;
  /** Whether `trash` (move a path to the OS trash) is allowed. */
  readonly trash: boolean;
  /** Bare file extensions (no dot, lower-case) `openPath` may open despite the executable/script
   * denylist — the `desktop.capabilities.shell.openPathAllowExtensions` opt-in (e.g. `["py", "sh"]`).
   * Empty by default. */
  readonly openPathAllowExtensions?: readonly string[];
}

/** Options for {@link shellCapability}. */
export interface ShellCapabilityDeps {
  /** The app directories a path argument must lie within. */
  readonly dirs: DesktopAppDirs;
  /** The resolved allowlist. */
  readonly config: ShellCapabilityConfig;
  /** The OS (defaults to the running one) — fixes which program each method spawns, so the method
   * `permissions` (`--allow-run`) it declares are exactly the binaries it can launch on that OS. */
  readonly os?: Os;
  /** The per-launch picked-path set, for a `{ handle }` from a native dialog. */
  readonly picked?: PickedPaths;
  /** The spawner (defaults to a real {@link Deno.Command}); tests inject a fake. */
  readonly spawn?: ShellSpawn;
}

/**
 * The argv to open / reveal / trash a filesystem `path` on `os`. Pure + exported so every OS's
 * command is unit-tested without spawning (like {@link browserLaunchArgs}). The path is always a
 * discrete argv entry (or a scriptblock argument), never interpolated — no injection.
 *
 * @param os The target OS.
 * @param action `open` (default app), `reveal` (show in the file manager), or `trash` (to the OS trash).
 * @param path The absolute, already-confined path.
 * @returns `[command, args]`.
 */
export function shellPathCommand(
  os: Os,
  action: "open" | "reveal" | "trash",
  path: string,
): [string, string[]] {
  if (os === "darwin") {
    if (action === "open") return ["open", [path]];
    if (action === "reveal") return ["open", ["-R", path]];
    return [
      "osascript",
      [
        "-e",
        "on run argv",
        // Resolve the path to an alias OUTSIDE the Finder tell: inside it, `POSIX file …` is sent to
        // Finder as an object specifier it cannot resolve (-1728), so every trash failed on a real Mac.
        // (Not `target` as the name: that is a Finder property, and fails with -1728 too.)
        "-e",
        "set theItem to POSIX file (item 1 of argv) as alias",
        "-e",
        'tell application "Finder" to delete theItem',
        "-e",
        "end run",
        path,
      ],
    ];
  }
  if (os === "windows") {
    if (action === "open") return ["explorer.exe", [path]];
    if (action === "reveal") return ["explorer.exe", [`/select,${path}`]];
    // NOT argv: `powershell.exe -Command` joins every trailing argument into the command TEXT, so
    // a path such as `…\a;Start-Process calc` would run. The path arrives in SHELL_PATH_ENV
    // (see shellPathEnv), which the script reads as data.
    return [
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `& { $p = $env:${SHELL_PATH_ENV}; Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }",
      ],
    ];
  }
  if (action === "open") return ["xdg-open", [path]];
  if (action === "reveal") {
    return [
      "dbus-send",
      [
        "--session",
        "--dest=org.freedesktop.FileManager1",
        "--type=method_call",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        // Percent-encode the path: dbus-send splits `array:string:` values on `,`.
        `array:string:file://${encodeURI(path).replace(/,/g, "%2C")}`,
        "string:",
      ],
    ];
  }
  return ["gio", ["trash", path]];
}

/**
 * The extra environment {@link shellPathCommand}'s invocation needs: the Windows trash reads its
 * path from {@link SHELL_PATH_ENV}; every other command takes the path in argv.
 *
 * @param os The target OS.
 * @param action The shell action.
 * @param path The confined absolute path.
 * @returns The env to spawn with, or `undefined`.
 */
export function shellPathEnv(
  os: Os,
  action: "open" | "reveal" | "trash",
  path: string,
): Record<string, string> | undefined {
  return os === "windows" && action === "trash" ? { [SHELL_PATH_ENV]: path } : undefined;
}

/**
 * The default spawner: run the tool with no stdio, and reject on a non-zero exit. `signal` (the
 * bridge's per-call deadline) kills the child when it aborts, so a hung opener or a PowerShell
 * trash waiting on a dialog does not outlive the RPC that started it.
 *
 * @param cmd The program.
 * @param args Its argv.
 * @param env Extra environment.
 * @param signal Aborting it terminates the child.
 */
export async function runShellTool(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DesktopCapError("timeout", `"${cmd}" was cancelled`);
  const { success, code } = await new Deno.Command(cmd, {
    args,
    env,
    signal,
    stdout: "null",
    stderr: "null",
  }).output();
  if (signal?.aborted) throw new DesktopCapError("timeout", `"${cmd}" was cancelled`);
  if (!success) throw new DesktopCapError("shell_failed", `"${cmd}" exited with code ${code}`);
}

/** Require a boolean config flag, else the method is refused (`forbidden`). */
function requireEnabled(enabled: boolean, name: string): void {
  if (!enabled) {
    throw new DesktopCapError("forbidden", `shell.${name} is not enabled`, { status: 403 });
  }
}

/**
 * Build the `shell` capability.
 *
 * @param deps The app directories, the resolved allowlist, and (for tests) the spawner.
 * @returns The `shell` {@link DesktopCapability}.
 */
export function shellCapability(deps: ShellCapabilityDeps): DesktopCapability {
  const spawn = deps.spawn ?? runShellTool;
  const os = deps.os ?? (Deno.build.os as Os);
  const roots = [deps.dirs.data, deps.dirs.cache, deps.dirs.documents];
  // Extensions `openPath` may open despite the denylist (opt-in), normalized to lower-case bare.
  const openPathAllow = new Set(
    (deps.config.openPathAllowExtensions ?? []).map((e) => e.toLowerCase()),
  );

  // The exact program each method spawns on this OS, so its `permissions` name only that binary.
  // `--allow-run` is full trust over the named program, so keeping the list tight matters.
  const openerBin = browserLaunchArgs(os, "")[0]; // openExternal (open / rundll32.exe / xdg-open)
  const openBin = shellPathCommand(os, "open", "/")[0];
  const revealBin = shellPathCommand(os, "reveal", "/")[0];
  const trashBin = shellPathCommand(os, "trash", "/")[0];

  const openPathLike = async (
    action: "open" | "reveal" | "trash",
    enabled: boolean,
    args: unknown,
    signal: AbortSignal,
  ) => {
    requireEnabled(
      enabled,
      action === "open" ? "openPath" : action === "reveal" ? "reveal" : "trash",
    );
    const a = (args ?? {}) as { path?: unknown; handle?: unknown };
    let confined: string;
    if (typeof a.handle === "string") {
      // A user-picked file/folder (a dialog handle): trash writes, open/reveal read.
      if (!deps.picked) throw new DesktopCapError("validation", "picked handles are not available");
      confined = (await deps.picked.resolve(a.handle, "", action === "trash")).target;
    } else if (typeof a.path === "string") {
      confined = await confineWithinRoots(a.path, roots);
      // The runtime's own state (the updater overlay, the engine profile) is never opened,
      // revealed or trashed: trashing the overlay would roll the app back to its older UI.
      await refuseReservedDataPath(deps.dirs.data, confined);
    } else {
      throw new DesktopCapError("validation", "a path or handle is required");
    }
    // Applies to app-dir paths AND picked handles alike (a user-picked `.bat` is still a program).
    const refusal = action === "open"
      ? await openPathRefusal(confined, os, openPathAllow)
      : undefined;
    if (refusal) throw new DesktopCapError("forbidden", refusal, { status: 403 });
    const [cmd, cmdArgs] = shellPathCommand(os, action, confined);
    await spawn(cmd, cmdArgs, shellPathEnv(os, action, confined), signal);
    return { ok: true };
  };

  return {
    name: "shell",
    methods: {
      openExternal: {
        permissions: { run: [openerBin] },
        handler: async (args, ctx) => {
          const url = (args as { url?: unknown })?.url;
          if (typeof url !== "string") {
            throw new DesktopCapError("validation", "url must be a string");
          }
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            throw new DesktopCapError("validation", "url is not a valid URL");
          }
          const scheme = parsed.protocol; // e.g. "https:"
          if (!deps.config.openExternal.includes(scheme)) {
            throw new DesktopCapError("forbidden", `scheme "${scheme}" is not allowed`, {
              status: 403,
            });
          }
          // The normalized href, not the string as given: what was checked is what is opened (a
          // raw string's whitespace, quotes or backslashes are for the opener to reinterpret).
          const [cmd, cmdArgs] = browserLaunchArgs(os, parsed.href);
          await spawn(cmd, cmdArgs, undefined, ctx.signal);
          return { ok: true };
        },
      },
      openPath: {
        permissions: { run: [openBin] },
        handler: (args, ctx) => openPathLike("open", deps.config.openPath, args, ctx.signal),
      },
      reveal: {
        permissions: { run: [revealBin] },
        handler: (args, ctx) => openPathLike("reveal", deps.config.reveal, args, ctx.signal),
      },
      trash: {
        permissions: { run: [trashBin] },
        handler: (args, ctx) => openPathLike("trash", deps.config.trash, args, ctx.signal),
      },
    },
  };
}
