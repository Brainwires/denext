/**
 * The `dialogs` capability: native open / save / folder pickers on Deno Desktop (see
 * `dialogOpenFile`/`dialogSaveFile`/`dialogPickFolder` in `src/desktop/native.ts`).
 *
 * Under denext's pinned runtime it uses the runtime's own dialogs, `Deno.desktop.dialog`
 * (`NSOpenPanel` / `NSSavePanel` as a sheet on the app window on macOS, `IFileOpenDialog` /
 * `IFileSaveDialog` on Windows; on Linux the desktop's own dialog through xdg-desktop-portal's
 * FileChooser wherever the portal offers one, else GTK's chooser — runtime 2.9.7-denext.12, which
 * reports the choice as `platformFeatures().fileChooser`; GTK's `GtkFileChooserNative` before it),
 * with the page's MIME `types` as the dialog's file-type filters. Where the runtime has none (the
 * stock runtime, or a backend whose `windowCapabilities().fileDialogs` is false), macOS and Windows
 * drive the OS dialog programs as subprocesses instead:
 * - macOS: `osascript` (`choose file` / `choose file name` / `choose folder`).
 * - Windows: PowerShell `System.Windows.Forms` Open/Save/FolderBrowser dialogs (STA).
 * Linux has no such program it can count on (zenity and kdialog are separate installs that a
 * desktop may not ship, and they differ in what they offer), so there a dialog without the runtime's
 * is `unavailable` and the page uses `<input type="file">`.
 *
 * SECURITY / contract (both paths):
 * - `Deno.Command` takes an argv array (no shell); the only page-supplied string is `suggestedName`.
 *   It is first reduced to a plain file name with no leading `-` ({@link sanitizeSuggestedName}),
 *   then (native) handed to the runtime as the dialog's proposed name, or (subprocess) passed as an
 *   AppleScript `on run argv` item AFTER `--` (osascript's getopt otherwise parses a dash-led
 *   trailing arg as `-e <script>`), or — on Windows — an ENVIRONMENT variable (`powershell.exe
 *   -Command` joins trailing argv into the command text, so an argv value there would be code).
 *   Never interpolated into a script.
 * - A pick returns `{ path, handle }` (openFile: `{ files: [{ …, handle }] }`); `path` is display-only
 *   and the page never sends it back — authority is the opaque {@link PickedPaths} `handle`
 *   (openFile → read, saveFile → readwrite, pickFolder → folder). A non-null saveFile/pickFolder
 *   answer ALWAYS carries a handle.
 * - Cancel → openFile `{ files: [] }`, saveFile/pickFolder `null` (the mobile pickers' contract).
 * - Another native dialog already open → `busy`.
 * - No dialog at all (Linux without the runtime's dialogs) → `unavailable`, so the page falls
 *   back to `<input type="file">`.
 *
 * The cap does its own file I/O (broad read/write by design): openFile with `readData` returns the
 * file's bytes (base64); saveFile writes the passed data to the chosen path.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import { basename } from "@std/path";
import { allExtensions } from "@std/media-types";
import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import type { PickedPaths } from "../picked-paths.ts";
import {
  type DesktopAppApi,
  desktopAppApi,
  type DesktopDialogOptions,
  type DesktopFileFilter,
} from "../launch-events.ts";

/** The OS spelling the command builders branch on. */
type Os = "darwin" | "windows" | "linux";

/** One dialog-program invocation to try (argv, no shell; optional extra environment). */
interface DialogCandidate {
  readonly cmd: string;
  readonly args: string[];
  /** Extra environment for the child (the Windows suggested name travels here, never in argv). */
  readonly env?: Record<string, string>;
}

/** Run a dialog program (argv, no shell); `code: null` means the program could not be spawned. */
export type DialogRunner = (
  cmd: string,
  args: string[],
  env?: Record<string, string>,
) => Promise<{ code: number | null; stdout: string }>;

/** The env var the Windows save dialog reads its suggested name from. */
export const DIALOG_NAME_ENV = "DENEXT_DIALOG_SUGGESTED_NAME";

/**
 * Reduce a page-supplied suggested file name to a plain name: the last path component, control
 * characters removed, and no leading `-` (so it can never be read as an option by `osascript`,
 * whose getopt still parses a dash-led trailing argument) — `undefined` when empty.
 *
 * @param raw The page's `suggestedName`.
 * @returns The sanitized name, or `undefined`.
 */
