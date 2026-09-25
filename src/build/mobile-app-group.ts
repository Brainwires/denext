// App Groups and extension targets for `denext mobile add share-extension | widget |
// live-activity`: the App Group every app extension shares with the app (its entitlement in the
// app's and each extension's entitlements file, and `DenextAppGroup` in each Info.plist, which
// the native templates read), and the Xcode target of an extension (Info.plist, entitlements,
// PBXNativeTarget, embedded in and depended on by the app). Everything is a text edit that
// leaves what it does not touch alone, and running it again changes nothing.

import { join } from "@std/path";
import {
  addEmbedPhase,
  addNativeTarget,
  addSourceFiles,
  addTargetBuildSetting,
  addTargetDependency,
  applicationTargetName,
  type BuildSettingValue,
  targetBuildSetting,
} from "./pbxproj.ts";
import {
  EMPTY_ENTITLEMENTS,
  plistEntry,
  plistTopDict,
  withPlistString,
  withPlistStringArray,
} from "./mobile-native-config.ts";
import { extensionInfoPlist } from "./app-extension-native-templates.ts";
import {
  IOS_APP,
  type NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  PBXPROJ,
  readText,
} from "./mobile-native-install.ts";

/** The entitlement that lists an app's App Groups. */
const APP_GROUP_ENTITLEMENT = "com.apple.security.application-groups";
/** The Info.plist key the native templates read the App Group from. */
const APP_GROUP_PLIST_KEY = "DenextAppGroup";
/** The app entitlements file written when the App target names none (relative to ios/App). */
const DEFAULT_APP_ENTITLEMENTS = "App/App.entitlements";

type Installer = NativeInstaller<NativeInstallOptions, NativeInstallReport>;

/**
 * `group`, checked: `group.` followed by a reverse-DNS identifier.
 *
 * @param group The `--app-group` value.
 * @returns The group.
 */
export function checkAppGroup(group: string): string {
  if (!/^group\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(group)) {
    throw new Error(
      `--app-group ${group}: an App Group is "group." then a reverse-DNS name, e.g. ` +
        "group.com.example.app.",
    );
  }
  return group;
}

/** The app target's bundle identifier (its Release configuration's, else any), if literal. */
function appBundleId(pbxproj: string): string | undefined {
  const ids = targetBuildSetting(
    pbxproj,
    applicationTargetName(pbxproj),
    "PRODUCT_BUNDLE_IDENTIFIER",
  );
  const id = ids.get("Release") ?? [...ids.values()].find((v) => v !== undefined);
  return id !== undefined && !id.includes("$(") ? id : undefined;
}

/**
 * The App Group to use: `flag` when given (checked), else `group.<the app's bundle id>`. Throws
 * when there is no flag and the bundle id is not a literal in the project.
 *
 * @param pbxproj The `project.pbxproj` contents.
 * @param flag The `--app-group` value.
 * @returns The App Group.
 */
export function resolveAppGroup(pbxproj: string, flag: string | undefined): string {
  if (flag !== undefined) return checkAppGroup(flag);
  const id = appBundleId(pbxproj);
  if (id === undefined) {
    throw new Error(
      "the App target's PRODUCT_BUNDLE_IDENTIFIER is not a literal, so there is no default App " +
        "Group: pass --app-group group.<your bundle id>.",
    );
  }
  return checkAppGroup(`group.${id}`);
}

