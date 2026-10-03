// The iOS privacy manifest (`PrivacyInfo.xcprivacy`) of a Capacitor app: which required-reason
// APIs each `denext mobile add` capability's native code calls, merging those declarations into
// the manifest (never dropping an entry the app already has), adding the file to the Xcode
// project's Copy Bundle Resources, and validating a manifest for `denext mobile privacy --check`,
// `denext mobile doctor --store` and `denext doctor`.
//
// Sources. The categories, the approved reason codes and the rule that "the bundle that includes
// the executable ... needs to include a privacy manifest" are Apple's:
//   https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
//   https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype
// ("Starting May 1, 2024, apps that don't describe their use of required reason API in their
// privacy manifest file aren't accepted by App Store Connect"). The collected-data keys and
// values: https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests
// Capacitor's own guidance (declare the plugins' use in the app's manifest, e.g. UserDefaults
// CA92.1 for @capacitor/preferences): https://capacitorjs.com/docs/ios/privacy-manifest
//
// The per-capability table was built by reading each pinned plugin's iOS sources (the npm
// tarball of the exact version in MOBILE_CAPABILITIES) and denext's own native templates for the
// APIs Apple lists; none of the pinned plugins ships a PrivacyInfo.xcprivacy of its own. An empty
// list means "checked: no required-reason API in its iOS code".

import { join } from "@std/path";
import { addSourceFiles } from "./pbxproj.ts";
import {
  dictGet,
  parsePlist,
  type PlistDict,
  plistEqual,
  type PlistNode,
  renderPlist,
  stringOf,
} from "./plist-value.ts";

/** A required-reason API category (the `NSPrivacyAccessedAPIType` value). */
export type PrivacyApiCategory =
  | "NSPrivacyAccessedAPICategoryFileTimestamp"
  | "NSPrivacyAccessedAPICategorySystemBootTime"
  | "NSPrivacyAccessedAPICategoryDiskSpace"
  | "NSPrivacyAccessedAPICategoryActiveKeyboards"
  | "NSPrivacyAccessedAPICategoryUserDefaults";

/**
 * Every approved reason per category, with Apple's meaning in brief (NSPrivacyAccessedAPIType,
 * retrieved 2026-09-27). A code outside its category's list is rejected by App Store Connect.
 */
export const REQUIRED_REASON_CODES: Readonly<
  Record<PrivacyApiCategory, Readonly<Record<string, string>>>
> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: {
    "DDA9.1": "display file timestamps to the person using the device (not sent off-device)",
    "C617.1": "timestamps/size/metadata of files inside the app, App Group or CloudKit container",
    "3B52.1": "timestamps/metadata of files the user granted access to (e.g. a document picker)",
    "0A2A.1": "third-party SDK wrapper around file timestamp APIs (SDKs only)",
  },
  NSPrivacyAccessedAPICategorySystemBootTime: {
    "35F9.1": "measure time elapsed between in-app events, or enable timers",
    "8FFB.1": "calculate absolute timestamps for in-app events (UIKit / AVFAudio)",
    "3D61.1": "include boot time in an optional bug report the user chooses to submit",
  },
  NSPrivacyAccessedAPICategoryDiskSpace: {
    "85F4.1": "display disk space information to the person using the device",
    "E174.1": "check there is enough space to write files, or delete files when space is low",
    "7D9E.1": "include disk space in an optional bug report the user chooses to submit",
    "B728.1": "health research app informing participants about low disk space",
  },
  NSPrivacyAccessedAPICategoryActiveKeyboards: {
    "3EC4.1": "a custom keyboard app determining the active keyboards",
    "54BD.1": "present a UI customised to the active keyboards",
  },
  NSPrivacyAccessedAPICategoryUserDefaults: {
    "CA92.1": "read and write information only accessible to the app itself",
    "1C8F.1": "read and write information shared within the app's App Group",
    "C56D.1": "third-party SDK wrapper around user defaults APIs (SDKs only)",
    "AC6B.1": "read managed app configuration / write MDM feedback keys",
  },
};

/** Reasons Apple allows only in a third-party SDK's manifest, never an app's. */
const SDK_ONLY_REASONS: readonly string[] = ["0A2A.1", "C56D.1"];

/** Apple's `NSPrivacyCollectedDataType` values. */
const COLLECTED_DATA_TYPES: readonly string[] = [
  "Name",
  "EmailAddress",
  "PhoneNumber",
  "PhysicalAddress",
  "OtherUserContactInfo",
  "Health",
  "Fitness",
  "PaymentInfo",
  "CreditInfo",
  "OtherFinancialInfo",
  "PreciseLocation",
  "CoarseLocation",
  "SensitiveInfo",
  "Contacts",
  "EmailsOrTextMessages",
  "PhotosorVideos",
  "AudioData",
  "GameplayContent",
  "CustomerSupport",
  "OtherUserContent",
  "BrowsingHistory",
  "SearchHistory",
  "UserID",
  "DeviceID",
  "PurchaseHistory",
  "ProductInteraction",
  "AdvertisingData",
  "OtherUsageData",
  "CrashData",
  "PerformanceData",
  "OtherDiagnosticData",
  "EnvironmentScanning",
  "Hands",
  "Head",
  "OtherDataTypes",
].map((t) => `NSPrivacyCollectedDataType${t}`);

