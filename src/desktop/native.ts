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
import { desktopError, desktopRpc, subscribeDesktopEvent } from "./bridge-client.ts";
import { onAppAction } from "./app-actions.ts";
import { pullQueue, type PullSubscribe } from "./pull.ts";

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

/** One context-menu entry as the page builds it (`denext/mobile`'s `ContextMenuItem`). */
export interface DesktopContextMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly subtitle?: string;
  readonly children?: readonly DesktopContextMenuEntry[];
}

/** The menu wire form: items, and submenus for entries with children (a disabled one's too). */
function contextMenuWire(items: readonly DesktopContextMenuEntry[], off = false): unknown[] {
  return items.map((it) => {
    const label = it.subtitle ? `${it.label} — ${it.subtitle}` : it.label;
    const disabled = off || it.disabled === true;
    return it.children
      ? { label, children: contextMenuWire(it.children, disabled) }
      : { id: it.id, label, enabled: !disabled };
  });
}

/**
 * `showContextMenu` on desktop: the OS's native menu at client coordinates (`BrowserWindow
 * .showContextMenu` of denext's pinned runtime), submenus included. Resolves the chosen id, or
 * `null` when the user dismissed it.
 */
export async function showNativeContextMenu(
  items: readonly DesktopContextMenuEntry[],
  x: number,
  y: number,
  title: string | undefined,
): Promise<string | null> {
  const out = await desktopRpc<{ id?: unknown }>(
    "contextMenu",
    "show",
    {
      items: contextMenuWire(items),
      x: Math.round(x),
      y: Math.round(y),
      ...(title !== undefined ? { title } : {}),
    },
    { timeoutMs: false },
  );
  return typeof out?.id === "string" ? out.id : null;
}

// --- dock menu (cap "app"; setQuickActions / onQuickAction) -------------------

/**
 * `setQuickActions` on desktop: the Dock icon's menu (macOS). Resolves `false` where the OS has no
 * such menu (Windows, Linux).
 */
export async function setDesktopDockMenu(
  actions: ReadonlyArray<{ id: string; title: string }>,
): Promise<boolean> {
  const out = await desktopRpc<{ applied?: unknown }>("app", "setDockMenu", {
    menu: actions.length === 0 ? null : actions.map((a) => ({ id: a.id, label: a.title })),
  });
  return out?.applied === true;
}

