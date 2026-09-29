// The native-source edits behind `denext mobile build`: a flavor's app id, name and server URL,
// a build-number / version override, and `--bump`. Flavor and override edits are temporary: a
// {@linkcode NativeSnapshot} records every file before its first change and puts the bytes back
// when the build ends, and keeps an on-disk copy (.denext/mobile-build/backup) so a killed build
// is restored by the next one or by `denext mobile build --restore`. `--bump` is the one
// permanent edit (the next build number is meant to be committed).
//
// All edits are text edits of the Capacitor 8 template shapes (project.pbxproj, Info.plist,
// build.gradle, strings.xml, capacitor.config.*); a shape they do not recognise is reported,
// never guessed at.

import { dirname, join, relative } from "@std/path";
import { posixRelative } from "./mobile-paths.ts";
import type { MobileConfig, MobileFlavorConfig } from "../server/config.ts";
import {
  capacitorConfigFile,
  readCapacitorConfig,
  withCapacitorConfigValue,
} from "./capacitor-config.ts";

/** A platform `denext mobile build` targets. */
export type MobilePlatform = "ios" | "android";

/** A flavor picked with `--flavor`, with its name. */
export interface ResolvedFlavor {
  readonly name: string;
  readonly config: MobileFlavorConfig;
}

/**
 * Look up `--flavor <name>` in the config's `mobile.flavors`.
 *
 * @param mobile The config's `mobile` block.
 * @param name The flavor name.
 * @throws {Error} Naming the flavors that exist when `name` is not one of them.
 */
export function resolveFlavor(mobile: MobileConfig | undefined, name: string): ResolvedFlavor {
  const flavors = mobile?.flavors ?? {};
  const config = Object.hasOwn(flavors, name) ? flavors[name] : undefined;
  if (!config) {
    const known = Object.keys(flavors);
    throw new Error(
      `no flavor "${name}" in denext.config's mobile.flavors (${
        known.length ? `declared: ${known.join(", ")}` : "none declared"
      })`,
    );
  }
  return { name, config };
}

/** The flavor's app id: `appId`, else the base id plus `appIdSuffix`, else the base id. */
export function flavorAppId(baseId: string, flavor: MobileFlavorConfig | undefined): string {
  return flavor?.appId ?? (flavor?.appIdSuffix ? baseId + flavor.appIdSuffix : baseId);
}

const BACKUP_DIR = ".denext/mobile-build/backup";
const BACKUP_INDEX = "index.json";

/**
 * Files changed for one build, restorable byte for byte. `save` before the first write to a
 * file; `restore` puts every file back (a file that did not exist is removed).
 */
export class NativeSnapshot {
  #saved = new Map<string, Uint8Array | null>();
  constructor(readonly root: string) {}

