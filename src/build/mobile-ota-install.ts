// `denext mobile add-ota [dir]`: retrofit denext's over-the-air UI updates into an existing
// Capacitor project. It writes the native templates (src/build/ota-native-templates.ts),
// adds the Swift files to the Xcode app target (src/build/pbxproj.ts), points the storyboard
// and SceneDelegate at `DenextBridgeViewController` while they still name the stock
// `CAPBridgeViewController`, and rewrites a stock `MainActivity`. With a public key it also
// embeds the OTA signature key (Info.plist `DenextOtaPublicKey`, AndroidManifest meta-data
// `dev.denext.ota.PUBLIC_KEY`), replacing an earlier one; with origins it pins them
// (`DenextOtaOrigins`, `dev.denext.ota.ORIGINS`), the only servers the app then takes a UI from. A template file that is an unedited
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
import { OTA_PRIVACY, writePrivacyManifests } from "./mobile-privacy.ts";
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
  /**
   * The origins the app may take a UI from (from {@linkcode parseOtaOrigins}). Pinned in
   * Info.plist (`DenextOtaOrigins`) and AndroidManifest.xml (`dev.denext.ota.ORIGINS`), replacing
   * earlier ones; the native store then refuses every other `baseUrl`. Without a public key it is
   * the only way an unsigned UI is accepted from anywhere but loopback. Left out, neither file is
   * touched.
   */
  origins?: readonly string[];
  /** Plan only: fill the report with what would be written, and change no file. */
  dryRun?: boolean;
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
  /**
   * Of {@linkcode unsignedPlatforms}, those that pin no OTA origin either: they accept an
   * update from loopback only.
   */
  unpinnedPlatforms: string[];
}

/** The Android package the templates use (kept apart from the app's own package). */
const ANDROID_OTA_DIR = "android/app/src/main/java/dev/denext/ota";

type Installer = NativeInstaller<AddOtaOptions, AddOtaReport>;

/** The Info.plist key the iOS plugin reads its OTA public key from. */
const IOS_PUBLIC_KEY_KEY = "DenextOtaPublicKey";
/** The `<meta-data>` name the Android plugin reads its OTA public key from. */
const ANDROID_PUBLIC_KEY_META = "dev.denext.ota.PUBLIC_KEY";

/** The Info.plist key the iOS plugin reads its pinned OTA origins from. */
const IOS_ORIGINS_KEY = "DenextOtaOrigins";
/** The `<meta-data>` name the Android plugin reads its pinned OTA origins from. */
const ANDROID_ORIGINS_META = "dev.denext.ota.ORIGINS";

/**
 * Normalise `--ota-origin` values (repeatable, or comma-separated) to origins: `https://host[:port]`,
 * or plain `http` to a loopback host (a dev server on the device). A path, credentials or any other
 * scheme is an error — an unsigned UI pinned to a plain-http origin could be swapped on the network.
 *
 * @param values The flag values.
 * @returns The origins, deduplicated, in order.
 * @throws Error naming the first value that is not such an origin.
 */
export function parseOtaOrigins(values: readonly string[]): string[] {
  const origins: string[] = [];
  for (const raw of values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`--ota-origin ${raw}: not a URL`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error(`--ota-origin ${raw}: must be https (plain http only to loopback)`);
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`--ota-origin ${raw}: an origin only (scheme, host and port), no path`);
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

/** Whether `plist`'s top-level dict carries a non-empty `DenextOtaOrigins` string. */
function plistHasOrigins(plist: string): boolean {
  const top = plistTopDict(plist);
  const entry = top && plistEntry(plist, top, IOS_ORIGINS_KEY);
  return (entry?.value?.value.trim() ?? "") !== "";
}

/** Whether `manifest` pins OTA origins in its `<meta-data>`. */
function manifestHasOrigins(manifest: string): boolean {
  return (manifestMetaDataValue(manifest, ANDROID_ORIGINS_META) ?? "").trim() !== "";
}

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
    const text = await inst.read(path);
    const next = text === undefined ? null : keyFile.inject(text, key);
    if (next === null) {
      inst.report.keyNotEmbedded.push(inst.rel(path));
      inst.report.manual.push(`${inst.rel(path)}: ${step}`);
    } else {
      await inst.edit(path, () => next);
    }
  }
  const final = await inst.read(path);
  if (final === undefined || !keyFile.has(final)) inst.report.unsignedPlatforms.push(platform);
}

/**
 * Pin `inst.opts.origins` with `inject` (a manual step when the file has no place for them), then
 * record `platform` as unpinned when it is unsigned and the file pins nothing (`has`).
 */
