/**
 * The `dialogs` capability: native open / save / folder pickers on Deno Desktop (see
 * `dialogOpenFile`/`dialogSaveFile`/`dialogPickFolder` in `src/desktop/native.ts`). Deno Desktop has
 * no first-class file-dialog API yet, so — like many desktop tools — this drives the OS dialog
 * programs as subprocesses:
 * - macOS: `osascript` (`choose file` / `choose file name` / `choose folder`).
 * - Linux: `zenity --file-selection` (`--save` / `--directory`), falling back to `kdialog`.
 * - Windows: PowerShell `System.Windows.Forms` Open/Save/FolderBrowser dialogs (STA).
 *
 * SECURITY / contract:
 * - `Deno.Command` takes an argv array (no shell); the only page-supplied string is `suggestedName`.
 *   It is first reduced to a plain file name with no leading `-` ({@link sanitizeSuggestedName}),
 *   then passed as an AppleScript `on run argv` item AFTER `--` (osascript's getopt otherwise parses
 *   a dash-led trailing arg as `-e <script>`), a zenity `--filename=` value / kdialog argument, or —
 *   on Windows — an ENVIRONMENT variable (`powershell.exe -Command` joins trailing argv into the
 *   command text, so an argv value there would be code). Never interpolated into a script.
 * - A pick returns `{ path, handle }` (openFile: `{ files: [{ …, handle }] }`); `path` is display-only
 *   and the page never sends it back — authority is the opaque {@link PickedPaths} `handle`
 *   (openFile → read, saveFile → readwrite, pickFolder → folder). A non-null saveFile/pickFolder
 *   answer ALWAYS carries a handle.
 * - Cancel → openFile `{ files: [] }`, saveFile/pickFolder `null` (the mobile pickers' contract).
 * - No dialog program available (a headless Linux without zenity/kdialog) → `unavailable`, so the
 *   page falls back to `<input type="file">`.
 *
 * The cap does its own file I/O (broad read/write by design): openFile with `readData` returns the
 * file's bytes (base64); saveFile writes the passed data to the chosen path.
 *
 * Runtime-only (imported by the desktop entry via the caps resolver, never a client bundle).
 *
 * @module
 */

import { basename } from "@std/path";
import { base64ToBytes, bytesToBase64 } from "../../mobile/base64.ts";
import { type DesktopCapability, DesktopCapError } from "../extension.ts";
import type { PickedPaths } from "../picked-paths.ts";

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
 * characters removed, and no leading `-` (so it can never be read as an option by `osascript` /
 * `kdialog`, whose getopt still parses a dash-led trailing argument) — `undefined` when empty.
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
  return [
    { cmd: "zenity", args: ["--file-selection"] },
    { cmd: "kdialog", args: ["--getopenfilename"] },
  ];
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
  return [
    {
      cmd: "zenity",
      args: [
        "--file-selection",
        "--save",
        "--confirm-overwrite",
        ...(suggestedName ? [`--filename=${name}`] : []),
      ],
    },
    { cmd: "kdialog", args: ["--getsavefilename", suggestedName ? name : "."] },
  ];
}

/** Candidates for a folder picker. */
function pickFolderCommands(os: Os): DialogCandidate[] {
  if (os === "darwin") return [{ cmd: "osascript", args: ["-e", "POSIX path of (choose folder)"] }];
  if (os === "windows") {
    return [
      psDialog("$d = New-Object System.Windows.Forms.FolderBrowserDialog;", "$d.SelectedPath"),
    ];
  }
  return [
    { cmd: "zenity", args: ["--file-selection", "--directory"] },
    { cmd: "kdialog", args: ["--getexistingdirectory"] },
  ];
}

/**
 * Try each candidate until one spawns: `code: null` (program missing) tries the next; a non-zero exit
 * is a cancel (`null`); a zero exit's trimmed stdout is the chosen path. All programs missing →
 * `unavailable`.
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
  throw new DesktopCapError("unavailable", `no native ${name} dialog program is available`);
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
  linux: ["zenity", "kdialog"],
};

/** Options for {@linkcode dialogsCapability}. */
export interface DialogsDeps {
  /** The picked-path set a pick is recorded in (its handle is the page's authority). */
  readonly picked: PickedPaths;
  /** The OS (defaults to the running one). */
  readonly os?: Os;
  /** The dialog-program runner (defaults to a real subprocess); tests inject a fake. */
  readonly run?: DialogRunner;
}

/**
 * Build the `dialogs` capability.
 *
 * @param deps The picked-path set, and (for tests) the OS and runner.
 * @returns The `dialogs` {@link DesktopCapability}.
 */
export function dialogsCapability(deps: DialogsDeps): DesktopCapability {
  const os = deps.os ?? (Deno.build.os as Os);
  const run = deps.run ?? defaultRun;
  const picked = deps.picked;
  const runPerms = RUN_PERMS[os];

  return {
    name: "dialogs",
    methods: {
      openFile: {
        timeoutMs: false, // the user reads the dialog
        permissions: { run: runPerms, read: ["*"] },
        handler: async (args) => {
          const readData = (args as { readData?: unknown })?.readData === true;
          const path = await runDialog(openFileCommands(os), run, "open-file");
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
          if (readData) file.data = bytesToBase64(await Deno.readFile(real));
          return { files: [file] };
        },
      },
      saveFile: {
        timeoutMs: false,
        permissions: { run: runPerms, write: ["*"] },
        handler: async (args) => {
          const a = (args ?? {}) as { data?: unknown; encoding?: unknown; suggestedName?: unknown };
          if (typeof a.data !== "string") {
            throw new DesktopCapError("validation", "data must be a string");
          }
          const suggested = sanitizeSuggestedName(a.suggestedName);
          const path = await runDialog(saveFileCommands(os, suggested), run, "save-file");
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
        handler: async () => {
          const path = await runDialog(pickFolderCommands(os), run, "folder");
          if (path === null) return null;
          const real = await Deno.realPath(path);
          return { path, handle: picked.add(real, "folder") };
        },
      },
    },
  };
}
