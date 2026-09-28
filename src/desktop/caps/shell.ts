/**
 * The `shell` capability: `openExternal` / `openPath` / `revealInFileManager` / `moveToTrash` on
 * Deno Desktop (see `src/desktop/native.ts`). Each runs a system tool through {@link Deno.Command}.
 *
 * SECURITY:
 * - `Deno.Command` takes an argv ARRAY and never a shell string, and every path/URL is passed as a
 *   discrete argument (never interpolated into a script), so there is no shell/AppleScript/PowerShell
 *   injection sink — the Windows opener reuses {@link browserLaunchArgs} (which already avoids
 *   `cmd /c start`'s `&` splitting), and the macOS trash uses `osascript … on run argv` / Windows uses
 *   a scriptblock `param`, so the path is data, not code.
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
import { confineWithinRoots } from "../path-scope.ts";
import type { DesktopAppDirs } from "../app-dirs.ts";
import type { PickedPaths } from "../picked-paths.ts";

/** The OS spelling the command builders branch on. */
type Os = "darwin" | "windows" | "linux";

/** Spawn a tool (argv, no shell); rejects on a non-zero exit. Injected so tests never launch anything. */
export type ShellSpawn = (cmd: string, args: string[]) => Promise<void>;

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
        "-e",
        'tell application "Finder" to delete (POSIX file (item 1 of argv))',
        "-e",
        "end run",
        path,
      ],
    ];
  }
  if (os === "windows") {
    if (action === "open") return ["explorer.exe", [path]];
    if (action === "reveal") return ["explorer.exe", [`/select,${path}`]];
    return [
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "& { param($p) Add-Type -AssemblyName Microsoft.VisualBasic; " +
        "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }",
        path,
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
        `array:string:file://${path}`,
        "string:",
      ],
    ];
  }
  return ["gio", ["trash", path]];
}

/** The default spawner: run the tool with no stdio, and reject on a non-zero exit. */
async function defaultSpawn(cmd: string, args: string[]): Promise<void> {
  const { success, code } = await new Deno.Command(cmd, { args, stdout: "null", stderr: "null" })
    .output();
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
  const spawn = deps.spawn ?? defaultSpawn;
  const os = deps.os ?? (Deno.build.os as Os);
  const roots = [deps.dirs.data, deps.dirs.cache, deps.dirs.documents];

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
    } else {
      throw new DesktopCapError("validation", "a path or handle is required");
    }
    const [cmd, cmdArgs] = shellPathCommand(os, action, confined);
    await spawn(cmd, cmdArgs);
    return { ok: true };
  };

  return {
    name: "shell",
    methods: {
      openExternal: {
        permissions: { run: [openerBin] },
        handler: async (args) => {
          const url = (args as { url?: unknown })?.url;
          if (typeof url !== "string") {
            throw new DesktopCapError("validation", "url must be a string");
          }
          let scheme: string;
          try {
            scheme = new URL(url).protocol; // e.g. "https:"
          } catch {
            throw new DesktopCapError("validation", "url is not a valid URL");
          }
          if (!deps.config.openExternal.includes(scheme)) {
            throw new DesktopCapError("forbidden", `scheme "${scheme}" is not allowed`, {
              status: 403,
            });
          }
          const [cmd, cmdArgs] = browserLaunchArgs(os, url);
          await spawn(cmd, cmdArgs);
          return { ok: true };
        },
      },
      openPath: {
        permissions: { run: [openBin] },
        handler: (args) => openPathLike("open", deps.config.openPath, args),
      },
      reveal: {
        permissions: { run: [revealBin] },
        handler: (args) => openPathLike("reveal", deps.config.reveal, args),
      },
      trash: {
        permissions: { run: [trashBin] },
        handler: (args) => openPathLike("trash", deps.config.trash, args),
      },
    },
  };
}
