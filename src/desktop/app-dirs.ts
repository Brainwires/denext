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

/** Read an env var (trying the lowercase spelling too), or undefined without permission. */
function env(name: string): string | undefined {
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
 * The `data` / `cache` / `documents` roots for `appId` on the running OS, each `join`ed with
 * `appId` so two apps never share a folder:
 *
 * - macOS: `~/Library/Application Support/<id>`, `~/Library/Caches/<id>`, `~/Documents/<id>`.
 * - Windows: `%APPDATA%/<id>`, `%LOCALAPPDATA%/<id>/Cache`, `~/Documents/<id>`.
 * - Linux: `$XDG_DATA_HOME|~/.local/share /<id>`, `$XDG_CACHE_HOME|~/.cache /<id>`,
 *   `$XDG_DOCUMENTS_DIR|~/Documents /<id>`.
 *
 * @param appId The app's reverse-DNS identifier (`desktop.app.identifier`), or a fallback name.
 * @returns The three absolute roots (not created; the capabilities `mkdir` on first use).
 */
// fallow-ignore-next-line complexity -- per-OS path table; branches not unit-tested on every OS, CRAP is coverage-estimated
export function desktopAppDirs(appId: string): DesktopAppDirs {
  const home = homeDir();
  const os = Deno.build.os;
  if (os === "darwin") {
    const lib = join(home, "Library");
    return {
      data: join(lib, "Application Support", appId),
      cache: join(lib, "Caches", appId),
      documents: join(home, "Documents", appId),
    };
  }
  if (os === "windows") {
    const appData = nonEmpty(env("APPDATA")) ?? join(home, "AppData", "Roaming");
    const localAppData = nonEmpty(env("LOCALAPPDATA")) ?? join(home, "AppData", "Local");
    return {
      data: join(appData, appId),
      cache: join(localAppData, appId, "Cache"),
      documents: join(home, "Documents", appId),
    };
  }
  const dataBase = nonEmpty(env("XDG_DATA_HOME")) ?? join(home, ".local", "share");
  const cacheBase = nonEmpty(env("XDG_CACHE_HOME")) ?? join(home, ".cache");
  const docsBase = nonEmpty(env("XDG_DOCUMENTS_DIR")) ?? join(home, "Documents");
  return {
    data: join(dataBase, appId),
    cache: join(cacheBase, appId),
    documents: join(docsBase, appId),
  };
}
