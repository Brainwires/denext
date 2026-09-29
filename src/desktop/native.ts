/**
 * The Deno Desktop halves of the built-in `denext/mobile` capabilities. Each `denext/mobile`
 * function that has a desktop implementation checks `runtimePlatform() === "desktop"` and
 * dynamic-imports this module, so web and mobile bundles never load it (the same pattern as
 * `openAuthSession` → `./auth-session.ts`).
 *
 * Everything here is a thin call through the bridge ({@link desktopRpc}): the work happens in
 * the runtime's capability modules, and only when `desktop.capabilities` enables them.
 *
 * Wire names (capability → methods) are listed in `docs/desktop` and in the runtime's
 * capability modules; they are the contract between this file and the runtime.
 *
 * Client-only: web APIs, no Deno APIs, and no value imports from `denext/mobile` modules (they
 * import this one, so importing back would form an initialization cycle). Nothing runs at
 * import.
 *
 * @module
 */

import { base64ToBytes, bytesToBase64 } from "../mobile/base64.ts";
import type { FileDirectory, FileEncoding, FileEntry, PickedHandle } from "../mobile/filesystem.ts";
import type { PickedDocument } from "../mobile/pickers.ts";
import type {
  SqliteBindValue,
  SqliteDriver,
  SqliteParams,
  SqliteRows,
  SqliteRunResult,
  SqliteValue,
} from "../mobile/sqlite-web.ts";
import { desktopError, desktopRpc } from "./bridge-client.ts";

/** Capabilities already warned about falling back (one warning per capability per page). */
const warned = new Set<string>();

/**
 * Warn once that `cap` is not enabled and its caller fell back to browser storage, which a Deno
 * Desktop app loses on relaunch (the origin's port changes every launch).
 */
export function warnStorageFallback(cap: string): void {
  if (warned.has(cap)) return;
  warned.add(cap);
  const name = cap.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  console.warn(
    `denext: the desktop "${cap}" capability is not enabled (\`denext desktop add ${name}\`); ` +
      "falling back to browser storage, which a Deno Desktop app loses on relaunch.",
  );
}

// --- secure store (cap "secureStore") ---------------------------------------

/** `secureStore.get` on desktop: the OS keychain entry, or `null`. */
export async function secureGet(key: string): Promise<string | null> {
  const value = await desktopRpc<unknown>("secureStore", "get", { key });
  return typeof value === "string" ? value : null;
}

/** `secureStore.set` on desktop. */
export async function secureSet(key: string, value: string): Promise<void> {
  await desktopRpc("secureStore", "set", { key, value });
}

/** `secureStore.delete` on desktop. */
export async function secureDelete(key: string): Promise<void> {
  await desktopRpc("secureStore", "delete", { key });
}

// --- files (cap "fs") -------------------------------------------------------

/**
 * `readFile` on desktop: a file under the app's directory in the OS app-support folder, or under
 * a picked item (`directory: { picked }`, the RPC's `directory` field as given).
 */
export async function fsReadFile(
  path: string,
  directory: FileDirectory,
  encoding: FileEncoding,
): Promise<string> {
  const data = await desktopRpc<unknown>("fs", "readFile", { path, directory, encoding });
  return typeof data === "string" ? data : "";
}

/** `writeFile` on desktop. */
export async function fsWriteFile(
  path: string,
  data: string,
  directory: FileDirectory,
  encoding: FileEncoding,
  recursive: boolean,
): Promise<void> {
  await desktopRpc("fs", "writeFile", { path, data, directory, encoding, recursive });
}

/** `deleteFile` on desktop. */
export async function fsDeleteFile(path: string, directory: FileDirectory): Promise<void> {
  await desktopRpc("fs", "deleteFile", { path, directory });
}

/** One raw listing entry as a {@linkcode FileEntry}. */
function toEntry(raw: unknown): FileEntry {
  const e = (raw ?? {}) as { name?: unknown; type?: unknown; size?: unknown; mtime?: unknown };
  const entry: FileEntry = {
    name: String(e.name ?? ""),
    type: e.type === "directory" ? "directory" : "file",
    size: typeof e.size === "number" ? e.size : 0,
  };
  return typeof e.mtime === "number" ? { ...entry, mtime: e.mtime } : entry;
}

/** `listDir` on desktop (unsorted; the caller sorts). */
export async function fsListDir(path: string, directory: FileDirectory): Promise<FileEntry[]> {
  const raw = await desktopRpc<unknown>("fs", "listDir", { path, directory });
  return Array.isArray(raw) ? raw.map(toEntry) : [];
}

