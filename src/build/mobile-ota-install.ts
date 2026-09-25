// `denext mobile add-ota [dir]`: retrofit denext's over-the-air UI updates into an existing
// Capacitor project. It writes the native templates (src/build/ota-native-templates.ts),
// adds the Swift files to the Xcode app target (src/build/pbxproj.ts), points the storyboard
// and SceneDelegate at `DenextBridgeViewController` while they still name the stock
// `CAPBridgeViewController`, and rewrites a stock `MainActivity`. With a public key it also
// embeds the OTA signature key (Info.plist `DenextOtaPublicKey`, AndroidManifest meta-data
// `dev.denext.ota.PUBLIC_KEY`), replacing an earlier one. A template file that is an unedited
// denext template of any earlier release (its marker line, or a known shipped hash) is upgraded
// in place; anything customised is left alone and reported as a one-line manual step. Running
// it twice changes nothing.

import { join } from "@std/path";
import { addSourceFiles } from "./pbxproj.ts";
import {
  manifestMetaDataValue,
  plistEntry,
  plistTopDict,
  withManifestMetaData,
  withPlistString,
} from "./mobile-native-config.ts";
import { OTA_ANDROID_FILES, OTA_IOS_FILES } from "./ota-native-templates.ts";
import {
  BRIDGE_VC_FILE,
  hasAndroidApp,
  hasIosApp,
  installBridgeViewController,
  IOS_APP,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  OTA_TEMPLATES,
  PBXPROJ,
  readText,
  registerInMainActivity,
  wireBridgeViewController,
  writeTemplates,
} from "./mobile-native-install.ts";

/** Options for {@linkcode addOtaToProject}. */
export interface AddOtaOptions extends NativeInstallOptions {
  /**
   * The OTA signature public key as one-line base64 SPKI (already validated, e.g. by
   * `parseOtaPublicKey`). Embedded in Info.plist and AndroidManifest.xml, replacing an
   * earlier value; left out, neither file is touched.
   */
  publicKey?: string;
}

/** What {@linkcode addOtaToProject} did, as project-relative paths and one-line notes. */
export interface AddOtaReport extends NativeInstallReport {
  /** Files `publicKey` could not be embedded in (a `manual` step says how). */
  keyNotEmbedded: string[];
  /**
   * Platforms installed (`"iOS"`, `"Android"`) whose Info.plist / AndroidManifest.xml carries no
   * OTA public key after the run: they accept unsigned updates over https or loopback only.
   */
  unsignedPlatforms: string[];
}

/** The Android package the templates use (kept apart from the app's own package). */
const ANDROID_OTA_DIR = "android/app/src/main/java/dev/denext/ota";

type Installer = NativeInstaller<AddOtaOptions, AddOtaReport>;

/** The Info.plist key the iOS plugin reads its OTA public key from. */
const IOS_PUBLIC_KEY_KEY = "DenextOtaPublicKey";
/** The `<meta-data>` name the Android plugin reads its OTA public key from. */
const ANDROID_PUBLIC_KEY_META = "dev.denext.ota.PUBLIC_KEY";

/** Whether `plist`'s top-level dict carries a non-empty `DenextOtaPublicKey` string. */
function plistHasPublicKey(plist: string): boolean {
  const top = plistTopDict(plist);
  const entry = top && plistEntry(plist, top, IOS_PUBLIC_KEY_KEY);
  return (entry?.value?.value.trim() ?? "") !== "";
}

/**
 * `plist` with the top-level `DenextOtaPublicKey` set to `key`, or null when it has no top-level
 * dict (or the key holds something other than a string).
 */
function withPlistPublicKey(plist: string, key: string): string | null {
  return withPlistString(plist, IOS_PUBLIC_KEY_KEY, key, true);
}