/** Apple's `NSPrivacyCollectedDataTypePurposes` values. */
const COLLECTED_DATA_PURPOSES: readonly string[] = [
  "ThirdPartyAdvertising",
  "DeveloperAdvertising",
  "Analytics",
  "ProductPersonalization",
  "AppFunctionality",
  "Other",
].map((p) => `NSPrivacyCollectedDataTypePurpose${p}`);

/** One accessed-API declaration: a category and the reasons that apply. */
export interface PrivacyApiUse {
  readonly category: PrivacyApiCategory;
  readonly reasons: readonly string[];
}

/** One collected-data declaration (an App Store "nutrition label" row). */
export interface PrivacyDataUse {
  /** `NSPrivacyCollectedDataType…`. */
  readonly type: string;
  readonly linked: boolean;
  readonly tracking: boolean;
  /** `NSPrivacyCollectedDataTypePurpose…` values. */
  readonly purposes: readonly string[];
}

/** What one capability's native code needs declared, in one bundle. */
export interface PrivacyEntry {
  /** `"app"`, or the app extension target whose bundle runs the code (`DenextWidgets`). */
  readonly bundle: string;
  readonly apis?: readonly PrivacyApiUse[];
  readonly data?: readonly PrivacyDataUse[];
  /** The code that calls the API (the evidence), for the plan and `mobile privacy`. */
  readonly source: string;
}

const FILE_TIMESTAMP = "NSPrivacyAccessedAPICategoryFileTimestamp";
const USER_DEFAULTS = "NSPrivacyAccessedAPICategoryUserDefaults";

/** A not-linked, not-tracking App Functionality data row (what a crash reporter collects). */
function diagnostics(type: string): PrivacyDataUse {
  return {
    type: `NSPrivacyCollectedDataType${type}`,
    linked: false,
    tracking: false,
    purposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  };
}

/**
 * The required-reason declarations of every `denext mobile add` capability, by name. An empty
 * list is a checked "none". A capability `denext mobile add` knows but this table lacks is a
 * test failure (tests/mobile-privacy.test.ts), so a new capability must be checked too.
 */
