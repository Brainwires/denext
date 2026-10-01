// The per-app files the desktop packager writes so the denext-pinned Deno Desktop runtime serves
// the app at its configured origin with per-app storage:
//
//   .deno-desktop/app.json   `{ "origin", "identifier", "deepLinks", "singleInstance" }` from
//                            `desktop.app` in denext.config.ts,
//                            embedded into the binary through deno.json `compile.include` (the path
//                            a stock `deno desktop` CLI accepts; the runtime reads it back at launch)
//   laufey-launch.json       the webview backend's launch settings (`appId`, `customSchemes`,
//                            `singleInstance`), read at process start from the packaged bundle:
//                            `<App>.app/Contents/Resources/` on macOS, next to the executable on
//                            Windows and Linux
//
// The scaffolded `scripts/package-*.ts` call {@linkcode syncDesktopAppConfig} before `deno desktop`
// and {@linkcode writeLaufeyLaunchConfig} on its output (before signing on macOS). `denext desktop
// run` / `dev` sync `app.json` and pass the launch settings as `LAUFEY_*` env instead.

import { dirname, fromFileUrl, join } from "@std/path";
import {
  desktopAppIdentifierError,
  normalizeDesktopDeepLinks,
  originWithoutIdentifierMessage,
  parseDesktopAppOrigin,
} from "../desktop/app-origin.ts";
import type { DesktopOs } from "./desktop-capabilities.ts";

/** Where the runtime looks for the embedded origin + identifier, relative to the project root. */
export const DESKTOP_APP_CONFIG_FILE = ".deno-desktop/app.json";
/** The webview backend's launch-settings file name. */
export const LAUFEY_LAUNCH_FILE = "laufey-launch.json";

/** The app's configured origin and identifier (both validated, the origin normalized). */
export interface DesktopAppIdentity {
  readonly origin: string;
  readonly identifier: string;
}

/**
 * The webview backend's launch settings (`laufey-launch.json`). Every key is optional; the
 * `LAUFEY_APP_ID` / `LAUFEY_CUSTOM_SCHEMES` / `LAUFEY_SINGLE_INSTANCE` env vars override it per key.
 */
export interface LaufeyLaunchConfig {
  /** The app identifier: CEF keys persistent web storage by it. */
  readonly appId?: string;
  /** Custom URL schemes the webview must serve as secure origins (the origin's, when not `app`). */
  readonly customSchemes?: string[];
  /** One running instance per app id (effective once the runtime supports it). */
  readonly singleInstance?: boolean;
}

/** The `desktop.app` block of an untyped config value. */
function appBlock(config: unknown): Record<string, unknown> | undefined {
  const desktop = (config as { desktop?: unknown } | undefined)?.desktop;
  const app = (desktop as { app?: unknown } | undefined)?.app;
  return typeof app === "object" && app !== null ? app as Record<string, unknown> : undefined;
}

/**
 * The configured origin + identifier, or `null` when no `desktop.app.origin` is set. Throws with
 * the runtime's message when the origin is invalid or has no valid identifier.
 *
 * @param config The project config (`denext.config.ts`'s default export).
 * @returns The identity, or `null`.
 */
export function desktopAppIdentity(config: unknown): DesktopAppIdentity | null {
  const app = appBlock(config);
  const raw = app?.origin;
  if (raw === undefined) return null;
  if (typeof raw !== "string") throw new Error("desktop.app.origin must be a string");
  const parsed = parseDesktopAppOrigin(raw);
  if (!parsed.ok) throw new Error(`invalid desktop.app.origin "${raw}": ${parsed.error}`);
  const identifier = app?.identifier;
  if (identifier === undefined) throw new Error(originWithoutIdentifierMessage(raw));
  const idError = typeof identifier === "string"
    ? desktopAppIdentifierError(identifier)
    : "must be a string";
  if (idError) throw new Error(`invalid desktop.app.identifier: ${idError}`);
  return { origin: parsed.value.origin, identifier: identifier as string };
}

/** laufey's `IsSafeAppId`: one path component of `A-Z a-z 0-9 . _ -`, not `.` or `..`. */
function isLaufeyAppId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";
}

