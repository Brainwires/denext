// The kitchen sink's drive mode protocol, shared by the driven page (`drive-panel.tsx`), the app's
// `kitchen` extension (`desktop/kitchen.ts`) and the command-line driver (`e2e/drive.ts`). Plain
// data and pure functions only: it is imported by the page, the app's Deno process and the CLI.
//
// Drive mode runs the manual checks (dialogs, a notification click, the secure store, the tray,
// the title bar, the window states, deep links) from a command queue instead of a person, so a
// session with no one at the screen (SSH, a nested X server, CI) can drive them. The folder (the
// "drive dir", `e2e/.drive` by default):
//
//   queue/<order>-<id>.json   one command each: `{ "id", "cmd", "args"? }`, taken oldest first and
//                             deleted (write it as `.tmp`, then rename: a half-written one is never
//                             read)
//   results/<id>.json         its answer: `{ "id", "cmd", "ok", "result" | "error", "at", "ms" }`
//   events.jsonl              what happened on its own, one `{ "at", "event", "data" }` per line:
//                             TAPPED (a notification click), TRAY (a tray click or menu item),
//                             DEEPLINK, TITLEBAR (a title bar preference change), WINDOW (a state
//                             change)
//   ready.json                written when the page starts taking commands: `{ pid, href, at }`
//   app.log                   the app's output (when `e2e/drive.ts start` launched it)
//
// The app enters drive mode when `kitchen-sink-drive.json` (`{ "dir": "<drive dir>" }`) is in its
// data folder at launch; the window test's runner file wins over it.

/** The driven page's route. */
export const DRIVE_PATH = "/drive";

/** The file in the app's data folder that turns drive mode on: `{ "dir": "<drive dir>" }`. */
export const DRIVE_FILE = "kitchen-sink-drive.json";

/** A command as queued. */
export interface DriveCommand {
  /** Names the result file: letters, digits and dashes (see {@link isDriveId}). */
  readonly id: string;
  readonly cmd: string;
  readonly args?: Record<string, unknown>;
}

/** A command's answer (`results/<id>.json`). */
export interface DriveResult {
  readonly id: string;
  readonly cmd: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  /** ISO time it finished. */
  readonly at: string;
  readonly ms: number;
}

/** One event (`events.jsonl`). */
export interface DriveEvent {
  readonly at: string;
  readonly event: "TAPPED" | "TRAY" | "DEEPLINK" | "TITLEBAR" | "WINDOW";
  readonly data: unknown;
}

/** The commands the driven page runs, with their arguments: the CLI's usage and `help`. */
export const DRIVE_COMMANDS: Readonly<Record<string, string>> = {
  help: "this list",
  probe: "the session facts: platformFeatures(), appCapabilities(), windowCapabilities()",
  titlebar: "getTitleBarPreferences()",
  "titlebar-watch": "log each title bar preference change as a TITLEBAR event",
  state: "getWindowState()",
  maximize: "maximizeWindow(), then the state",
  unmaximize: "unmaximizeWindow(), then the state",
  minimize: "minimizeWindow(), then the state",
  restore: "restoreWindow(), then the state",
  focus: "focusWindow(), then the state",
  "fullscreen-on": "setFullScreen(true), then the state",
  "fullscreen-off": "setFullScreen(false), then the state",
  size: '{"width","height"}: setWindowSize(), then the state',
  secure: "secureStore set / get / delete / get again, each step's outcome",
  notify: '{"title"?,"body"?}: post a notification (a click is a TAPPED event)',
  "tray-on": "createTray() with a menu (clicks and items are TRAY events)",
  "tray-off": "destroy the tray",
  "open-dialog": "pickDocument(): the dialog waits for a person (or `native-dialog`)",
  "save-dialog": "saveFile(): the dialog waits for a person",
  "folder-dialog": "pickFolder(): the dialog waits for a person",
  "native-dialog":
    '{"kind":"open"|"save"|"folder","cancelAfterMs"?}: the runtime\'s own dialog, closed ' +
    "through its AbortSignal after cancelAfterMs (default 2000): no person needed",
  deeplinks: "the deep links received so far (each is also a DEEPLINK event)",
  quit: "quitApp()",
};

/** Whether `id` can name a result file. */
export function isDriveId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/**
 * The queue file name of a command: ordered by the time it was queued, then a sequence number
 * (several in one millisecond), then its id.
 */
export function queueFileName(at: number, seq: number, id: string): string {
  if (!isDriveId(id)) throw new TypeError(`bad command id ${JSON.stringify(id)}`);
  return `${String(at).padStart(15, "0")}-${String(seq).padStart(6, "0")}-${id}.json`;
}

/** The oldest queued command file among `names` (`.tmp` files are still being written). */
export function nextQueueFile(names: readonly string[]): string | null {
  return names.filter((n) => n.endsWith(".json")).sort()[0] ?? null;
}

/**
 * A queued command file's content, checked: `{ command }`, or `{ id, error }` (the id from the
 * file name when the content has none) so the driver still gets an answer.
 */
export function parseDriveCommand(
  text: string,
  fileName: string,
): { command: DriveCommand } | { id: string; error: string } {
  const fromName = /^\d+-\d+-([a-z0-9][a-z0-9-]{0,63})\.json$/.exec(fileName)?.[1] ?? "invalid";
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { id: fromName, error: "the command file is not JSON" };
  }
  const v = value as Partial<DriveCommand> | null;
  if (typeof v !== "object" || v === null) return { id: fromName, error: "not an object" };
  const id = isDriveId(v.id) ? v.id : fromName;
  if (typeof v.cmd !== "string" || v.cmd === "") return { id, error: "no cmd" };
  if (v.args !== undefined && (typeof v.args !== "object" || v.args === null)) {
    return { id, error: "args must be an object" };
  }
  return { command: { id, cmd: v.cmd, ...(v.args ? { args: v.args } : {}) } };
}
