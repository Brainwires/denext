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
 * - `Deno.Command` takes an argv array (no shell); the only page-supplied string is `suggestedName`,
 *   passed as a discrete argv element / AppleScript `on run argv` item / PowerShell scriptblock param
 *   — never interpolated into a script, so there is no shell/AppleScript/PowerShell injection.
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

/** One dialog-program invocation to try (argv, no shell). */
interface DialogCandidate {
  readonly cmd: string;
  readonly args: string[];
}

/** Run a dialog program (argv, no shell); `code: null` means the program could not be spawned. */
export type DialogRunner = (
  cmd: string,
  args: string[],
) => Promise<{ code: number | null; stdout: string }>;

/** A PowerShell one-liner that shows `dialog`, runs `body` on OK, and prints nothing on cancel. */
function psDialog(setup: string, ok: string): DialogCandidate {
  return {
    cmd: "powershell.exe",
    args: [
      "-STA",
      "-NoProfile",
      "-Command",
      `& { param($n) Add-Type -AssemblyName System.Windows.Forms; ${setup} ` +
      `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ${ok} } }`,
      // $n (suggested name) is bound from the trailing argv, never spliced into the script.
    ],
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

/** Candidates for a save-file panel (with an optional suggested name passed safely as an argument). */
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
        name,
      ]
      : ["-e", "POSIX path of (choose file name)"];
    return [{ cmd: "osascript", args: script }];
  }
  if (os === "windows") {
    return [
      psDialog(
        "$d = New-Object System.Windows.Forms.SaveFileDialog; $d.FileName = $n;",
        "$d.FileName",
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
    const { code, stdout } = await run(c.cmd, c.args);
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
): Promise<{ code: number | null; stdout: string }> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "null" }).spawn();
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
          const suggested = typeof a.suggestedName === "string" ? a.suggestedName : undefined;
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