export const CAPABILITY_PRIVACY: Readonly<Record<string, readonly PrivacyEntry[]>> = {
  haptics: [],
  clipboard: [],
  share: [],
  // @capacitor/device 8.0.3 reads memory use and the model, no disk space (the diskFree
  // fields were removed from getInfo).
  device: [],
  network: [],
  "keep-awake": [],
  splash: [],
  "secure-store": [],
  browser: [],
  "deep-links": [],
  "auth-session": [],
  // The secure-storage plugin (Keychain) and denext's DenextAuthSession: no required-reason APIs.
  clerk: [],
  push: [],
  filesystem: [{
    bundle: "app",
    apis: [{ category: FILE_TIMESTAMP, reasons: ["C617.1"] }],
    source: "@capacitor/filesystem stat() returns ctime/mtime of files in the app container " +
      "(FilesystemPlugin, IONFileStructures+Converters.swift)",
  }],
  camera: [],
  "document-picker": [{
    bundle: "app",
    apis: [{ category: FILE_TIMESTAMP, reasons: ["3B52.1"] }],
    source: "@capawesome/capacitor-file-picker reads the modificationDate of the picked file " +
      "(FilePicker.swift attributesOfItem)",
  }],
  barcode: [],
  "quick-actions": [],
  sqlite: [],
  "share-extension": [
    {
      bundle: "app",
      apis: [{ category: FILE_TIMESTAMP, reasons: ["C617.1"] }],
      source: "DenextShareInbox.pruneFiles() reads contentModificationDateKey of shared files in " +
        "the App Group container (compiled into the app)",
    },
    {
      bundle: "DenextShareExtension",
      apis: [{ category: FILE_TIMESTAMP, reasons: ["C617.1"] }],
      source: "ShareViewController calls DenextShareInbox.pruneFiles() in the extension",
    },
  ],
  widget: [
    {
      bundle: "app",
      apis: [{ category: USER_DEFAULTS, reasons: ["1C8F.1"] }],
      source: "DenextWidgetsPlugin writes widget snapshots to UserDefaults(suiteName: <App Group>)",
    },
    {
      bundle: "DenextWidgets",
      apis: [{ category: USER_DEFAULTS, reasons: ["1C8F.1"] }],
      source: "DenextWidgetStore reads widget snapshots from UserDefaults(suiteName: <App Group>)",
    },
  ],
  "live-activity": [],
  // The generated Swift sample calls no required-reason API (the app's own code may).
  "native-module": [],
  keyboard: [],
  back: [],
  "system-bars": [],
  dialog: [],
  toast: [],
  "action-sheet": [],
  permissions: [],
  "local-notifications": [],
  biometrics: [],
  "social-login": [{
    bundle: "app",
    apis: [{ category: USER_DEFAULTS, reasons: ["CA92.1"] }],
    source: "@capgo/capacitor-social-login stores provider state in UserDefaults.standard " +
      "(AppleProvider, OAuth2Provider, TwitterProvider)",
  }],
  geolocation: [],
  purchases: [],
  // The native SDK (sentry-cocoa) ships its own manifest for its API use; the app declares
  // what it collects, which the JS SDK in the WebView sends too (mirroring sentry-cocoa's rows).
  sentry: [{
    bundle: "app",
    data: [
      diagnostics("CrashData"),
      diagnostics("PerformanceData"),
      diagnostics("OtherDiagnosticData"),
    ],
    source: "@sentry/capacitor sends crash reports, performance data and diagnostics",
  }],
  "offline-screen": [],
  "export-routes": [],
  // fastlane is release tooling: nothing of it ships in the app.
  fastlane: [],
  "app-review": [],
  "app-update": [],
  "screen-orientation": [],
  // @capacitor-community/media sorts and reports PHAsset.creationDate (Photos metadata, not one
  // of the file timestamp APIs Apple lists).
  "media-library": [],
  "privacy-screen": [],
  // App Tracking Transparency itself needs no reason; an app that tracks sets NSPrivacyTracking
  // and its NSPrivacyTrackingDomains, which only the app knows (the doctor checks the pair).
  tracking: [],
  background: [{
    bundle: "app",
    apis: [{ category: USER_DEFAULTS, reasons: ["CA92.1"] }],
    source: "@capacitor/background-runner's CapacitorKV stores values in UserDefaults.standard " +
      "(CapacitorAPI/KV.swift)",
  }],
  restore: [],
  // UIAccessibility.isVoiceOverRunning and its notification are not required-reason APIs.
  accessibility: [],
  // The system SQLite and FileManager's Application Support URL: no required-reason API (no
  // file timestamps, disk space or UserDefaults).
  storage: [],
  // UIContextMenuInteraction / UIMenu and UIImage(systemName:) use no required-reason API.
  "context-menu": [],
  "system-icons": [],
  // The fixes themselves are the app's data to declare (Precise Location, when they leave the
  // device); the plugin's own API use is UserDefaults.
  "background-location": [{
    bundle: "app",
    apis: [{ category: USER_DEFAULTS, reasons: ["CA92.1"] }],
    source: "@capgo/background-geolocation keeps its geofence setup and regions in " +
      "UserDefaults.standard (CapgoCapacitorBackgroundGeolocationPlugin.swift)",
  }],
  // @capacitor/app's getInfo() reads the bundle; @capacitor/device is `device` above.
  application: [],
  // AVPlayer, MapKit and the view layering use no required-reason API.
  "native-views": [],
  "native-map": [],
};

/**
 * Packages outside the `mobile add` table whose use needs declaring, by the name detection
 * reports them under: `@capacitor/preferences` (which `restore` uses when the app adds it) is
 * UserDefaults, CA92.1, the example Capacitor's privacy-manifest guide itself gives.
 */
const PACKAGE_PRIVACY: Readonly<Record<string, { npm: string; entries: readonly PrivacyEntry[] }>> =
  {
    preferences: {
      npm: "@capacitor/preferences",
      entries: [{
        bundle: "app",
        apis: [{ category: USER_DEFAULTS, reasons: ["CA92.1"] }],
        source: "@capacitor/preferences stores values in UserDefaults (restoreRouteOnRelaunch " +
          "keeps the route there when it is installed)",
      }],
    },
  };

/** `denext mobile add-ota`'s DenextOtaStore keeps its state in UserDefaults.standard. */
export const OTA_PRIVACY: readonly PrivacyEntry[] = [{
  bundle: "app",
  apis: [{ category: USER_DEFAULTS, reasons: ["CA92.1"] }],
  source: "DenextOtaStore (denext mobile add-ota) keeps the OTA state in UserDefaults.standard",
}];

/** The privacy manifest of `bundle`, relative to the Capacitor project. */
function privacyManifestPath(bundle: string): string {
  return bundle === "app"
    ? "ios/App/App/PrivacyInfo.xcprivacy"
    : `ios/App/${bundle}/PrivacyInfo.xcprivacy`;
}

/** The file name Xcode's "App Privacy" template writes. */
const MANIFEST_NAME = "PrivacyInfo.xcprivacy";

/**
 * The declarations the named capabilities need.
 *
 * @param names Capability names (unknown ones contribute nothing).
 * @returns Their entries, in order.
 */
export function privacyEntriesFor(names: readonly string[]): PrivacyEntry[] {
  return names.flatMap((n) => Object.hasOwn(CAPABILITY_PRIVACY, n) ? CAPABILITY_PRIVACY[n] : []);
}