  /** The files saved so far, relative to the project. */
  get files(): string[] {
    return [...this.#saved.keys()].map((p) => posixRelative(this.root, p));
  }

  /** Record `path`'s current bytes (once), in memory and in the on-disk backup. */
  async save(path: string): Promise<void> {
    if (this.#saved.has(path)) return;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await Deno.readFile(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    this.#saved.set(path, bytes);
    const rel = relative(this.root, path);
    const dir = join(this.root, BACKUP_DIR);
    if (bytes) {
      await Deno.mkdir(dirname(join(dir, "files", rel)), { recursive: true });
      await Deno.writeFile(join(dir, "files", rel), bytes);
    }
    const index = Object.fromEntries(
      [...this.#saved].map(([p, b]) => [posixRelative(this.root, p), b !== null]),
    );
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, BACKUP_INDEX), JSON.stringify(index, null, 2));
  }

  /** Put every saved file back and drop the on-disk backup. */
  async restore(): Promise<void> {
    for (const [path, bytes] of this.#saved) {
      if (bytes) await Deno.writeFile(path, bytes);
      else await Deno.remove(path).catch(() => {});
    }
    this.#saved.clear();
    await Deno.remove(join(this.root, BACKUP_DIR), { recursive: true }).catch(() => {});
  }
}

/**
 * Restore what an interrupted build left (the on-disk backup), if anything.
 *
 * @param root The Capacitor project.
 * @returns The files put back, relative to the project.
 */
export async function restoreInterruptedBuild(root: string): Promise<string[]> {
  const dir = join(root, BACKUP_DIR);
  let index: Record<string, boolean>;
  try {
    index = JSON.parse(await Deno.readTextFile(join(dir, BACKUP_INDEX)));
  } catch {
    return [];
  }
  const restored: string[] = [];
  for (const [rel, existed] of Object.entries(index)) {
    if (rel.startsWith("..")) continue;
    const target = join(root, rel);
    if (existed) await Deno.writeFile(target, await Deno.readFile(join(dir, "files", rel)));
    else await Deno.remove(target).catch(() => {});
    restored.push(rel);
  }
  await Deno.remove(dir, { recursive: true });
  return restored;
}

/** Where the native projects keep what the edits touch. */
export const NATIVE_FILES = {
  pbxproj: "ios/App/App.xcodeproj/project.pbxproj",
  infoPlist: "ios/App/App/Info.plist",
  gradle: "android/app/build.gradle",
  strings: "android/app/src/main/res/values/strings.xml",
} as const;

/** `text` with XML's five special characters escaped. */
function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** A regex-safe copy of `text`. */
function reEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pbxproj with every PRODUCT_BUNDLE_IDENTIFIER that is `from` or starts with `from.` (the
 * app extensions) rebased onto `to`.
 */
export function rebaseBundleIds(pbxproj: string, from: string, to: string): string {
  const re = new RegExp(
    `(PRODUCT_BUNDLE_IDENTIFIER = "?)${reEscape(from)}((?:\\.[^";\\s]+)?"?;)`,
    "g",
  );
  return pbxproj.replace(re, (_m, head, tail) => `${head}${to}${tail}`);
}

/** Info.plist with CFBundleDisplayName set to `name` (added after CFBundleDevelopmentRegion's dict entry when absent). */
export function withDisplayName(plist: string, name: string): string {
  const value = `<string>${xmlEscape(name)}</string>`;
  const re = /(<key>CFBundleDisplayName<\/key>\s*)<string>[^<]*<\/string>/;
  if (re.test(plist)) return plist.replace(re, `$1${value}`);
  return plist.replace(/<dict>/, `<dict>\n\t<key>CFBundleDisplayName</key>\n\t${value}`);
}

/** build.gradle with `applicationId` set to `id`. */
function withApplicationId(gradle: string, id: string): string {
  return gradle.replace(/(\bapplicationId\s*=?\s*)["'][^"']*["']/, `$1"${id}"`);
}

/** strings.xml with app_name and title_activity_main set to `name`. */
export function withAppName(strings: string, name: string): string {
  return strings.replace(
    /(<string name="(?:app_name|title_activity_main)">)[^<]*(<\/string>)/g,
    `$1${xmlEscape(name)}$2`,
  );
}

/** The iOS build number (CURRENT_PROJECT_VERSION) and version (MARKETING_VERSION), if found. */
export function iosVersions(pbxproj: string): { build?: number; version?: string } {
  const build = /CURRENT_PROJECT_VERSION = "?(\d+)"?;/.exec(pbxproj)?.[1];
  const version = /MARKETING_VERSION = "?([^";\s]+)"?;/.exec(pbxproj)?.[1];
  return { build: build ? Number(build) : undefined, version };
}

/** The Android versionCode and versionName in build.gradle, if they are literals. */
export function androidVersions(gradle: string): { build?: number; version?: string } {
  const build = /\bversionCode\s*=?\s*(\d+)/.exec(gradle)?.[1];
  const version = /\bversionName\s*=?\s*["']([^"']*)["']/.exec(gradle)?.[1];
  return { build: build ? Number(build) : undefined, version };
}

/** pbxproj with every CURRENT_PROJECT_VERSION set to `build`. */
function withIosBuildNumber(pbxproj: string, build: number): string {
  return pbxproj.replace(/(CURRENT_PROJECT_VERSION = )"?\d+"?;/g, `$1${build};`);
}

/** build.gradle with versionCode / versionName replaced (each only when given). */
function withAndroidVersions(gradle: string, build?: number, version?: string): string {
  let out = gradle;
  if (build !== undefined) out = out.replace(/(\bversionCode\s*=?\s*)\d+/, `$1${build}`);
  if (version !== undefined) {
    out = out.replace(/(\bversionName\s*=?\s*)["'][^"']*["']/, `$1"${version.replace(/"/g, "")}"`);
  }
  return out;
}

/** The app's base id and name, from capacitor.config.*. */
export async function capacitorIdentity(
  root: string,
): Promise<{ file: string; appId?: string; appName?: string; webDir?: string }> {
  const file = await capacitorConfigFile(root);
  if (!file) throw new Error(`no capacitor.config.* in ${root}`);
  const config = await readCapacitorConfig(file, await Deno.readTextFile(file)) ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    file,
    appId: str(config.appId),
    appName: str(config.appName),
    webDir: str(config.webDir),
  };
}

/** Read, transform and (when changed) write one file, saving it first. */
async function editFile(
  snapshot: NativeSnapshot,
  path: string,
  edit: (text: string) => string,
): Promise<boolean> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return false;
  }
  const next = edit(text);
  if (next === text) return false;
  await snapshot.save(path);
  await Deno.writeTextFile(path, next);
  return true;
}

/** What {@linkcode applyFlavor} changed, and what it could not. */
export interface FlavorEdits {
  /** The app id the build carries. */
  readonly appId: string;
  /** Lines describing each change. */
  readonly changes: string[];
  /** What could not be applied (a shape not recognised). */
  readonly notes: string[];
}