/** `path` created from `initial` when absent (its folder must exist); whether it exists now. */
async function ensureFile(inst: Installer, path: string, initial: string): Promise<boolean> {
  if (await readText(path) !== undefined) return true;
  try {
    await Deno.writeTextFile(path, initial, { createNew: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }
  inst.report.written.push(inst.rel(path));
  return true;
}

/** Add `group` to the App Groups of the entitlements file at `path` (created when absent). */
async function addGroupEntitlement(inst: Installer, path: string, group: string): Promise<void> {
  if (!(await ensureFile(inst, path, EMPTY_ENTITLEMENTS))) {
    inst.report.manual.push(`${inst.rel(path)}: add ${APP_GROUP_ENTITLEMENT} = [${group}].`);
    return;
  }
  const text = (await readText(path))!;
  const next = withPlistStringArray(text, APP_GROUP_ENTITLEMENT, [group]);
  if (next === null) {
    inst.report.manual.push(`${inst.rel(path)}: add ${APP_GROUP_ENTITLEMENT} = [${group}].`);
    return;
  }
  await inst.edit(path, () => next);
}

/** Set Info.plist `DenextAppGroup` (and any `extra` string keys) in the plist at `path`. */
async function setPlistStrings(
  inst: Installer,
  path: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const text = await readText(path);
  if (text === undefined) {
    inst.report.manual.push(`${inst.rel(path)} is missing: set ${Object.keys(values).join(", ")}.`);
    return;
  }
  let next: string | null = text;
  for (const [key, value] of Object.entries(values)) {
    next = next === null ? null : withPlistString(next, key, xmlText(value), true);
  }
  if (next === null) {
    inst.report.manual.push(
      `${inst.rel(path)}: set the string keys ${Object.keys(values).join(", ")} by hand.`,
    );
    return;
  }
  await inst.edit(path, () => next);
}

/** Escape `&`, `<`, `>` for plist text. */
function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The app's entitlements files (its CODE_SIGN_ENTITLEMENTS, relative to ios/App). When the App
 * target names none, `App/App.entitlements`, which is then set on every configuration.
 */
async function appEntitlements(inst: Installer): Promise<string[]> {
  const pbxPath = join(inst.opts.dir, PBXPROJ);
  const pbxproj = (await readText(pbxPath))!;
  const target = applicationTargetName(pbxproj);
  const values = [
    ...new Set([
      ...targetBuildSetting(pbxproj, target, "CODE_SIGN_ENTITLEMENTS")
        .values(),
    ].filter((v): v is string => v !== undefined)),
  ];
  const unresolved = values.filter((v) => v.includes("$(") || v.startsWith("/"));
  for (const value of unresolved) {
    inst.report.manual.push(
      `the ${target} target signs with ${value}, which denext cannot resolve: add ` +
        `${APP_GROUP_ENTITLEMENT} to it.`,
    );
  }
  const files = values.filter((v) => !unresolved.includes(v));
  if (values.length > 0) return files;
  await inst.edit(
    pbxPath,
    (t) =>
      addTargetBuildSetting(t, target, "CODE_SIGN_ENTITLEMENTS", DEFAULT_APP_ENTITLEMENTS).text,
  );
  return [DEFAULT_APP_ENTITLEMENTS];
}

/**
 * The note printed once per run: the App Group must exist in the developer account, which
 * automatic signing usually takes care of.
 */
function portalNote(group: string, appId: string): string {
  return `App Group ${group} must exist in your Apple Developer account (Certificates, IDs & ` +
    `Profiles → Identifiers → App Groups) and be enabled on the app's App ID (${appId}) and on ` +
    `each extension's (${appId}.share, ${appId}.widgets). Xcode's automatic signing (Signing & Capabilities, or xcodebuild ` +
    "-allowProvisioningUpdates) usually registers the group and the extension App IDs for you; " +
    "a Personal Team cannot sign App Groups.";
}

/**
 * Give the app the App Group: its entitlements (the App target's CODE_SIGN_ENTITLEMENTS, set
 * to a new `App/App.entitlements` when it has none) list `group`, and its Info.plist carries
 * `DenextAppGroup`.
 *
 * @param inst The running installer.
 * @param group The App Group.
 */
export async function installAppGroup(inst: Installer, group: string): Promise<void> {
  for (const file of await appEntitlements(inst)) {
    await addGroupEntitlement(inst, join(inst.opts.dir, "ios", "App", file), group);
  }
  await setPlistStrings(inst, join(inst.opts.dir, IOS_APP, "Info.plist"), {
    [APP_GROUP_PLIST_KEY]: group,
  });
}

/** An app extension target to set up. */
export interface ExtensionTarget {
  /** The target name (and its folder under ios/App). */
  name: string;
  /** Appended to the app's bundle id: `<app id>.<suffix>`. */
  bundleSuffix: string;
  /** The Info.plist `NSExtension` dict's inner lines. */
  extensionAttributes: string;
  /** Extra Info.plist string keys (besides DenextAppGroup). */
  plist?: Readonly<Record<string, string>>;
  /** The lowest iOS the extension may target (raised to it when the app's is lower). */
  minimumIos?: string;
}

/** The App target's own settings an extension copies, per configuration. */
const COPIED_SETTINGS = [
  "CURRENT_PROJECT_VERSION",
  "DEVELOPMENT_TEAM",
  "IPHONEOS_DEPLOYMENT_TARGET",
  "MARKETING_VERSION",
  "SWIFT_VERSION",
  "TARGETED_DEVICE_FAMILY",
] as const;

/** `a` when it is a higher iOS version than `b`, else `b`. */
function laterIos(a: string, b: string): string {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? a : b;
  }
  return b;
}

/** The extension's build settings for `config`, from the app's. */
function extensionSettings(
  pbxproj: string,
  app: string,
  ext: ExtensionTarget,
): (config: string) => Record<string, BuildSettingValue> {
  const copied = new Map(
    COPIED_SETTINGS.map((key) => [key, targetBuildSetting(pbxproj, app, key)]),
  );
  const ids = targetBuildSetting(pbxproj, app, "PRODUCT_BUNDLE_IDENTIFIER");
  return (config) => {
    const own = (key: (typeof COPIED_SETTINGS)[number]) => copied.get(key)?.get(config);
    const appId = ids.get(config) ?? ids.get("Release") ?? "$(PRODUCT_BUNDLE_IDENTIFIER)";
    const ios = own("IPHONEOS_DEPLOYMENT_TARGET");
    const settings: Record<string, BuildSettingValue> = {
      APPLICATION_EXTENSION_API_ONLY: "YES",
      CODE_SIGN_ENTITLEMENTS: `${ext.name}/${ext.name}.entitlements`,
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: own("CURRENT_PROJECT_VERSION") ?? "1",
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: `${ext.name}/Info.plist`,
      LD_RUNPATH_SEARCH_PATHS: [
        "$(inherited)",
        "@executable_path/Frameworks",
        "@executable_path/../../Frameworks",
      ],
      MARKETING_VERSION: own("MARKETING_VERSION") ?? "1.0",
      PRODUCT_BUNDLE_IDENTIFIER: `${appId}.${ext.bundleSuffix}`,
      PRODUCT_NAME: "$(TARGET_NAME)",
      SKIP_INSTALL: "YES",
      SWIFT_EMIT_LOC_STRINGS: "YES",
      SWIFT_VERSION: own("SWIFT_VERSION") ?? "5.0",
      TARGETED_DEVICE_FAMILY: own("TARGETED_DEVICE_FAMILY") ?? "1,2",
    };
    if (ios !== undefined || ext.minimumIos !== undefined) {
      settings.IPHONEOS_DEPLOYMENT_TARGET = ext.minimumIos === undefined
        ? ios!
        : laterIos(ios ?? ext.minimumIos, ext.minimumIos);
    }
    const team = own("DEVELOPMENT_TEAM");
    if (team !== undefined) settings.DEVELOPMENT_TEAM = team;
    if (config === "Debug") settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG";
    return settings;
  };
}

/** The name the app shows (Info.plist CFBundleDisplayName, else CFBundleName), if literal. */
async function appDisplayName(root: string): Promise<string | undefined> {
  const plist = await readText(join(root, IOS_APP, "Info.plist"));
  const top = plist === undefined ? null : plistTopDict(plist);
  if (!plist || !top) return undefined;
  for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
    const value = plistEntry(plist, top, key)?.value?.value.trim();
    if (value && !value.includes("$(")) return value;
  }
  return undefined;
}