/** Call `fn` with the id of each Dock-menu item the user chooses. Returns the unsubscribe. */
export function onDesktopDockMenu(fn: (id: string) => void): () => void {
  return onAppAction((action) => {
    if (action.source === "dock") fn(action.id);
  });
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
 * One notification for the runtime: `denext/mobile`'s input (already checked there), with a `date`
 * trigger's time as epoch milliseconds.
 */
export interface DesktopNotificationWire {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly categoryId?: string;
  readonly threadId?: string;
  readonly trigger?: unknown;
}

/**
 * `scheduleNotification` on desktop: the OS's own notification, now or at the trigger's time (a
 * repeating trigger's occurrences are scheduled by the runtime).
 */
export async function notifySchedule(notification: DesktopNotificationWire): Promise<void> {
  const t = notification.trigger as { type?: unknown; date?: unknown } | undefined;
  const trigger = t?.type === "date" && t.date instanceof Date
    ? { ...t, date: t.date.getTime() }
    : t;
  await desktopRpc("notifications", "schedule", {
    ...notification,
    ...(trigger ? { trigger } : {}),
  });
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

/**
 * `deliveredNotifications` on desktop: the notifications the capability posted this run whose
 * time has come (raw `{ id, threadId?, title?, data? }` records, `id` a string).
 */
export async function notifyDelivered(): Promise<
  Array<{ id?: unknown; threadId?: unknown; title?: unknown; data?: unknown }>
> {
  const out = await desktopRpc<unknown>("notifications", "delivered", {});
  return Array.isArray(out) ? out : [];
}

/** `removeDeliveredNotifications` on desktop: remove the delivered occurrences of `ids`. */
export async function notifyRemoveDelivered(ids: readonly number[]): Promise<void> {
  await desktopRpc("notifications", "removeDelivered", { ids: [...ids] });
}

/** `setNotificationCategories` on desktop: the action buttons per category id. */
export async function notifySetCategories(
  categories: ReadonlyArray<{ id: string; actions: ReadonlyArray<{ id: string; title: string }> }>,
): Promise<void> {
  await desktopRpc("notifications", "setCategories", {
    categories: categories.map((c) => ({
      id: c.id,
      actions: c.actions.map((a) => ({ id: a.id, title: a.title })),
    })),
  });
}

/**
 * The notification permission on desktop (`request`: prompt when undecided): `granted`, `denied`,
 * `prompt`, or `unsupported` where the OS has no notifications.
 */
export async function notifyPermission(request: boolean): Promise<string> {
  const out = await desktopRpc<{ state?: unknown }>(
    "notifications",
    "permission",
    { request },
    { timeoutMs: false },
  );
  return typeof out?.state === "string" ? out.state : "prompt";
}

/** A click on a notification, as the runtime queues it. */
export interface DesktopNotificationTap {
  readonly id: number;
  readonly actionId: string;
  readonly title?: string;
  readonly body?: string;
  readonly data: Record<string, unknown>;
  readonly launch: boolean;
}

/** One queued click, checked. */
function toTap(raw: unknown): DesktopNotificationTap | undefined {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (typeof t.id !== "number") return undefined;
  return {
    id: t.id,
    actionId: typeof t.actionId === "string" ? t.actionId : "tap",
    ...(typeof t.title === "string" ? { title: t.title } : {}),
    ...(typeof t.body === "string" ? { body: t.body } : {}),
    data: typeof t.data === "object" && t.data !== null ? t.data as Record<string, unknown> : {},
    launch: t.launch === true,
  };
}

/**
 * Call `fn` with each click on one of the app's notifications, the one that launched the app
 * first. Returns the unsubscribe.
 */
export const onDesktopNotificationTap: PullSubscribe<DesktopNotificationTap> = pullQueue(
  "notifications",
  "tap",
  toTap,
);

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

/**
 * `readClipboard({ format })` on desktop: `"html"` as a string, `"image"` as base64 PNG (`""` when
 * the clipboard holds none). A backend without that format rejects `unsupported`.
 */
export async function clipboardReadFormat(format: "text" | "html" | "image"): Promise<string> {
  const out = await desktopRpc<unknown>("clipboard", "read", { format });
  return typeof out === "string" ? out : "";
}

/** `writeClipboard({ text?, html?, image? })` on desktop (an image is exclusive). */
export async function clipboardWriteContent(
  content: { readonly text?: string; readonly html?: string; readonly image?: string },
): Promise<void> {
  await desktopRpc("clipboard", "write", {
    ...(content.text !== undefined ? { text: content.text } : {}),
    ...(content.html !== undefined ? { html: content.html } : {}),
    ...(content.image !== undefined ? { image: content.image } : {}),
  });
}

/** `clipboardFormats()` on desktop: the OS clipboard's formats as MIME types. */
export async function clipboardFormats(): Promise<string[]> {
  const out = await desktopRpc<unknown>("clipboard", "formats", {});
  return Array.isArray(out) ? out.filter((f): f is string => typeof f === "string") : [];
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

// --- deep links / opened files (caps "deepLinks" / "openFiles", denext's pinned runtime) ------

/** One deep link the runtime handed over (a scheme from `desktop.app.deepLinks`). */
export interface DesktopLink {
  /** The URL as the OS delivered it. */
  readonly url: string;
  /** `true` for the link that cold-started the app. */
  readonly launch: boolean;
}

/** One file the OS opened with the app, as a read-only picked handle. */
export interface DesktopOpenedFile {
  /** The read-only handle (`{ directory: { picked: handle } }`). */
  readonly handle: string;
  /** The file name. */
  readonly name: string;
  /** The absolute path, for display only. */
  readonly path: string;
  /** `true` for a file the app was launched with. */
  readonly launch: boolean;
}

/** Take (and empty) the runtime's queue of deep links. */
export async function takeDesktopDeepLinks(): Promise<DesktopLink[]> {
  const raw = await desktopRpc<unknown>("deepLinks", "take", {});
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const l = (item ?? {}) as { url?: unknown; launch?: unknown };
    return typeof l.url === "string" ? [{ url: l.url, launch: l.launch === true }] : [];
  });
}

/** Take (and empty) the runtime's queue of opened files. */
export async function takeDesktopOpenedFiles(): Promise<DesktopOpenedFile[]> {
  const raw = await desktopRpc<unknown>("openFiles", "take", {});
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    const f = (item ?? {}) as {
      handle?: unknown;
      name?: unknown;
      path?: unknown;
      launch?: unknown;
    };
    if (typeof f.handle !== "string" || f.handle === "") return [];
    return [{
      handle: f.handle,
      name: String(f.name ?? ""),
      path: String(f.path ?? ""),
      launch: f.launch === true,
    }];
  });
}

/**
 * Call `fn` whenever the runtime signals that its `deepLinks` / `openFiles` queue has something
 * (the signal carries no data; take the queue). Returns the unsubscribe.
 */
export function onDesktopQueue(cap: "deepLinks" | "openFiles", fn: () => void): () => void {
  return subscribeDesktopEvent(cap, "available", () => fn());
}