/**
 * `downloadToFile` on desktop: the runtime fetches `url` itself (no CORS, no bytes through the
 * page) and writes the file. It resolves the absolute path.
 */
export async function fsDownload(
  url: string,
  path: string,
  directory: FileDirectory,
): Promise<{ path: string }> {
  const out = await desktopRpc<{ path?: unknown }>("fs", "download", { url, path, directory }, {
    timeoutMs: false,
  });
  return { path: typeof out?.path === "string" ? out.path : path };
}

// --- sqlite (cap "sqlite") --------------------------------------------------

/** A blob on the wire: JSON has no bytes, so a blob travels as `{ $bytes: <base64> }`. */
interface WireBytes {
  $bytes: string;
}

/** A bind value as it travels (bytes tagged, the rest unchanged). */
function toWire(value: SqliteBindValue): unknown {
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) } satisfies WireBytes;
  if (value instanceof ArrayBuffer) {
    return { $bytes: bytesToBase64(new Uint8Array(value)) } satisfies WireBytes;
  }
  return value;
}

/** Parameters as they travel. */
function paramsToWire(params: SqliteParams): unknown {
  if (Array.isArray(params)) return params.map(toWire);
  return Object.fromEntries(
    Object.entries(params as Record<string, SqliteBindValue>).map(([k, v]) => [k, toWire(v)]),
  );
}

/** A cell as the page sees it (a tagged blob decoded back to bytes). */
function fromWire(value: unknown): SqliteValue {
  if (
    typeof value === "object" && value !== null && typeof (value as WireBytes).$bytes === "string"
  ) {
    return base64ToBytes((value as WireBytes).$bytes);
  }
  return typeof value === "string" || typeof value === "number" ? value : null;
}

/** A driver over the runtime's `node:sqlite` database `name` (a file in app-support). */
export async function openDesktopSqlite(name: string): Promise<SqliteDriver> {
  const opened = await desktopRpc<{ handle?: unknown }>("sqlite", "open", { name });
  const handle = opened?.handle;
  if (typeof handle !== "string") {
    throw desktopError("sqlite", "open", "bridge_error", "the runtime returned no handle");
  }
  let closed = false;
  const call = <O>(method: string, args: Record<string, unknown>) => {
    if (closed) {
      return Promise.reject(desktopError("sqlite", method, "closed", "the database is closed"));
    }
    return desktopRpc<O>("sqlite", method, { handle, ...args });
  };
  return {
    backend: "native",
    async exec(sql) {
      await call("exec", { sql });
    },
    async run(sql, params) {
      const r = await call<Partial<SqliteRunResult>>("run", { sql, params: paramsToWire(params) });
      return {
        changes: Number(r?.changes ?? 0),
        lastInsertRowId: Number(r?.lastInsertRowId ?? 0),
      };
    },
    async query(sql, params) {
      const r = await call<Partial<SqliteRows>>("query", { sql, params: paramsToWire(params) });
      return {
        columns: Array.isArray(r?.columns) ? r.columns.map(String) : [],
        rows: Array.isArray(r?.rows)
          ? r.rows.map((row) => (Array.isArray(row) ? row.map(fromWire) : []))
          : [],
      };
    },
    async inTransaction() {
      return (await call<unknown>("inTransaction", {})) === true;
    },
    async close() {
      if (closed) return;
      closed = true;
      await desktopRpc("sqlite", "close", { handle });
    },
  };
}

/** `deleteSqlite` on desktop. */
export async function deleteDesktopSqlite(name: string): Promise<void> {
  await desktopRpc("sqlite", "delete", { name });
}

// --- context menu (cap "contextMenu") ---------------------------------------

/** One native menu item on the wire. */
interface WireMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  destructive?: boolean;
  icon?: string;
}

/**
 * `showContextMenu` on desktop: the native menu at client coordinates (`BrowserWindow
 * .showContextMenu`). Resolves the chosen id, or `null` when dismissed.
 */
export async function showNativeContextMenu(
  items: ReadonlyArray<
    { id: string; label: string; disabled?: boolean; destructive?: boolean; icon?: string }
  >,
  x: number,
  y: number,
  title: string | undefined,
): Promise<string | null> {
  const wire: WireMenuItem[] = items.map((it) => ({
    id: it.id,
    label: it.label,
    enabled: it.disabled !== true,
    ...(it.destructive ? { destructive: true } : {}),
    ...(it.icon !== undefined ? { icon: it.icon } : {}),
  }));
  const out = await desktopRpc<{ id?: unknown }>(
    "contextMenu",
    "show",
    { items: wire, x: Math.round(x), y: Math.round(y), ...(title !== undefined ? { title } : {}) },
    { timeoutMs: false },
  );
  return typeof out?.id === "string" ? out.id : null;
}