/** A one-line label per declaration, for the plan (`FileTimestamp C617.1`). */
export function privacyLabels(entries: readonly PrivacyEntry[]): string[] {
  const labels = entries.flatMap((e) => [
    ...(e.apis ?? []).map((a) =>
      `${short(a.category)} ${a.reasons.join(", ")}${e.bundle === "app" ? "" : ` (${e.bundle})`}`
    ),
    ...(e.data ?? []).map((d) => `collected ${d.type.replace("NSPrivacyCollectedDataType", "")}`),
  ]);
  return [...new Set(labels)];
}

/** `NSPrivacyAccessedAPICategoryFileTimestamp` → `FileTimestamp`. */
function short(category: string): string {
  return category.replace("NSPrivacyAccessedAPICategory", "");
}

// ---- merge ------------------------------------------------------------------------------------

const str = (text: string): PlistNode => ({ kind: "string", text });
const bool = (value: boolean): PlistNode => ({ kind: "bool", value });

/** A new manifest: no tracking, no tracking domains, nothing collected, no API declared. */
function emptyManifest(): PlistDict {
  return {
    kind: "dict",
    entries: [
      ["NSPrivacyTracking", bool(false)],
      ["NSPrivacyTrackingDomains", { kind: "array", items: [] }],
      ["NSPrivacyCollectedDataTypes", { kind: "array", items: [] }],
      ["NSPrivacyAccessedAPITypes", { kind: "array", items: [] }],
    ],
  };
}

/** The array at `key` of `dict`, created (last) when absent; null when it holds a non-array. */
function arrayAt(dict: PlistDict, key: string): PlistNode[] | null {
  const found = dictGet(dict, key);
  if (found === undefined) {
    const items: PlistNode[] = [];
    dict.entries.push([key, { kind: "array", items }]);
    return items;
  }
  return found.kind === "array" ? found.items : null;
}

/** The dict in `items` whose `key` is the string `value`. */
function dictWith(items: PlistNode[], key: string, value: string): PlistDict | undefined {
  return items.find((i): i is PlistDict =>
    i.kind === "dict" && stringOf(dictGet(i, key)) === value
  );
}

/** Add `values` missing from the string array `key` of `dict`; returns the ones added. */
function addStrings(dict: PlistDict, key: string, values: readonly string[]): string[] {
  const items = arrayAt(dict, key);
  if (items === null) throw new Error(`${key} is not an array`);
  const have = items.map(stringOf);
  const added = values.filter((v) => !have.includes(v));
  items.push(...added.map(str));
  return added;
}

/** Merge one accessed-API declaration into the manifest; the labels of what was added. */
function mergeApi(root: PlistDict, use: PrivacyApiUse): string[] {
  const list = arrayAt(root, "NSPrivacyAccessedAPITypes");
  if (list === null) throw new Error("NSPrivacyAccessedAPITypes is not an array");
  const existing = dictWith(list, "NSPrivacyAccessedAPIType", use.category);
  if (existing) {
    return addStrings(existing, "NSPrivacyAccessedAPITypeReasons", use.reasons)
      .map((r) => `${short(use.category)} ${r}`);
  }
  list.push({
    kind: "dict",
    entries: [
      ["NSPrivacyAccessedAPIType", str(use.category)],
      ["NSPrivacyAccessedAPITypeReasons", { kind: "array", items: use.reasons.map(str) }],
    ],
  });
  return [`${short(use.category)} ${use.reasons.join(", ")}`];
}

/** Merge one collected-data row; an existing row keeps its linked/tracking flags (the app's). */
function mergeData(root: PlistDict, use: PrivacyDataUse): string[] {
  const list = arrayAt(root, "NSPrivacyCollectedDataTypes");
  if (list === null) throw new Error("NSPrivacyCollectedDataTypes is not an array");
  const label = `collected ${use.type.replace("NSPrivacyCollectedDataType", "")}`;
  const existing = dictWith(list, "NSPrivacyCollectedDataType", use.type);
  if (existing) {
    const added = addStrings(existing, "NSPrivacyCollectedDataTypePurposes", use.purposes);
    return added.length > 0 ? [label] : [];
  }
  list.push({
    kind: "dict",
    entries: [
      ["NSPrivacyCollectedDataType", str(use.type)],
      ["NSPrivacyCollectedDataTypeLinked", bool(use.linked)],
      ["NSPrivacyCollectedDataTypeTracking", bool(use.tracking)],
      ["NSPrivacyCollectedDataTypePurposes", { kind: "array", items: use.purposes.map(str) }],
    ],
  });
  return [label];
}

/** The top-level keys a manifest carries, added when absent (tracking off by default). */
function withRequiredKeys(root: PlistDict): void {
  for (const [key, value] of emptyManifest().entries) {
    if (dictGet(root, key) === undefined) root.entries.push([key, value]);
  }
}

/**
 * A privacy manifest with `entries` merged in: missing categories, reasons and collected-data
 * rows are added; nothing the manifest already has is removed or changed (an app's own
 * `NSPrivacyTracking`, domains and data rows stay as they are). A missing manifest starts from
 * one with tracking off and empty lists.
 *
 * @param text The current manifest, or undefined when there is none.
 * @param entries The declarations to merge (all for the same bundle).
 * @returns The manifest text (the input itself when nothing changed) and what was added.
 * @throws When the manifest is not an XML plist with a top-level dict, or a list key holds
 *   something other than an array.
 */