/** Set one Capacitor config key, saving the file first. */
async function setCapacitorValue(
  snapshot: NativeSnapshot,
  file: string,
  path: string[],
  value: unknown,
): Promise<void> {
  await snapshot.save(file);
  const source = await Deno.readTextFile(file);
  await Deno.writeTextFile(file, await withCapacitorConfigValue(file, source, path, value));
}

/**
 * Apply a flavor's app id, name and server URL to the Capacitor config and `platform`'s native
 * project, saving every file first (the caller restores the snapshot when the build ends).
 *
 * @param root The Capacitor project.
 * @param platform The platform being built.
 * @param flavor The flavor settings.
 * @param snapshot Records each file before its first change.
 */
export async function applyFlavor(
  root: string,
  platform: MobilePlatform,
  flavor: MobileFlavorConfig,
  snapshot: NativeSnapshot,
): Promise<FlavorEdits> {
  const identity = await capacitorIdentity(root);
  const baseId = identity.appId;
  if (!baseId) {
    throw new Error(`${identity.file} has no literal appId to derive the flavor's id from`);
  }
  const appId = flavorAppId(baseId, flavor);
  const changes: string[] = [];
  const notes: string[] = [];
  if (appId !== baseId) {
    await setCapacitorValue(snapshot, identity.file, ["appId"], appId);
    changes.push(`app id ${baseId} → ${appId}`);
  }
  if (flavor.appName) {
    await setCapacitorValue(snapshot, identity.file, ["appName"], flavor.appName);
    changes.push(`app name → ${flavor.appName}`);
  }
  if (flavor.serverUrl) {
    await setCapacitorValue(snapshot, identity.file, ["server", "url"], flavor.serverUrl);
    changes.push(`server.url → ${flavor.serverUrl}`);
  }
  const at = (rel: string) => join(root, rel);
  const native = platform === "ios"
    ? [
      {
        rel: NATIVE_FILES.pbxproj,
        when: appId !== baseId,
        edit: (t: string) => rebaseBundleIds(t, baseId, appId),
        what: "PRODUCT_BUNDLE_IDENTIFIER",
      },
      {
        rel: NATIVE_FILES.infoPlist,
        when: Boolean(flavor.appName),
        edit: (t: string) => withDisplayName(t, flavor.appName!),
        what: "CFBundleDisplayName",
      },
    ]
    : [
      {
        rel: NATIVE_FILES.gradle,
        when: appId !== baseId,
        edit: (t: string) => withApplicationId(t, appId),
        what: "applicationId",
      },
      {
        rel: NATIVE_FILES.strings,
        when: Boolean(flavor.appName),
        edit: (t: string) => withAppName(t, flavor.appName!),
        what: "app_name",
      },
    ];
  for (const step of native) {
    if (!step.when) continue;
    if (await editFile(snapshot, at(step.rel), step.edit)) {
      changes.push(`${step.rel}: ${step.what}`);
    } else notes.push(`${step.rel}: ${step.what} not found (set it by hand for this flavor)`);
  }
  return { appId, changes, notes };
}

/**
 * Set the build number (and version, when given) of `platform`'s project, saving each file
 * first. iOS takes both on the xcodebuild command line instead, so only Android is edited.
 *
 * @returns What changed.
 */
export async function applyAndroidVersions(
  root: string,
  build: number | undefined,
  version: string | undefined,
  snapshot: NativeSnapshot | null,
): Promise<string[]> {
  if (build === undefined && version === undefined) return [];
  const path = join(root, NATIVE_FILES.gradle);
  const text = await Deno.readTextFile(path);
  const next = withAndroidVersions(text, build, version);
  if (next === text) {
    throw new Error(`${NATIVE_FILES.gradle}: no literal versionCode / versionName to set`);
  }
  if (snapshot) await snapshot.save(path);
  await Deno.writeTextFile(path, next);
  return [
    ...(build === undefined ? [] : [`versionCode → ${build}`]),
    ...(version === undefined ? [] : [`versionName → ${version}`]),
  ];
}

/**
 * `--bump`: the platform's build number plus one, written to the sources (not restored).
 *
 * @returns The old and new build numbers.
 * @throws {Error} When the build number is not a literal the template shape carries.
 */
export async function bumpBuildNumber(
  root: string,
  platform: MobilePlatform,
): Promise<{ from: number; to: number; file: string }> {
  const file = platform === "ios" ? NATIVE_FILES.pbxproj : NATIVE_FILES.gradle;
  const path = join(root, file);
  const text = await Deno.readTextFile(path);
  const from = (platform === "ios" ? iosVersions(text) : androidVersions(text)).build;
  if (from === undefined) throw new Error(`${file}: no build number to bump`);
  const to = from + 1;
  await Deno.writeTextFile(
    path,
    platform === "ios" ? withIosBuildNumber(text, to) : withAndroidVersions(text, to),
  );
  return { from, to, file };
}
