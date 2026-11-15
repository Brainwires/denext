/**
 * A tray icon per OS: `desktop.tray.icon`, `runDesktop({ tray: { icon } })` and `denext/desktop/app`'s
 * `createTray` / `tray.update` take one icon for every OS, or `{ macos, windows, linux, default }`
 * where each entry is an icon or `{ icon, iconDark }` (macOS wants a black-and-transparent template
 * image, Windows full-colour art with a dark-taskbar variant). The running OS's entry is used, else
 * `default`.
 *
 * Shared by the config validator, the backend tray and the `app` capability (never a client bundle:
 * the page sends the set as it is and the backend picks).
 *
 * @module
 */

/** The OS keys of a per-OS tray icon. */
const TRAY_ICON_OSES = ["macos", "windows", "linux"] as const;

/** One OS's tray icon: the icon, or the icon with its dark-mode variant. */
export type TrayIconVariant<I> = I | { readonly icon: I; readonly iconDark?: I | null };

/** A tray icon per OS; an OS left out takes `default`. */
export interface TrayIconSet<I> {
  /** The macOS menu bar's (a black-and-transparent template image, about 18 pt). */
  readonly macos?: TrayIconVariant<I>;
  /** The Windows notification area's (full colour; `iconDark` for a dark taskbar). */
  readonly windows?: TrayIconVariant<I>;
  /** The Linux tray's (AppIndicator / StatusNotifierItem). */
  readonly linux?: TrayIconVariant<I>;
  /** Every OS not named. */
  readonly default?: TrayIconVariant<I>;
}

/** The keys a {@linkcode TrayIconSet} may have. */
const SET_KEYS: ReadonlySet<string> = new Set([...TRAY_ICON_OSES, "default"]);

/** Whether `value` is a plain object (not an array, not bytes). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !(value instanceof Uint8Array);
}

/** Whether `value` is a per-OS set (an object with an OS or `default` key), not a single icon. */
function isTrayIconSet(value: unknown): value is TrayIconSet<unknown> {
  return isRecord(value) && !("icon" in value);
}

/** The tray-icon key of `os` (a `Deno.build.os` value): `darwin` is `macos`, BSDs are `linux`. */
export function trayIconOs(os: string): (typeof TRAY_ICON_OSES)[number] {
  if (os === "darwin" || os === "macos") return "macos";
  return os === "windows" ? "windows" : "linux";
}

/** The first problem with one OS's entry (an icon, or `{ icon, iconDark }`), or `null`. */
function entryProblem(
  key: string,
  entry: unknown,
  leafProblem: (icon: unknown) => string | null,
): [string, string] | null {
  if (!isRecord(entry)) {
    const problem = leafProblem(entry);
    return problem === null ? null : [`.${key}`, problem];
  }
  const icon = leafProblem(entry.icon);
  if (icon !== null) return [`.${key}.icon`, icon];
  const dark = entry.iconDark == null ? null : leafProblem(entry.iconDark);
  if (dark !== null) return [`.${key}.iconDark`, dark];
  const extra = Object.keys(entry).find((k) => k !== "icon" && k !== "iconDark");
  return extra === undefined ? null : [`.${key}.${extra}`, "is not a key: use { icon, iconDark? }"];
}

/**
 * The first problem with a tray `icon` value as `[subkey, message]` (`""` for the value itself,
 * `".macos"`, `".windows.iconDark"`, …), or `null`.
 *
 * @param value The `icon` value.
 * @param leafProblem Whether one icon is acceptable (`null`) or what is wrong with it.
 * @returns The problem, or `null`.
 */
export function trayIconProblem(
  value: unknown,
  leafProblem: (icon: unknown) => string | null,
): [string, string] | null {
  if (!isTrayIconSet(value)) {
    const problem = leafProblem(value);
    return problem === null ? null : ["", problem];
  }
  const keys = Object.keys(value);
  const stray = keys.find((k) => !SET_KEYS.has(k));
  if (stray !== undefined) {
    return [`.${stray}`, "is not an OS: use macos, windows, linux or default"];
  }
  if (keys.length === 0) return ["", "names no OS: use { macos?, windows?, linux?, default? }"];
  for (const key of keys) {
    const problem = entryProblem(key, value[key as keyof typeof value], leafProblem);
    if (problem) return problem;
  }
  return null;
}

/** The icon (and dark-mode icon) a tray shows on one OS. */
export interface ResolvedTrayIcon<I> {
  /** The icon. */
  readonly icon: I;
  /** The dark-mode icon (`undefined`: unchanged; `null`: none). */
  readonly iconDark?: I | null;
}

/**
 * The icon `os` shows for a tray `icon` value (one icon, or a per-OS set) and the separate
 * `iconDark`: the OS's entry (else `default`), whose own `iconDark` wins over the separate one.
 *
 * @param icon The `icon` value.
 * @param iconDark The separate `iconDark` (`undefined`: not given).
 * @param os The running OS (`Deno.build.os`).
 * @returns The resolved icons, or `null` when a per-OS set names neither `os` nor `default`.
 */
export function resolveTrayIcon<I>(
  icon: I | TrayIconSet<I>,
  iconDark: I | null | undefined,
  os: string,
): ResolvedTrayIcon<I> | null {
  if (!isTrayIconSet(icon)) {
    return { icon: icon as I, ...(iconDark !== undefined ? { iconDark } : {}) };
  }
  const set = icon as TrayIconSet<I>;
  const entry = set[trayIconOs(os)] ?? set.default;
  if (entry === undefined) return null;
  if (!isRecord(entry)) {
    return { icon: entry as I, ...(iconDark !== undefined ? { iconDark } : {}) };
  }
  const e = entry as { icon: I; iconDark?: I | null };
  const dark = e.iconDark !== undefined ? e.iconDark : iconDark;
  return { icon: e.icon, ...(dark !== undefined ? { iconDark: dark } : {}) };
}