export function mergePrivacyManifest(
  text: string | undefined,
  entries: readonly PrivacyEntry[],
): { text: string; added: string[] } {
  const parsed = text === undefined ? emptyManifest() : parsePlist(text);
  if (parsed.kind !== "dict") throw new Error("the privacy manifest's root is not a dict");
  const root: PlistDict = structuredClone(parsed);
  withRequiredKeys(root);
  const added = entries.flatMap((e) => [
    ...(e.apis ?? []).flatMap((a) => mergeApi(root, a)),
    ...(e.data ?? []).flatMap((d) => mergeData(root, d)),
  ]);
  if (text !== undefined && plistEqual(root, parsed)) return { text, added: [] };
  return { text: renderPlist(root), added: [...new Set(added)] };
}

// ---- writing into the project -----------------------------------------------------------------

/** What {@linkcode writePrivacyManifests} did, as project-relative paths and notes. */
export interface PrivacyWriteReport {
  written: string[];
  unchanged: string[];
  skipped: string[];
  manual: string[];
  /** The declarations added, per manifest path. */
  added: Record<string, string[]>;
}

/** Options for {@linkcode writePrivacyManifests}. */
export interface PrivacyWriteOptions {
  /** Plan only: report what would be written. */
  readonly dryRun?: boolean;
  /** Write the app manifest even with nothing to declare (`denext mobile privacy --write`). */
  readonly ensureApp?: boolean;
  /** Id generator for new pbxproj objects (tests). */
  readonly randomId?: () => string;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** `entries` grouped by bundle, the app first. */
function byBundle(entries: readonly PrivacyEntry[]): Map<string, PrivacyEntry[]> {
  const groups = new Map<string, PrivacyEntry[]>([["app", []]]);
  for (const e of entries) groups.set(e.bundle, [...(groups.get(e.bundle) ?? []), e]);
  return groups;
}

const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";

/**
 * Add `PrivacyInfo.xcprivacy` to `bundle`'s target (Copy Bundle Resources), unless it is there.
 * Returns whether the pbxproj changed; a project the editor cannot read is a manual step.
 */
async function addToXcode(
  root: string,
  bundle: string,
  report: PrivacyWriteReport,
  opts: PrivacyWriteOptions,
): Promise<void> {
  const path = join(root, PBXPROJ);
  const text = await readText(path);
  if (text === undefined) return;
  const target = bundle === "app" ? {} : { target: bundle, group: bundle };
  try {
    const result = addSourceFiles(text, [MANIFEST_NAME], {
      ...target,
      phase: "resources",
      randomId: opts.randomId,
    });
    if (result.added.length === 0) return;
    if (!opts.dryRun) await Deno.writeTextFile(path, result.text);
    if (!report.written.includes(PBXPROJ)) report.written.push(PBXPROJ);
  } catch (err) {
    report.manual.push(
      `add ${privacyManifestPath(bundle)} to the ${bundle === "app" ? "App" : bundle} target in ` +
        `Xcode (Target Membership; it must be in Copy Bundle Resources): ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}

/** Merge one bundle's declarations into its manifest file. */
async function writeBundleManifest(
  root: string,
  bundle: string,
  entries: readonly PrivacyEntry[],
  report: PrivacyWriteReport,
  opts: PrivacyWriteOptions,
): Promise<void> {
  const rel = privacyManifestPath(bundle);
  const folder = bundle === "app" ? "ios/App/App" : `ios/App/${bundle}`;
  if (!(await isDir(join(root, folder)))) {
    if (bundle === "app") report.skipped.push(`iOS: no ${folder} (run \`npx cap add ios\` first).`);
    return;
  }
  const current = await readText(join(root, rel));
  let merged: { text: string; added: string[] };
  try {
    merged = mergePrivacyManifest(current, entries);
  } catch (err) {
    report.manual.push(
      `${rel}: ${err instanceof Error ? err.message : String(err)}; add ${
        privacyLabels(entries).join("; ")
      } by hand`,
    );
    return;
  }
  if (merged.text === current) report.unchanged.push(rel);
  else {
    if (!opts.dryRun) await Deno.writeTextFile(join(root, rel), merged.text);
    report.written.push(rel);
    if (merged.added.length > 0) report.added[rel] = merged.added;
  }
  await addToXcode(root, bundle, report, opts);
}

/**
 * Merge `entries` into the privacy manifest of each bundle they name (`ios/App/App` for the app,
 * `ios/App/<Target>` for an app extension), creating a manifest where needed and adding it to
 * that target's Copy Bundle Resources in `project.pbxproj`. A bundle with nothing to declare is
 * left alone (the app's too, unless `ensureApp`). Idempotent.
 *
 * @param root The Capacitor project.
 * @param entries The declarations (see {@linkcode privacyEntriesFor}).
 * @param opts Dry run, and whether to write an app manifest with nothing in it.
 * @returns What changed.
 */
export async function writePrivacyManifests(
  root: string,
  entries: readonly PrivacyEntry[],
  opts: PrivacyWriteOptions = {},
): Promise<PrivacyWriteReport> {
  const report: PrivacyWriteReport = {
    written: [],
    unchanged: [],
    skipped: [],
    manual: [],
    added: {},
  };
  if (!(await isDir(join(root, "ios")))) return report;
  for (const [bundle, list] of byBundle(entries)) {
    if (list.length === 0 && !(bundle === "app" && opts.ensureApp)) continue;
    await writeBundleManifest(root, bundle, list, report, opts);
  }
  return report;
}

// ---- detection + validation -------------------------------------------------------------------

/** The slice of the capability table detection reads: each capability's npm package. */
export type CapabilityPackages = Readonly<Record<string, { readonly npm?: string }>>;

/** Files whose presence means a native-template capability is installed. */
const TEMPLATE_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["share-extension", "ios/App/DenextShareExtension"],
  ["widget", "ios/App/App/DenextWidgetsPlugin.swift"],
  ["ota", "ios/App/App/DenextOtaStore.swift"],
];

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The dependency names in `root/package.json` (dependencies and devDependencies). */
async function dependencyNames(root: string): Promise<Set<string>> {
  const text = await readText(join(root, "package.json"));
  if (text === undefined) return new Set();
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return new Set(
      [pkg.dependencies, pkg.devDependencies].flatMap((d) =>
        d !== null && typeof d === "object" ? Object.keys(d) : []
      ),
    );
  } catch {
    return new Set();
  }
}