/**
 * The launch settings for the packaged app, or `null` when there is nothing to set: `appId` from
 * `desktop.app.identifier` (when laufey accepts it), `customSchemes` holding the ORIGIN's scheme
 * when it is not the built-in `app` (deep-link schemes are OS registrations, not webview schemes),
 * and `singleInstance` when configured.
 *
 * @param config The project config.
 * @returns The settings, or `null`.
 */
export function desktopLaunchConfig(config: unknown): LaufeyLaunchConfig | null {
  const app = appBlock(config);
  const identity = desktopAppIdentity(config);
  const out: { appId?: string; customSchemes?: string[]; singleInstance?: boolean } = {};
  const id = identity?.identifier ?? app?.identifier;
  if (typeof id === "string" && isLaufeyAppId(id)) out.appId = id;
  const scheme = identity ? identity.origin.slice(0, identity.origin.indexOf("://")) : undefined;
  if (scheme !== undefined && scheme !== "app") out.customSchemes = [scheme];
  if (typeof app?.singleInstance === "boolean") out.singleInstance = app.singleInstance;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * The same settings as `LAUFEY_*` env vars, for an unpackaged `deno desktop` run (no bundle to put
 * `laufey-launch.json` in).
 *
 * @param launch The settings.
 * @returns The env vars.
 */
export function laufeyLaunchEnv(launch: LaufeyLaunchConfig | null): Record<string, string> {
  const env: Record<string, string> = {};
  if (launch?.appId) env.LAUFEY_APP_ID = launch.appId;
  if (launch?.customSchemes?.length) env.LAUFEY_CUSTOM_SCHEMES = launch.customSchemes.join(",");
  if (launch?.singleInstance !== undefined) {
    env.LAUFEY_SINGLE_INSTANCE = launch.singleInstance ? "1" : "0";
  }
  return env;
}

/**
 * Where `laufey-launch.json` goes in a packaged app: `<App>.app/Contents/Resources/` on macOS, the
 * bundle directory (next to the executable) on Windows and Linux.
 *
 * @param os The target OS.
 * @param bundle The `.app` (macOS) or bundle directory (Windows / Linux).
 * @returns The file path.
 */
export function laufeyLaunchPath(os: DesktopOs, bundle: string): string {
  return os === "darwin"
    ? join(bundle, "Contents", "Resources", LAUFEY_LAUNCH_FILE)
    : join(bundle, LAUFEY_LAUNCH_FILE);
}

/** `denext.config.ts` next to the scripts dir of `entryUrl` (a missing config is `undefined`). */
async function loadConfigBeside(entryUrl: string): Promise<unknown> {
  try {
    const mod = await import(new URL("../denext.config.ts", entryUrl).href);
    return (mod as { default?: unknown }).default;
  } catch (err) {
    if (err instanceof Error && /Module not found|Cannot find module/i.test(err.message)) {
      return undefined;
    }
    throw err;
  }
}

/**
 * Write the packaged app's `laufey-launch.json` from `desktop.app` in the project's
 * `denext.config.ts` (resolved beside `entryUrl`'s directory, like `desktopPackageFlags`). On macOS
 * call it BEFORE code-signing: the file lives inside the sealed bundle.
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder.
 * @param os The target OS.
 * @param bundle The `.app` (macOS) or bundle directory (Windows / Linux) `deno desktop` wrote.
 * @returns The path written, or `null` when there was nothing to write.
 */
export async function writeLaufeyLaunchConfig(
  entryUrl: string,
  os: DesktopOs,
  bundle: string,
): Promise<string | null> {
  const launch = desktopLaunchConfig(await loadConfigBeside(entryUrl));
  if (!launch) return null;
  const path = laufeyLaunchPath(os, bundle);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(launch, null, 2) + "\n");
  return path;
}

/** What {@linkcode syncDesktopAppConfig} did. */
export interface DesktopAppSyncReport {
  /** `.deno-desktop/app.json`: written, already current, removed (origin unset), or absent. */
  readonly appJson: "written" | "unchanged" | "removed" | "none";
  /** `compile.include` in deno.json: updated, already right, or no deno.json to edit. */
  readonly include: "updated" | "unchanged" | "no-deno-json";
  /** deno.json `desktop.app.deepLinks` (present only when deep links are configured). */
  readonly deepLinks?: "updated" | "unchanged" | "no-deno-json";
}