// --- shell (cap "shell") ----------------------------------------------------

/**
 * What a shell call acts on: an absolute path inside the app's folders, or a picked item's
 * handle (the RPC carries exactly one of `path` / `handle`).
 */
export type ShellTarget = { readonly path: string } | { readonly handle: PickedHandle };

/** The RPC arguments for a {@linkcode ShellTarget}. */
function shellArgs(target: ShellTarget): { path: string } | { handle: string } {
  return "handle" in target ? { handle: target.handle } : { path: target.path };
}

/** `openExternal` on desktop: the system browser / mail client (the runtime re-checks the scheme). */
export async function shellOpenExternal(url: string): Promise<void> {
  await desktopRpc("shell", "openExternal", { url });
}

/** `openPath` on desktop: open a file or folder with its default app. */
export async function shellOpenPath(target: ShellTarget): Promise<void> {
  await desktopRpc("shell", "openPath", shellArgs(target));
}

/** `revealInFileManager` on desktop: show the item selected in Finder / Explorer / the file manager. */
export async function shellReveal(target: ShellTarget): Promise<void> {
  await desktopRpc("shell", "reveal", shellArgs(target));
}

/** `moveToTrash` on desktop: move the item to the Trash / Recycle Bin. */
export async function shellTrash(target: ShellTarget): Promise<void> {
  await desktopRpc("shell", "trash", shellArgs(target));
}

// --- dialogs (cap "dialogs") ------------------------------------------------

/** One raw picked file as a {@linkcode PickedDocument}. */
function toPicked(raw: unknown): PickedDocument {
  const f = (raw ?? {}) as {
    name?: unknown;
    mimeType?: unknown;
    size?: unknown;
    path?: unknown;
    handle?: unknown;
    data?: unknown;
  };
  const picked: PickedDocument = {
    name: String(f.name ?? ""),
    mimeType: typeof f.mimeType === "string" && f.mimeType
      ? f.mimeType
      : "application/octet-stream",
    size: typeof f.size === "number" ? f.size : 0,
    ...(typeof f.path === "string" ? { path: f.path } : {}),
    ...(typeof f.handle === "string" && f.handle ? { handle: f.handle } : {}),
  };
  return typeof f.data === "string" ? { ...picked, data: f.data } : picked;
}

/**
 * `pickDocument` on desktop: the native open panel. The runtime issues a per-session `handle`
 * for the chosen file (the `path` is for display); `data` (base64) only with `readData`.
 */
export async function dialogOpenFile(
  types: readonly string[] | undefined,
  readData: boolean,
): Promise<PickedDocument | null> {
  const out = await desktopRpc<{ files?: unknown }>(
    "dialogs",
    "openFile",
    { multiple: false, readData, ...(types && types.length > 0 ? { types: [...types] } : {}) },
    { timeoutMs: false },
  );
  const files = Array.isArray(out?.files) ? out.files : [];
  return files.length > 0 ? toPicked(files[0]) : null;
}

/** `saveFile` on desktop: the native save panel, then the runtime writes `data` to the chosen path. */
export async function dialogSaveFile(
  data: string,
  encoding: FileEncoding,
  suggestedName: string | undefined,
  types: readonly string[] | undefined,
): Promise<{ path: string; name: string; handle?: PickedHandle } | null> {
  const out = await desktopRpc<{ path?: unknown; handle?: unknown }>(
    "dialogs",
    "saveFile",
    {
      data,
      encoding,
      ...(suggestedName !== undefined ? { suggestedName } : {}),
      ...(types && types.length > 0 ? { types: [...types] } : {}),
    },
    { timeoutMs: false },
  );
  if (typeof out?.path !== "string") return null;
  const name = out.path.split(/[\\/]/).pop() ?? out.path;
  return typeof out.handle === "string" && out.handle
    ? { path: out.path, name, handle: out.handle }
    : { path: out.path, name };
}

/**
 * `pickFolder` on desktop: the native folder panel. The runtime issues a per-session `handle`
 * for the folder (the `path` is for display).
 */
export async function dialogPickFolder(): Promise<
  { path: string; name: string; handle: PickedHandle } | null