/**
 * The capabilities a Capacitor project has installed, as far as its privacy manifest cares: each
 * `denext mobile add` capability whose npm package `package.json` lists, the native-template ones
 * whose files exist (share-extension, widget), and `ota` for `denext mobile add-ota`.
 *
 * @param root The Capacitor project.
 * @param table The capability table (`MOBILE_CAPABILITIES`), for each capability's npm package.
 * @returns Capability names (plus `ota`).
 */
export async function detectInstalledCapabilities(
  root: string,
  table: CapabilityPackages,
): Promise<string[]> {
  const deps = await dependencyNames(root);
  const names = Object.entries(table)
    .filter(([, cap]) => cap.npm !== undefined && deps.has(cap.npm))
    .map(([name]) => name);
  for (const [name, { npm }] of Object.entries(PACKAGE_PRIVACY)) {
    if (deps.has(npm)) names.push(name);
  }
  for (const [name, marker] of TEMPLATE_MARKERS) {
    if (await exists(join(root, marker))) names.push(name);
  }
  return names;
}

/** The declarations installed capabilities need (see {@linkcode detectInstalledCapabilities}). */
export function requiredPrivacyEntries(installed: readonly string[]): PrivacyEntry[] {
  return installed.flatMap((n) => {
    if (n === "ota") return [...OTA_PRIVACY];
    if (Object.hasOwn(PACKAGE_PRIVACY, n)) return [...PACKAGE_PRIVACY[n].entries];
    return privacyEntriesFor([n]);
  });
}

/** One problem with a privacy manifest. */
export interface PrivacyFinding {
  /** `error` stops App Store Connect accepting the build (or is a certain gap); `warning` may. */
  readonly level: "error" | "warning";
  /** The manifest it is about (project-relative). */
  readonly file: string;
  readonly message: string;
  /** How to fix it. */
  readonly fix: string;
}

/** The validation of one project's privacy manifests. */
export interface PrivacyCheck {
  /** The app manifest's path (project-relative). */
  readonly file: string;
  /** Its text, or undefined when there is none. */
  readonly text: string | undefined;
  /** The capabilities detected (`ota` included). */
  readonly installed: readonly string[];
  /** Every problem found. */
  readonly findings: readonly PrivacyFinding[];
}

const WRITE_FIX =
  "run `denext mobile privacy --write` (merges every installed capability's entries)";

/** Findings for one accessed-API dict of a manifest. */
function apiFindings(file: string, node: PlistNode): PrivacyFinding[] {
  const bad = (message: string): PrivacyFinding => ({
    level: "error",
    file,
    message,
    fix: "use a category and reasons from Apple's NSPrivacyAccessedAPIType list",
  });
  if (node.kind !== "dict") return [bad("an NSPrivacyAccessedAPITypes item is not a dict")];
  const category = stringOf(dictGet(node, "NSPrivacyAccessedAPIType")) ?? "";
  const codes = (REQUIRED_REASON_CODES as Record<string, Record<string, string>>)[category];
  if (!codes) return [bad(`unknown NSPrivacyAccessedAPIType "${category}"`)];
  const reasonsNode = dictGet(node, "NSPrivacyAccessedAPITypeReasons");
  const reasons = reasonsNode?.kind === "array" ? reasonsNode.items.map(stringOf) : [];
  if (reasons.length === 0) return [bad(`${short(category)} lists no reasons`)];
  return reasons.flatMap((r): PrivacyFinding[] => {
    if (r === undefined || !Object.hasOwn(codes, r)) {
      return [bad(`${short(category)}: "${r}" is not an approved reason for this category`)];
    }
    if (SDK_ONLY_REASONS.includes(r)) {
      return [bad(`${short(category)}: ${r} may only be declared by a third-party SDK`)];
    }
    return [];
  });
}