async function pinOrigins(
  inst: Installer,
  path: string,
  platform: string,
  originsFile: {
    inject: (text: string, value: string) => string | null;
    has: (text: string) => boolean;
  },
  step: string,
): Promise<void> {
  const origins = inst.opts.origins;
  if (origins !== undefined && origins.length > 0) {
    const text = await inst.read(path);
    const next = text === undefined ? null : originsFile.inject(text, origins.join(" "));
    if (next === null) inst.report.manual.push(`${inst.rel(path)}: ${step}`);
    else await inst.edit(path, () => next);
  }
  const final = await inst.read(path);
  const pinned = final !== undefined && originsFile.has(final);
  if (inst.report.unsignedPlatforms.includes(platform) && !pinned) {
    inst.report.unpinnedPlatforms.push(platform);
  }
}

/** Where the report's `kept` and `upgraded` lists stood before one platform's files were written. */
interface ReportMark {
  kept: number;
  upgraded: number;
}

function markReport(inst: Installer): ReportMark {
  return { kept: inst.report.kept.length, upgraded: inst.report.upgraded.length };
}

/**
 * One platform's OTA files call into each other, and a template generation can add such calls
 * (generation 9: the bridge's `DenextOtaRouter`, the store's `verifyInstalled`, Android's
 * `routes()` / `attach`). So when an edited file is kept while the others are upgraded, the app
 * will not compile: say so, next to the kept file's own manual step.
 */
function notePartialUpgrade(inst: Installer, platform: string, since: ReportMark): void {
  const kept = inst.report.kept.slice(since.kept);
  const upgraded = inst.report.upgraded.slice(since.upgraded);
  if (kept.length === 0 || upgraded.length === 0) return;
  inst.report.manual.push(
    `${platform}: ${kept.join(", ")} kept while ${upgraded.join(", ")} ` +
      `${upgraded.length === 1 ? "was" : "were"} upgraded. The OTA files of one template ` +
      "generation call into each other, so the app will not compile until each kept file is " +
      "merged with denext's template by hand, or replaced (re-run with --force, then re-apply " +
      "your edits).",
  );
}

async function installIos(inst: Installer): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const root = inst.opts.dir;
  const mark = markReport(inst);
  await installBridgeViewController(inst, "ota", {
    needle: "DenextOtaPlugin()",
    step: "make capacitorDidLoad() register the OTA plugin as denext's template does " +
      "(re-run with --force to replace the file).",
  });
  const { [BRIDGE_VC_FILE]: _bridge, ...plugin } = OTA_IOS_FILES;
  await writeTemplates(inst, join(root, IOS_APP), plugin, OTA_TEMPLATES);
  notePartialUpgrade(inst, "iOS", mark);
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
  await pinOrigins(
    inst,
    join(root, IOS_APP, "Info.plist"),
    "iOS",
    {
      inject: (plist, value) => withPlistString(plist, IOS_ORIGINS_KEY, value, true),
      has: plistHasOrigins,
    },
    `add the string key ${IOS_ORIGINS_KEY} (the space-separated origins) to the top-level dict.`,
  );
}

async function installAndroid(inst: Installer): Promise<void> {
  if (!(await hasAndroidApp(inst))) return;
  const root = inst.opts.dir;
  const mark = markReport(inst);
  await writeTemplates(inst, join(root, ANDROID_OTA_DIR), OTA_ANDROID_FILES, OTA_TEMPLATES);
  notePartialUpgrade(inst, "Android", mark);
  await registerInMainActivity(inst, "ota");
  await embedPublicKey(
    inst,
    join(root, "android", "app", "src", "main", "AndroidManifest.xml"),
    "Android",
    { inject: withManifestPublicKey, has: manifestHasPublicKey },
    `add <meta-data android:name="${ANDROID_PUBLIC_KEY_META}" android:value="<base64 public key>" /> inside <application>.`,
  );
  await pinOrigins(
    inst,
    join(root, "android", "app", "src", "main", "AndroidManifest.xml"),
    "Android",
    {
      inject: (manifest, value) => withManifestMetaData(manifest, ANDROID_ORIGINS_META, value),
      has: manifestHasOrigins,
    },
    `add <meta-data android:name="${ANDROID_ORIGINS_META}" android:value="<origins>" /> inside <application>.`,
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
    unpinnedPlatforms: [],
    unchanged: [],
    manual: [],
    skipped: [],
  }, opts.dryRun === true);
  await installIos(inst);
  await installAndroid(inst);
  // DenextOtaStore keeps its state in UserDefaults: declare it (CA92.1) in PrivacyInfo.xcprivacy.
  const privacy = await writePrivacyManifests(opts.dir, OTA_PRIVACY, {
    dryRun: opts.dryRun === true,
    randomId: opts.randomId,
  });
  for (const path of privacy.written) {
    if (!inst.report.written.includes(path)) inst.report.written.push(path);
  }
  for (const path of privacy.unchanged) {
    if (!inst.report.written.includes(path)) inst.report.unchanged.push(path);
  }
  inst.report.manual.push(...privacy.manual);
  return inst.report;
}