export function sanitizeSuggestedName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const last = raw.split(/[\\/]/).pop() ?? "";
  // deno-lint-ignore no-control-regex
  const name = last.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^[\s-]+/, "").slice(0, 255);
  return name.length > 0 && name !== "." && name !== ".." ? name : undefined;
}

/**
 * A PowerShell one-liner that shows `dialog`, runs `body` on OK, and prints nothing on cancel.
 * NOTHING page-supplied may be appended to this argv: `powershell.exe -Command` joins every
 * trailing argument into the command TEXT, so a trailing value would be parsed as PowerShell. The
 * suggested name reaches the script through {@link DIALOG_NAME_ENV} instead.
 */
function psDialog(setup: string, ok: string, env?: Record<string, string>): DialogCandidate {
  return {
    cmd: "powershell.exe",
    args: [
      "-STA",
      "-NoProfile",
      "-Command",
      `& { $n = $env:${DIALOG_NAME_ENV}; Add-Type -AssemblyName System.Windows.Forms; ${setup} ` +
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${ok} } }`,
    ],
    ...(env ? { env } : {}),
  };
}

/** Candidates for an open-file panel. */
function openFileCommands(os: Os): DialogCandidate[] {
  if (os === "darwin") return [{ cmd: "osascript", args: ["-e", "POSIX path of (choose file)"] }];
  if (os === "windows") {
    return [psDialog("$d = New-Object System.Windows.Forms.OpenFileDialog;", "$d.FileName")];
  }
  return []; // Linux: only the runtime's dialogs
}

/**
 * Candidates for a save-file panel. `suggestedName` must already be {@link sanitizeSuggestedName}d;
 * on macOS it follows `--` so osascript's getopt can never read it as `-e <script>` (a dash-led
 * trailing argument is otherwise parsed as an option: AppleScript injection).
 */
function saveFileCommands(os: Os, suggestedName?: string): DialogCandidate[] {
  const name = suggestedName ?? "";
  if (os === "darwin") {
    const script = suggestedName
      ? [
        "-e",
        "on run argv",
        "-e",
        "POSIX path of (choose file name default name (item 1 of argv))",
        "-e",
        "end run",
        "--",
        name,
      ]
      : ["-e", "POSIX path of (choose file name)"];
    return [{ cmd: "osascript", args: script }];
  }
  if (os === "windows") {
    return [
      psDialog(
        "$d = New-Object System.Windows.Forms.SaveFileDialog; if ($n) { $d.FileName = $n };",
        "$d.FileName",
        suggestedName ? { [DIALOG_NAME_ENV]: name } : undefined,
      ),
    ];
  }
  return []; // Linux: only the runtime's dialogs
}

/** Candidates for a folder picker. */
function pickFolderCommands(os: Os): DialogCandidate[] {
  if (os === "darwin") return [{ cmd: "osascript", args: ["-e", "POSIX path of (choose folder)"] }];
  if (os === "windows") {
    return [
      psDialog("$d = New-Object System.Windows.Forms.FolderBrowserDialog;", "$d.SelectedPath"),
    ];
  }
  return []; // Linux: only the runtime's dialogs
}

/** Why a Linux dialog is `unavailable` without the runtime's dialogs. */
const LINUX_NO_DIALOGS =
  "this Deno Desktop runtime has no native file dialogs here; denext's pinned runtime has them " +
  "(the desktop's own dialog through xdg-desktop-portal, or GTK's)";

/**
 * Try each candidate until one spawns: `code: null` (program missing) tries the next; a non-zero exit
 * is a cancel (`null`); a zero exit's trimmed stdout is the chosen path. All programs missing (or
 * none, on Linux) → `unavailable`.
 */
async function runDialog(
  candidates: DialogCandidate[],
  run: DialogRunner,
  name: string,
): Promise<string | null> {
  for (const c of candidates) {
    const { code, stdout } = c.env ? await run(c.cmd, c.args, c.env) : await run(c.cmd, c.args);
    if (code === null) continue; // program not installed — try the next
    if (code !== 0) return null; // the user cancelled (or the dialog errored)
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  }
  throw new DesktopCapError(
    "unavailable",
    candidates.length === 0
      ? `no native ${name} dialog: ${LINUX_NO_DIALOGS}`
      : `no native ${name} dialog program is available`,
  );
}

/** The default runner: spawn the program; a missing binary is reported as `code: null`. */
async function defaultRun(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number | null; stdout: string }> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, { args, env, stdin: "null", stdout: "piped", stderr: "null" })
      .spawn();
  } catch {
    return { code: null, stdout: "" };
  }
  const { code, stdout } = await child.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

/** The dialog programs each OS may spawn (for the cap's `--allow-run`). */
const RUN_PERMS: Readonly<Record<Os, string[]>> = {
  darwin: ["osascript"],
  windows: ["powershell.exe"],
  linux: [],
};

/** The runtime's dialog API (`Deno.desktop.dialog`). */
type NativeDialogs = NonNullable<DesktopAppApi["dialog"]>;

/**
 * `Deno.desktop.dialog` when the runtime has working file dialogs: denext's pinned runtime on a
 * backend whose `windowCapabilities().fileDialogs` is not false. `undefined` → the subprocess path.
 */
function nativeDialogs(api: DesktopAppApi | undefined): NativeDialogs | undefined {
  const dialog = api?.dialog;
  if (
    typeof dialog?.showOpenDialog !== "function" || typeof dialog.showSaveDialog !== "function"
  ) return undefined;
  try {
    if (api?.windowCapabilities?.().fileDialogs === false) return undefined;
  } catch {
    // A runtime that cannot report its capabilities still has the dialog functions: try them.
  }
  return dialog;
}

/** Extensions for the MIME wildcards `@std/media-types` cannot expand. */
const WILDCARD_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/*": [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "heic",
    "heif",
    "avif",
    "bmp",
    "tif",
    "tiff",
    "svg",
  ],
  "audio/*": ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba"],
  "video/*": ["mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv"],
  "text/*": ["txt", "csv", "tsv", "md", "markdown", "html", "htm", "css", "xml", "json", "log"],
};

/** The extensions for one accepted type (`"image/*"`, `"application/pdf"`, `".csv"`), or `undefined`. */
function extensionsFor(raw: unknown): readonly string[] | undefined {
  if (typeof raw !== "string") return undefined;
  const type = raw.trim().toLowerCase();
  if (type === "*/*" || type === "*") return undefined;
  if (type.startsWith(".")) return [type.slice(1)];
  return WILDCARD_EXTENSIONS[type] ?? allExtensions(type);
}

/** A plain extension (no dot, no separator, no wildcard). */
const EXTENSION = /^[a-z0-9][a-z0-9+_-]*$/;

/**
 * The page's accepted types (`["application/pdf", "image/*", ".csv"]`) as native file-type filters:
 * one filter listing every extension. `undefined` (any file) when there are none, or when a type has
 * no known extension — a filter must never hide a file the page asked for.
 *
 * @param types The page's MIME types (or `.ext` strings).
 * @returns The filters, or `undefined`.
 */
export function dialogFilters(types: unknown): DesktopFileFilter[] | undefined {
  if (!Array.isArray(types) || types.length === 0) return undefined;
  const extensions = new Set<string>();
  for (const type of types) {
    const exts = extensionsFor(type);
    if (!exts || exts.length === 0 || !exts.every((e) => EXTENSION.test(e))) return undefined;
    for (const e of exts) extensions.add(e);
  }
  return [{ name: "Supported files", extensions: [...extensions] }];
}

/** Run a native dialog, mapping the runtime's rejections to capability errors. */
async function runNative<T>(show: () => Promise<T>): Promise<T> {
  try {
    return await show();
  } catch (err) {
    if ((err as { name?: unknown })?.name === "Busy") {
      throw new DesktopCapError("busy", "another file dialog is already open", { status: 409 });
    }
    throw new DesktopCapError("dialog_failed", "the native file dialog could not be shown", {
      status: 500,
    });
  }
}

/** The dialog options shared by every native call: the modal window and the type filters. */
function nativeOptions(window: unknown, types: unknown): DesktopDialogOptions {
  const filters = dialogFilters(types);
  return {
    ...(typeof window === "object" && window !== null ? { window } : {}),
    ...(filters ? { filters } : {}),
  };
}

/** Options for {@linkcode dialogsCapability}. */
export interface DialogsDeps {
  /** The picked-path set a pick is recorded in (its handle is the page's authority). */
  readonly picked: PickedPaths;
  /** The OS (defaults to the running one). */
  readonly os?: Os;
  /** The dialog-program runner (defaults to a real subprocess); tests inject a fake. */
  readonly run?: DialogRunner;
  /**
   * The runtime's app API (default `Deno.desktop`): its `dialog` is used when present; tests pass a
   * fake, or `null` to force the subprocess path.
   */
  readonly api?: DesktopAppApi | null;
}

/**
 * Build the `dialogs` capability.
 *
 * @param deps The picked-path set, and (for tests) the OS, runner and runtime API.
 * @returns The `dialogs` {@link DesktopCapability}.
 */
export function dialogsCapability(deps: DialogsDeps): DesktopCapability {
  const os = deps.os ?? (Deno.build.os as Os);
  const run = deps.run ?? defaultRun;
  const picked = deps.picked;
  const runPerms = RUN_PERMS[os];
  const native = () => nativeDialogs(deps.api === null ? undefined : deps.api ?? desktopAppApi());

  /** The chosen file to open: the native panel, else a dialog program. */
  const chooseOpen = async (types: unknown, window: unknown): Promise<string | null> => {
    const dialog = native();
    if (!dialog) return await runDialog(openFileCommands(os), run, "open-file");
    const paths = await runNative(() =>
      dialog.showOpenDialog({ ...nativeOptions(window, types), properties: ["openFile"] })
    );
    return paths && paths.length > 0 ? paths[0] : null;
  };

  /** The path to save to: the native panel (proposing `suggested`), else a dialog program. */
  const chooseSave = async (
    suggested: string | undefined,
    types: unknown,
    window: unknown,
  ): Promise<string | null> => {
    const dialog = native();
    if (!dialog) return await runDialog(saveFileCommands(os, suggested), run, "save-file");
    return await runNative(() =>
      dialog.showSaveDialog({
        ...nativeOptions(window, types),
        ...(suggested !== undefined ? { defaultPath: suggested } : {}),
      })
    );
  };

  /** The chosen folder: the native panel, else a dialog program. */
  const chooseFolder = async (window: unknown): Promise<string | null> => {
    const dialog = native();
    if (!dialog) return await runDialog(pickFolderCommands(os), run, "folder");
    const paths = await runNative(() =>
      dialog.showOpenDialog({ ...nativeOptions(window, undefined), properties: ["openDirectory"] })
    );
    return paths && paths.length > 0 ? paths[0] : null;
  };

  return {
    name: "dialogs",
    methods: {
      openFile: {
        timeoutMs: false, // the user reads the dialog
        permissions: { run: runPerms, read: ["*"] },
        handler: async (args, ctx) => {
          const a = (args ?? {}) as { readData?: unknown; types?: unknown };
          const path = await chooseOpen(a.types, ctx.window);
          if (path === null) return { files: [] };
          const real = await Deno.realPath(path);
          const handle = picked.add(real, "read");
          const size = await Deno.stat(real).then((s) => s.size, () => 0);
          const file: Record<string, unknown> = {
            name: basename(real),
            mimeType: "application/octet-stream",
            size,
            path,
            handle,
          };
          if (a.readData === true) file.data = bytesToBase64(await Deno.readFile(real));
          return { files: [file] };
        },
      },
      saveFile: {
        timeoutMs: false,
        permissions: { run: runPerms, write: ["*"] },
        handler: async (args, ctx) => {
          const a = (args ?? {}) as {
            data?: unknown;
            encoding?: unknown;
            suggestedName?: unknown;
            types?: unknown;
          };
          if (typeof a.data !== "string") {
            throw new DesktopCapError("validation", "data must be a string");
          }
          const suggested = sanitizeSuggestedName(a.suggestedName);
          const path = await chooseSave(suggested, a.types, ctx.window);
          if (path === null) return null;
          if (a.encoding === "base64") await Deno.writeFile(path, base64ToBytes(a.data));
          else await Deno.writeTextFile(path, a.data);
          const real = await Deno.realPath(path);
          return { path, handle: picked.add(real, "readwrite") };
        },
      },
      pickFolder: {
        timeoutMs: false,
        permissions: { run: runPerms, read: ["*"] },
        handler: async (_args, ctx) => {
          const path = await chooseFolder(ctx.window);
          if (path === null) return null;
          const real = await Deno.realPath(path);
          return { path, handle: picked.add(real, "folder") };
        },
      },
    },
  };
}