/** Findings for one collected-data dict. */
function dataFindings(file: string, node: PlistNode): PrivacyFinding[] {
  const bad = (message: string): PrivacyFinding => ({
    level: "error",
    file,
    message,
    fix: "give each row a known NSPrivacyCollectedDataType, Linked, Tracking and Purposes",
  });
  if (node.kind !== "dict") return [bad("an NSPrivacyCollectedDataTypes item is not a dict")];
  const type = stringOf(dictGet(node, "NSPrivacyCollectedDataType")) ?? "";
  const out: PrivacyFinding[] = [];
  if (!COLLECTED_DATA_TYPES.includes(type)) out.push(bad(`unknown collected data type "${type}"`));
  for (const key of ["NSPrivacyCollectedDataTypeLinked", "NSPrivacyCollectedDataTypeTracking"]) {
    if (dictGet(node, key)?.kind !== "bool") out.push(bad(`${type}: ${key} is missing`));
  }
  const purposes = dictGet(node, "NSPrivacyCollectedDataTypePurposes");
  const list = purposes?.kind === "array" ? purposes.items.map(stringOf) : [];
  if (list.length === 0) out.push(bad(`${type}: no NSPrivacyCollectedDataTypePurposes`));
  for (const p of list) {
    if (p === undefined || !COLLECTED_DATA_PURPOSES.includes(p)) {
      out.push(bad(`${type}: unknown purpose "${p}"`));
    }
  }
  return out;
}

/** Findings for the top-level shape: the four keys, and tracking domains when tracking. */
function shapeFindings(file: string, root: PlistDict): PrivacyFinding[] {
  const out: PrivacyFinding[] = [];
  const kinds: Record<string, string> = {
    NSPrivacyTracking: "bool",
    NSPrivacyTrackingDomains: "array",
    NSPrivacyCollectedDataTypes: "array",
    NSPrivacyAccessedAPITypes: "array",
  };
  for (const [key, kind] of Object.entries(kinds)) {
    const node = dictGet(root, key);
    if (node === undefined) {
      out.push({ level: "warning", file, message: `${key} is missing`, fix: WRITE_FIX });
    } else if (node.kind !== kind) {
      out.push({
        level: "error",
        file,
        message: `${key} is not a${kind === "array" ? "n array" : " boolean"}`,
        fix: `make ${key} a ${kind}`,
      });
    }
  }
  const tracking = dictGet(root, "NSPrivacyTracking");
  const domains = dictGet(root, "NSPrivacyTrackingDomains");
  if (
    tracking?.kind === "bool" && tracking.value &&
    !(domains?.kind === "array" && domains.items.length > 0)
  ) {
    out.push({
      level: "warning",
      file,
      message: "NSPrivacyTracking is true but NSPrivacyTrackingDomains is empty",
      fix: "list the domains that track (iOS blocks them until the user allows tracking)",
    });
  }
  return out;
}

/** Whether `root`'s manifest `api` declaration has every reason of `use`. */
function declares(root: PlistDict, use: PrivacyApiUse): boolean {
  const list = dictGet(root, "NSPrivacyAccessedAPITypes");
  if (list?.kind !== "array") return false;
  const dict = dictWith(list.items, "NSPrivacyAccessedAPIType", use.category);
  const reasons = dict && dictGet(dict, "NSPrivacyAccessedAPITypeReasons");
  const have = reasons?.kind === "array" ? reasons.items.map(stringOf) : [];
  return use.reasons.every((r) => have.includes(r));
}

/** Whether `root` has a collected-data row of `type`. */
function collects(root: PlistDict, type: string): boolean {
  const list = dictGet(root, "NSPrivacyCollectedDataTypes");
  return list?.kind === "array" &&
    dictWith(list.items, "NSPrivacyCollectedDataType", type) !== undefined;
}

/** Findings for declarations installed capabilities need that `root` lacks. */
function missingFindings(
  file: string,
  root: PlistDict,
  entries: readonly PrivacyEntry[],
): PrivacyFinding[] {
  const out: PrivacyFinding[] = [];
  for (const e of entries) {
    for (const use of e.apis ?? []) {
      if (declares(root, use)) continue;
      out.push({
        level: "error",
        file,
        message: `missing ${short(use.category)} ${use.reasons.join(", ")}: ${e.source}`,
        fix: WRITE_FIX,
      });
    }
    for (const d of e.data ?? []) {
      if (collects(root, d.type)) continue;
      out.push({
        level: "warning",
        file,
        message: `missing collected ${d.type}: ${e.source}`,
        fix: WRITE_FIX,
      });
    }
  }
  return out;
}

