// Where the inbox file lives: the app's data folder, the same one the desktop runtime hands the
// app (`~/Library/Application Support/<id>` on macOS, `%APPDATA%\<id>` on Windows,
// `$XDG_DATA_HOME|~/.local/share /<id>` on Linux). The CLI computes it the same way, so it finds
// the token without asking the app. `LOOPY_INBOX` overrides it for both.

/** Loopy's app identifier (`desktop.app.identifier`): the name of its data folder. */
export const APP_ID = "dev.denext.loopy";

/** The inbox file's name inside the data folder. */
const INBOX_FILE = "loopy-inbox.json";

/** The OS names Deno reports. */
export type OsName = "darwin" | "windows" | "linux";

/** Reads an environment variable (undefined when unset or not permitted). */
export type EnvReader = (name: string) => string | undefined;

/** `Deno.env.get`, undefined without permission. */
const denoEnv: EnvReader = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v : undefined);

/** The app's data folder for `os`. */
export function dataDir(
  os: OsName = Deno.build.os as OsName,
  env: EnvReader = denoEnv,
  appId: string = APP_ID,
): string {
  const sep = os === "windows" ? "\\" : "/";
  const home = env("HOME") ?? env("USERPROFILE") ?? ".";
  if (os === "darwin") return [home, "Library", "Application Support", appId].join(sep);
  if (os === "windows") {
    return [nonEmpty(env("APPDATA")) ?? [home, "AppData", "Roaming"].join(sep), appId].join(sep);
  }
  return [nonEmpty(env("XDG_DATA_HOME")) ?? [home, ".local", "share"].join(sep), appId].join(sep);
}

/** The inbox file: `LOOPY_INBOX` when set, else {@linkcode INBOX_FILE} in the data folder. */
export function inboxFilePath(
  os: OsName = Deno.build.os as OsName,
  env: EnvReader = denoEnv,
): string {
  const override = nonEmpty(env("LOOPY_INBOX"));
  if (override) return override;
  return [dataDir(os, env), INBOX_FILE].join(os === "windows" ? "\\" : "/");
}