/** Whether `manifest` carries the public-key `<meta-data>` with a non-empty value. */
function manifestHasPublicKey(manifest: string): boolean {
  return /^[^"\s]+$/.test(manifestMetaDataValue(manifest, ANDROID_PUBLIC_KEY_META) ?? "");
}

/** `manifest` with the public-key `<meta-data>` set to `key`, or null without `</application>`. */
function withManifestPublicKey(manifest: string, key: string): string | null {
  return withManifestMetaData(manifest, ANDROID_PUBLIC_KEY_META, key);
}

/**
 * Embed `key` with `inject`, or report `step` as manual when the file has no place for it; then
 * record `platform` as unsigned when the file ends up without a key (`has`).
 */
async function embedPublicKey(
  inst: Installer,
  path: string,
  platform: string,
  keyFile: { inject: (text: string, key: string) => string | null; has: (text: string) => boolean },
  step: string,
): Promise<void> {
  const key = inst.opts.publicKey;
  if (key !== undefined) {
    const text = await readText(path);
    const next = text === undefined ? null : keyFile.inject(text, key);
    if (next === null) {
      inst.report.keyNotEmbedded.push(inst.rel(path));
      inst.report.manual.push(`${inst.rel(path)}: ${step}`);
    } else {
      await inst.edit(path, () => next);
    }
  }
  const final = await readText(path);
  if (final === undefined || !keyFile.has(final)) inst.report.unsignedPlatforms.push(platform);
}

async function installIos(inst: Installer): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const root = inst.opts.dir;
  await installBridgeViewController(inst, "ota", {
    needle: "DenextOtaPlugin()",
    step: "make capacitorDidLoad() register the OTA plugin as denext's template does " +
      "(re-run with --force to replace the file).",
  });
  const { [BRIDGE_VC_FILE]: _bridge, ...plugin } = OTA_IOS_FILES;
  await writeTemplates(inst, join(root, IOS_APP), plugin, OTA_TEMPLATES);
  await inst.edit(
    join(root, PBXPROJ),
    (t) => addSourceFiles(t, Object.keys(OTA_IOS_FILES), { randomId: inst.opts.randomId }).text,
  );
  await wireBridgeViewController(inst);
  await embedPublicKey(
    inst,
    join(root, IOS_APP, "Info.plist"),
    "iOS",
    { inject: withPlistPublicKey, has: plistHasPublicKey },
    `add the string key ${IOS_PUBLIC_KEY_KEY} (the base64 public key) to the top-level dict.`,
  );
}

async function installAndroid(inst: Installer): Promise<void> {
  if (!(await hasAndroidApp(inst))) return;
  const root = inst.opts.dir;
  await writeTemplates(inst, join(root, ANDROID_OTA_DIR), OTA_ANDROID_FILES, OTA_TEMPLATES);
  await registerInMainActivity(inst, "ota");
  await embedPublicKey(
    inst,
    join(root, "android", "app", "src", "main", "AndroidManifest.xml"),
    "Android",
    { inject: withManifestPublicKey, has: manifestHasPublicKey },
    `add <meta-data android:name="${ANDROID_PUBLIC_KEY_META}" android:value="<base64 public key>" /> inside <application>.`,
  );
}

/**
 * Install denext's over-the-air UI updates into the Capacitor project at `opts.dir`: the
 * `DenextOta` plugin for iOS (three Swift files, added to the Xcode app target, with the
 * storyboard and SceneDelegate switched to `DenextBridgeViewController`) and for Android
 * (three Java files in `dev.denext.ota`, called from `MainActivity`). The bridge view controller
 * and `MainActivity` also keep registering any other denext native plugin already installed
 * (`denext mobile add auth-session`). Idempotent; an unedited
 * template from an earlier denext is upgraded (`upgraded`), and customised files are never
 * rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
export async function addOtaToProject(opts: AddOtaOptions): Promise<AddOtaReport> {
  const inst: Installer = new NativeInstaller(opts, {
    written: [],
    upgraded: [],
    kept: [],
    keyNotEmbedded: [],
    unsignedPlatforms: [],
    unchanged: [],
    manual: [],
    skipped: [],
  });
  await installIos(inst);
  await installAndroid(inst);
  return inst.report;
}