/**
 * Set up the Xcode target of an app extension: its folder's Info.plist (written once, then only
 * its DenextAppGroup and `plist` keys are set) and entitlements (with `group`), the
 * PBXNativeTarget with `sources` compiled, embedded in the app's PlugIns and built before it.
 * An existing target is kept as it is (only missing sources are added to it).
 *
 * @param inst The running installer.
 * @param ext The extension.
 * @param group The App Group.
 * @param sources Swift files in the extension's folder to compile into it.
 */
export async function installExtensionTarget(
  inst: Installer,
  ext: ExtensionTarget,
  group: string,
  sources: readonly string[],
): Promise<void> {
  const root = inst.opts.dir;
  const folder = join(root, "ios", "App", ext.name);
  await Deno.mkdir(folder, { recursive: true });
  const displayName = await appDisplayName(root) ?? ext.name;
  await ensureFile(
    inst,
    join(folder, "Info.plist"),
    extensionInfoPlist(displayName, ext.extensionAttributes),
  );
  await setPlistStrings(inst, join(folder, "Info.plist"), {
    [APP_GROUP_PLIST_KEY]: group,
    ...ext.plist,
  });
  await addGroupEntitlement(inst, join(folder, `${ext.name}.entitlements`), group);
  const randomId = inst.opts.randomId;
  await inst.edit(join(root, PBXPROJ), (text) => {
    const app = applicationTargetName(text);
    let t = addNativeTarget(text, {
      name: ext.name,
      productType: "com.apple.product-type.app-extension",
      productFileType: "wrapper.app-extension",
      productExtension: "appex",
      files: ["Info.plist", `${ext.name}.entitlements`],
      buildSettings: extensionSettings(text, app, ext),
    }, { randomId }).text;
    t = addSourceFiles(t, sources, { target: ext.name, randomId }).text;
    t = addEmbedPhase(t, { host: app, extension: ext.name }, { randomId }).text;
    return addTargetDependency(t, { host: app, dependency: ext.name }, { randomId }).text;
  });
}

/**
 * Report the App Group portal note (the same text from every extension installer, so a run
 * that installs several prints it once).
 *
 * @param inst The running installer.
 * @param group The App Group.
 */
export async function reportAppGroup(inst: Installer, group: string): Promise<void> {
  const pbxproj = await readText(join(inst.opts.dir, PBXPROJ)) ?? "";
  const note = portalNote(group, appBundleId(pbxproj) ?? "<app bundle id>");
  if (!inst.report.manual.includes(note)) inst.report.manual.push(note);
}