/** Whether `path` is a symbolic link (a missing path is not). */
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isSymlink;
  } catch {
    return false;
  }
}

/** The project's `deno.json` (else `deno.jsonc`), if any. */
async function findDenoJson(root: string): Promise<string | undefined> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      if ((await Deno.stat(join(root, name))).isFile) return join(root, name);
    } catch { /* not this one */ }
  }
  return undefined;
}

/** `./x` and `x` name the same include. */
function sameInclude(entry: unknown): boolean {
  return typeof entry === "string" && entry.replace(/^\.\//, "") === DESKTOP_APP_CONFIG_FILE;
}

/**
 * The new `compile.include` for `want` (present or absent), or `undefined` when it is already
 * right. Existing entries are kept in order; a non-array value is an error (never clobbered).
 */
function nextInclude(include: unknown, want: boolean): unknown[] | undefined {
  if (include !== undefined && !Array.isArray(include)) {
    throw new Error("deno.json `compile.include` must be an array");
  }
  const list = (include ?? []) as unknown[];
  const has = list.some(sameInclude);
  if (want === has) return undefined;
  return want ? [...list, DESKTOP_APP_CONFIG_FILE] : list.filter((e) => !sameInclude(e));
}

/** Add (or remove) `.deno-desktop/app.json` in deno.json's `compile.include`, preserving the rest. */
async function syncInclude(root: string, want: boolean): Promise<DesktopAppSyncReport["include"]> {
  const path = await findDenoJson(root);
  if (!path) return "no-deno-json";
  const { readJson, setJsonValue, deleteJsonValue } = await import("./json-edit.ts");
  const source = await Deno.readTextFile(path);
  const compile = (readJson(source) as { compile?: Record<string, unknown> } | null)?.compile;
  const next = nextInclude(compile?.include, want);
  if (next === undefined) return "unchanged";
  const onlyInclude = compile !== undefined && Object.keys(compile).length === 1;
  const edited = next.length > 0
    ? await setJsonValue(source, ["compile", "include"], next)
    : await deleteJsonValue(source, onlyInclude ? ["compile"] : ["compile", "include"]);
  await writeJsonEdit(path, edited);
  return "updated";
}

/** Write an edited deno.json back, refusing a failed edit or a symlinked file. */
async function writeJsonEdit(
  path: string,
  edited: { ok: true; source: string } | { ok: false; reason: string },
): Promise<void> {
  if (!edited.ok) throw new Error(`cannot edit ${path}: ${edited.reason}`);
  if (await isSymlink(path)) throw new Error(`refusing to write through the symlink ${path}`);
  await Deno.writeTextFile(path, edited.source);
}

/**
 * The body of `.deno-desktop/app.json`, or `null` when there is nothing for the runtime to read:
 * the origin + identifier (when an origin is set), the deep-link schemes (the runtime's list for
 * launch arguments, `openurl` and scheme registration) and `singleInstance` (the intent; the lock
 * itself is `laufey-launch.json`'s). The identifier rides along whenever it is valid, since the
 * runtime needs it to register schemes on Linux and next to `singleInstance`.
 */
function appJsonBody(config: unknown): Record<string, unknown> | null {
  const identity = desktopAppIdentity(config);
  const app = appBlock(config);
  const deepLinks = normalizeDesktopDeepLinks(app?.deepLinks);
  const single = typeof app?.singleInstance === "boolean" ? app.singleInstance : undefined;
  if (!identity && deepLinks.length === 0 && single === undefined) return null;
  const id = identity?.identifier ?? app?.identifier;
  const identifier = typeof id === "string" && desktopAppIdentifierError(id) === null
    ? id
    : undefined;
  return {
    ...(identity ? { origin: identity.origin } : {}),
    ...(identifier ? { identifier } : {}),
    ...(deepLinks.length > 0 ? { deepLinks } : {}),
    ...(single !== undefined && identifier ? { singleInstance: single } : {}),
  };
}

/** Write (or remove) `.deno-desktop/app.json`, never through a symlink. */
async function syncAppJson(
  root: string,
  body: Record<string, unknown> | null,
): Promise<DesktopAppSyncReport["appJson"]> {
  const dir = join(root, ".deno-desktop");
  const path = join(root, DESKTOP_APP_CONFIG_FILE);
  if ((await isSymlink(dir)) || (await isSymlink(path))) {
    throw new Error(`refusing to write through a symlink at ${path}`);
  }
  const existing = await Deno.readTextFile(path).catch(() => undefined);
  if (!body) {
    if (existing === undefined) return "none";
    await Deno.remove(path);
    return "removed";
  }
  const content = JSON.stringify(body, null, 2) + "\n";
  if (existing === content) return "unchanged";
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
  return "written";
}

/**
 * Mirror `desktop.app.deepLinks` into deno.json's `desktop.app.deepLinks`: the key the `deno
 * desktop` CLI (the stock one included) reads to register the schemes with the OS when it packages
 * (Info.plist `CFBundleURLTypes`, the Windows registry, the Linux `.desktop` entry). Nothing to do
 * without configured schemes (a hand-written deno.json value is left alone).
 */
async function syncDenoJsonDeepLinks(
  root: string,
  deepLinks: readonly string[],
): Promise<NonNullable<DesktopAppSyncReport["deepLinks"]>> {
  const path = await findDenoJson(root);
  if (!path) return "no-deno-json";
  const { readJson, setJsonValue } = await import("./json-edit.ts");
  const source = await Deno.readTextFile(path);
  const current = (readJson(source) as { desktop?: { app?: { deepLinks?: unknown } } } | null)
    ?.desktop?.app?.deepLinks;
  if (JSON.stringify(current) === JSON.stringify(deepLinks)) return "unchanged";
  await writeJsonEdit(
    path,
    await setJsonValue(source, ["desktop", "app", "deepLinks"], [...deepLinks]),
  );
  return "updated";
}

/**
 * Bring the project's `.deno-desktop/app.json` and deno.json in line with `desktop.app` in
 * `config`: with an origin, deep-link schemes or `singleInstance`, write `app.json` (origin +
 * identifier, `deepLinks`, `singleInstance`) and make sure `compile.include` lists the file
 * (appending to existing entries, idempotent); with none, remove a previous `app.json` and its
 * include entry so the runtime does not keep a stale origin. Configured deep-link schemes are also
 * written to deno.json `desktop.app.deepLinks`, where `deno desktop` registers them with the OS.
 * Throws on an invalid origin/identifier/scheme (the runtime's rules).
 *
 * @param root The project root.
 * @param config The project config.
 * @returns What changed (`deepLinks` only when schemes are configured).
 */
export async function syncDesktopAppConfigAt(
  root: string,
  config: unknown,
): Promise<DesktopAppSyncReport> {
  const body = appJsonBody(config);
  const appJson = await syncAppJson(root, body);
  const include = await syncInclude(root, body !== null);
  if (body && include === "no-deno-json") {
    console.warn(
      `  no deno.json in ${root}: add "compile": { "include": ["${DESKTOP_APP_CONFIG_FILE}"] } ` +
        "so deno desktop embeds the app origin.",
    );
  }
  const schemes = (body?.deepLinks as string[] | undefined) ?? [];
  if (schemes.length === 0) return { appJson, include };
  return { appJson, include, deepLinks: await syncDenoJsonDeepLinks(root, schemes) };
}

/**
 * {@linkcode syncDesktopAppConfigAt} for the project that owns `entryUrl` (a script in its
 * `scripts/` folder): what the scaffolded `scripts/package-*.ts` call before `deno desktop`.
 *
 * @param entryUrl `import.meta.url` of a script in the project's `scripts/` folder.
 * @returns What changed.
 */
export async function syncDesktopAppConfig(entryUrl: string): Promise<DesktopAppSyncReport> {
  const root = fromFileUrl(new URL("..", entryUrl));
  return await syncDesktopAppConfigAt(root, await loadConfigBeside(entryUrl));
}