/** Whether the pbxproj copies `PrivacyInfo.xcprivacy` in a Resources phase. */
function inResources(pbxproj: string): boolean {
  return /\/\* PrivacyInfo\.xcprivacy in Resources \*\//.test(pbxproj);
}

/** Validate one bundle's manifest text against what it must declare. */
function manifestFindings(
  file: string,
  text: string,
  entries: readonly PrivacyEntry[],
): PrivacyFinding[] {
  let root: PlistNode;
  try {
    root = parsePlist(text);
  } catch (err) {
    return [{
      level: "error",
      file,
      message: `not a readable XML plist: ${err instanceof Error ? err.message : err}`,
      fix: "recreate it with Xcode's App Privacy template or `denext mobile privacy --write`",
    }];
  }
  if (root.kind !== "dict") {
    return [{ level: "error", file, message: "the root is not a dict", fix: WRITE_FIX }];
  }
  const apis = dictGet(root, "NSPrivacyAccessedAPITypes");
  const data = dictGet(root, "NSPrivacyCollectedDataTypes");
  return [
    ...shapeFindings(file, root),
    ...(apis?.kind === "array" ? apis.items.flatMap((i) => apiFindings(file, i)) : []),
    ...(data?.kind === "array" ? data.items.flatMap((i) => dataFindings(file, i)) : []),
    ...missingFindings(file, root, entries),
  ];
}

/** The findings for one bundle: missing file, or its content. */
async function bundleFindings(
  root: string,
  bundle: string,
  entries: readonly PrivacyEntry[],
  pbxproj: string | undefined,
): Promise<{ text: string | undefined; findings: PrivacyFinding[] }> {
  const file = privacyManifestPath(bundle);
  const text = await readText(join(root, file));
  if (text === undefined) {
    const needed = entries.some((e) => (e.apis?.length ?? 0) > 0);
    return {
      text,
      findings: [{
        level: needed ? "error" : "warning",
        file,
        message: needed
          ? `no privacy manifest, but ${privacyLabels(entries).join("; ")} must be declared`
          : "no privacy manifest (App Store Connect expects one for tracking and data-use declarations)",
        fix: WRITE_FIX,
      }],
    };
  }
  const findings = manifestFindings(file, text, entries);
  if (pbxproj !== undefined && bundle === "app" && !inResources(pbxproj)) {
    findings.push({
      level: "error",
      file,
      message: "the file is not in the Xcode project's Copy Bundle Resources, so it never ships",
      fix: WRITE_FIX + ", or tick the App target under Target Membership in Xcode",
    });
  }
  return { text, findings };
}

/**
 * Validate a Capacitor project's privacy manifests: the app's (and each app extension's that has
 * declarations to make) against Apple's categories, reason codes and data-use values, against
 * what the installed capabilities need, and whether Xcode copies the app's into the bundle.
 * A project without `ios/` has nothing to check.
 *
 * @param root The Capacitor project.
 * @param table The capability table (`MOBILE_CAPABILITIES`).
 * @returns The app manifest, the capabilities detected, and the findings.
 */
export async function checkPrivacyManifest(
  root: string,
  table: CapabilityPackages,
): Promise<PrivacyCheck> {
  const installed = await detectInstalledCapabilities(root, table);
  const file = privacyManifestPath("app");
  if (!(await isDir(join(root, "ios")))) return { file, text: undefined, installed, findings: [] };
  const pbxproj = await readText(join(root, PBXPROJ));
  const findings: PrivacyFinding[] = [];
  let appText: string | undefined;
  for (const [bundle, entries] of byBundle(requiredPrivacyEntries(installed))) {
    if (bundle !== "app" && entries.length === 0) continue;
    if (bundle !== "app" && !(await isDir(join(root, "ios/App", bundle)))) continue;
    const result = await bundleFindings(root, bundle, entries, pbxproj);
    if (bundle === "app") appText = result.text;
    findings.push(...result.findings);
  }
  findings.push(...trackingFindings(file, appText, installed));
  return { file, text: appText, installed, findings };
}

/**
 * An app that asks for App Tracking Transparency (`mobile add tracking`) tracks, so its manifest
 * says so: `NSPrivacyTracking` true and the domains that track in `NSPrivacyTrackingDomains`
 * (iOS blocks connections to those domains until the user allows tracking). See
 * https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacytracking
 */
function trackingFindings(
  file: string,
  text: string | undefined,
  installed: readonly string[],
): PrivacyFinding[] {
  if (!installed.includes("tracking") || text === undefined) return [];
  let root: PlistNode;
  try {
    root = parsePlist(text);
  } catch {
    return [];
  }
  const tracking = root.kind === "dict" ? dictGet(root, "NSPrivacyTracking") : undefined;
  if (tracking?.kind === "bool" && tracking.value) return [];
  return [{
    level: "warning",
    file,
    message: "the app asks for tracking permission (App Tracking Transparency) but " +
      "NSPrivacyTracking is not true",
    fix: "set NSPrivacyTracking to true and list the tracking domains in " +
      "NSPrivacyTrackingDomains (or drop `tracking` if the app does not track)",
  }];
}
