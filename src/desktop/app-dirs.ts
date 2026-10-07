/**
 * The per-OS application directories a Deno Desktop app stores state in — the desktop twin of the
 * mobile `FileDirectory` roots. Browser storage does not survive relaunch on desktop (the runtime
 * binds a fresh loopback origin each launch), so the `fs` and `sqlite` capabilities put their data
 * under these instead. Resolved once at startup by {@link resolveDesktopCapabilities} and handed to
 * the capability factories.
 *
 * The three roots mirror the config path tokens the package scripts derive `--allow-*` from:
 * `$APPDATA` → {@link DesktopAppDirs.data}, `$CACHE` → {@link DesktopAppDirs.cache}, `$DOCUMENTS`
 * → {@link DesktopAppDirs.documents} (see `src/build/desktop-capabilities.ts`).
 *
 * Runtime-only (imported by the desktop entry via `runDesktop`, never a client bundle). Best-effort:
 * each falls back to a home-relative path when the OS env var is missing, and to `.` when even the
 * home directory is unknown (no permission), so a call never throws for a missing env.
 *
 * @module
 */

import { join } from "@std/path";

/** The three per-app storage roots a desktop app uses (absolute paths, not created here). */
export interface DesktopAppDirs {
  /** App data that persists until the app is removed (`$APPDATA`; mobile `directory: "data"`). */
  readonly data: string;
  /** Storage the OS may clear under pressure (`$CACHE`; mobile `directory: "cache"`). */
  readonly cache: string;
  /** The user-visible Documents folder for the app (`$DOCUMENTS`; mobile `directory: "documents"`). */
  readonly documents: string;
}

/** The operating systems a Deno Desktop app ships for (`Deno.build.os` spelling). */
export type DesktopOsName = "darwin" | "windows" | "linux";

/**
 * Read an env var (trying the lowercase spelling too), or undefined without permission. The
 * canonical copy shared by the desktop runtime modules (the updater imports it too).
 */
export function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? Deno.env.get(name.toLowerCase()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The user's home directory (best effort; `.` when unknown). */
function homeDir(): string {
  return env("HOME") ?? env("USERPROFILE") ?? ".";
}

/** A non-empty trimmed env value, or undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

/**
 * The per-OS app DATA root for `appId` (the app-support parent), the single source of the
 * layout the updater (`<data>/ui-updates`) and the `fs`/`sqlite` capabilities both build on:
 *
 * - macOS: `~/Library/Application Support/<id>`.
 * - Windows: `%APPDATA%|~/AppData/Roaming /<id>`.
 * - Linux: `$XDG_DATA_HOME|~/.local/share /<id>`.
 *
 * @param appId The app identifier.
 * @param os The target OS (defaults to the running one; a param so every branch is unit-tested).
 * @returns The absolute data root (not created).
 */
export function osDataDir(
  appId: string,
  os: DesktopOsName = Deno.build.os as DesktopOsName,
): string {
  const home = homeDir();
  if (os === "darwin") return join(home, "Library", "Application Support", appId);
  if (os === "windows") {
    const appData = env("APPDATA") ?? join(home, "AppData", "Roaming");
    return join(appData, appId);
  }
  const xdg = env("XDG_DATA_HOME");
  const base = xdg && xdg.trim() ? xdg : join(home, ".local", "share");
  return join(base, appId);
}

/** The cache root's folder inside the OS cache folder for the app (see {@link desktopAppDirs}). */
const CACHE_SUBDIR = "denext";

/**
 * The `data` / `cache` / `documents` roots for `appId` on `os`, each `join`ed with `appId` so two
 * apps never share a folder. `data` is {@link osDataDir}; the other two:
 *
 * - macOS: `~/Library/Caches/<id>/denext`, `~/Documents/<id>`.
 * - Windows: `%LOCALAPPDATA%/<id>/Cache`, `~/Documents/<id>`.
 * - Linux: `$XDG_CACHE_HOME|~/.cache /<id>/denext`, `$XDG_DOCUMENTS_DIR|~/Documents /<id>`.
 *
 * The cache root is a folder of its own ({@link CACHE_SUBDIR}) inside the OS cache folder for the
 * app, never that folder itself: the web engine keeps its caches there too, keyed by the same id —
 * Chromium (CEF) maps its profile's HTTP and code caches to `~/Library/Caches/<id>/CEF/…`, WKWebView
 * keeps `~/Library/Caches/<id>/WebKit/…`, and WebKitGTK's default context `~/.cache/<id>/WebKitCache`.
 * A page's `directory: "cache"` must not list, read or rewrite those. (Windows' `Cache` folder is
 * already one of its own.)
 *
 * @param appId The app's reverse-DNS identifier (`desktop.app.identifier`), or a fallback name.
 * @param os The target OS (defaults to the running one; a param so every branch is unit-tested).
 * @returns The three absolute roots (not created; the capabilities `mkdir` on first use).
 */
export function desktopAppDirs(
  appId: string,
  os: DesktopOsName = Deno.build.os as DesktopOsName,
): DesktopAppDirs {
  const home = homeDir();
  const data = osDataDir(appId, os);
  if (os === "darwin") {
    return {
      data,
      cache: join(home, "Library", "Caches", appId, CACHE_SUBDIR),
      documents: join(home, "Documents", appId),
    };
  }
  if (os === "windows") {
    const localAppData = nonEmpty(env("LOCALAPPDATA")) ?? join(home, "AppData", "Local");
    return {
      data,
      cache: join(localAppData, appId, "Cache"),
      documents: join(home, "Documents", appId),
    };
  }
  const cacheBase = nonEmpty(env("XDG_CACHE_HOME")) ?? join(home, ".cache");
  const docsBase = nonEmpty(env("XDG_DOCUMENTS_DIR")) ?? join(home, "Documents");
  return {
    data,
    cache: join(cacheBase, appId, CACHE_SUBDIR),
    documents: join(docsBase, appId),
  };
}