> {
  const out = await desktopRpc<{ path?: unknown; handle?: unknown }>("dialogs", "pickFolder", {}, {
    timeoutMs: false,
  });
  if (typeof out?.path !== "string") return null;
  if (typeof out.handle !== "string" || out.handle === "") {
    throw desktopError("dialogs", "pickFolder", "bridge_error", "the runtime returned no handle");
  }
  const name = out.path.split(/[\\/]/).filter(Boolean).pop() ?? out.path;
  return { path: out.path, name, handle: out.handle };
}

// --- notifications (cap "notifications") ------------------------------------

/**
 * `scheduleNotification` on desktop. `schema` is the `@capacitor/local-notifications` shape
 * `denext/mobile` already builds (`schedule.at` / `schedule.repeats` / `schedule.on`); dates
 * travel as epoch milliseconds. The runtime shows it through the Deno-side `Notification`,
 * scheduling only while the app runs.
 */
export async function notifySchedule(schema: Record<string, unknown>): Promise<void> {
  const schedule = schema.schedule as { at?: unknown } | undefined;
  const wire = schedule?.at instanceof Date
    ? { ...schema, schedule: { ...schedule, at: schedule.at.getTime() } }
    : schema;
  await desktopRpc("notifications", "schedule", wire);
}

/** `cancelNotification` on desktop. */
export async function notifyCancel(ids: readonly number[]): Promise<void> {
  await desktopRpc("notifications", "cancel", { ids: [...ids] });
}

/** `pendingNotifications` on desktop (raw `{ id, title, body, extra }` records). */
export async function notifyPending(): Promise<
  Array<{ id?: unknown; title?: unknown; body?: unknown; extra?: unknown }>
> {
  const out = await desktopRpc<unknown>("notifications", "pending", {});
  return Array.isArray(out) ? out : [];
}

// --- keep awake (cap "keepAwake") -------------------------------------------

/**
 * Keep the display awake through the runtime (`caffeinate` / `SetThreadExecutionState` /
 * `systemd-inhibit`). Each holder acquires its own id (the runtime keeps one OS assertion
 * while any id is held). Returns the release.
 *
 * @param onUnavailable Called when the `keepAwake` capability is not enabled, so the caller
 * can fall back to the page's wake lock.
 */
export function holdDesktopAwake(onUnavailable: () => void): () => void {
  let released = false;
  let id: string | undefined;
  const release = (held: string) =>
    desktopRpc("keepAwake", "release", { id: held }).catch(() => {});
  desktopRpc<{ id?: unknown }>("keepAwake", "acquire", {}).then(
    (out) => {
      const got = typeof out?.id === "string" ? out.id : undefined;
      if (got !== undefined && released) release(got);
      else id = got;
    },
    (err) => {
      if (!released && (err as { code?: unknown })?.code === "unavailable") onUnavailable();
    },
  );
  return () => {
    if (released) return;
    released = true;
    if (id !== undefined) release(id);
  };
}

// --- clipboard (cap "clipboard") --------------------------------------------

/** `readClipboard` on desktop (no user-gesture requirement: the runtime reads it). */
export async function clipboardRead(): Promise<string> {
  const text = await desktopRpc<unknown>("clipboard", "readText", {});
  return typeof text === "string" ? text : "";
}

/** `writeClipboard` on desktop. */
export async function clipboardWrite(text: string): Promise<void> {
  await desktopRpc("clipboard", "writeText", { text });
}

// --- device (cap "device") --------------------------------------------------

/** What the runtime reports about the machine. */
export interface DesktopDeviceFacts {
  /** `"Macintosh"` / `"Windows"` / `"Linux"`, or the runtime's model string. */
  readonly model?: string;
  /** The OS release (`Deno.osRelease()`). */
  readonly osVersion?: string;
}

/** `deviceInfo` on desktop: `{ os, osVersion, model? }` from the runtime. */
export async function desktopDeviceFacts(): Promise<DesktopDeviceFacts> {
  const out = await desktopRpc<{ os?: unknown; osVersion?: unknown; model?: unknown }>(
    "device",
    "info",
    {},
  );
  const model = typeof out?.model === "string"
    ? out.model
    : ({ darwin: "Macintosh", windows: "Windows", linux: "Linux" } as Record<string, string>)[
      String(out?.os)
    ];
  return {
    ...(model !== undefined ? { model } : {}),
    ...(typeof out?.osVersion === "string" ? { osVersion: out.osVersion } : {}),
  };
}
