// `denext migrate --from expo`: what an Expo / React Native app needs to build on denext
// (React Native mode, `reactNative: true`) and to ship in a Capacitor shell.
//
// This module only READS the app and computes; migrate.ts writes the files. It covers:
//
//   - the app config: `app.json` (`expo` key or top level) and `app.config.{ts,js,…}`, read
//     STATICALLY by ./expo-app-config.ts (project code is never executed);
//   - the web entry: `main` in package.json, `expo-router/entry`, or Expo's default `App`;
//   - the Capacitor shell: appId / appName, and the `denext mobile add` capabilities the
//     app's `expo-*` packages, config plugins, iOS usage strings, Android permissions,
//     scheme and associated domains call for;
//   - a dependency report: each `expo-*` / `@expo/*` package's shim status (`EXPO_SHIMS`),
//     each community React Native package React Native mode aliases to a denext
//     implementation (`COMMUNITY_ALIASES`), and the native-only React Native packages (Nitro,
//     TurboModule / Fabric codegen, Expo native modules) that have no web build.

import { dirname, join } from "@std/path";
import { EXPO_SHIMS } from "../expo/manifest.ts";
import { COMMUNITY_ALIASES } from "../react-native-compat/manifest.ts";
import { unwrap } from "./config-edit.ts";
import {
  type ExpoAppConfig,
  type ExpoBuildProperties,
  PLUGIN_USAGE_STRINGS,
  readJsonFile,
} from "./expo-app-config.ts";
import { MOBILE_CAPABILITIES } from "./mobile-capabilities.ts";
import { type Node, swcParse } from "./swc-ast.ts";

// --- the entry ----------------------------------------------------------------------------

/** How the app starts on the web. */
export interface ExpoEntry {
  /** The SPA entry, `./`-relative. */
  entry: string;
  /**
   * A web entry migrate writes: for Expo's default `App` entry (no file of its own), or
   * expo-router's entry without Metro's runtime.
   */
  generated?: { path: string; source: string; kind: "app" | "expo-router" };
  /** The app uses expo-router (its `main` is `expo-router/entry`, or it depends on it). */
  expoRouter: boolean;
}

/** Source extensions an entry may have, in the order Metro prefers them. */
const ENTRY_EXTS = [".tsx", ".ts", ".jsx", ".js"];

/** The first `base + ext` that exists, as a `./`-relative path, or null. */
async function probeEntry(dir: string, base: string): Promise<string | null> {
  const plain = base.replace(/^\.\//, "");
  const candidates = /\.[cm]?[jt]sx?$/.test(plain) ? [plain] : ENTRY_EXTS.map((e) => plain + e);
  for (const rel of [...candidates, ...ENTRY_EXTS.map((e) => join(plain, "index" + e))]) {
    try {
      if ((await Deno.stat(join(dir, rel))).isFile) return "./" + rel.replaceAll("\\", "/");
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * The web entry for an expo-router app: expo-router's own `entry-classic` minus its first
 * import, `@expo/metro-runtime` (Metro's module runtime and HMR client, which the denext bundle
 * replaces). The routes come from React Native mode's generated `expo-router/_ctx`.
 */
const EXPO_ROUTER_ENTRY =
  `// ${"index.web.ts"} — expo-router's web entry (expo-router/entry-classic) without
// @expo/metro-runtime, Metro's own runtime. denext generates the route context from app/.
import { App } from "expo-router/build/qualified-entry";
import { renderRootComponent } from "expo-router/build/renderRootComponent";

renderRootComponent(App);
`;

/** The web entry migrate writes for Expo's default `App` entry (`expo/AppEntry`). */
const EXPO_DEFAULT_ENTRY_FILE = "index.web.ts";

/**
 * The web entry of the Expo app at `dir`: package.json `main` when it is a file of the app;
 * for `expo-router/entry`, that; with no `main` (or `expo/AppEntry`), Expo's default — the
 * app's `App` component, mounted by a small generated entry.
 *
 * @param dir The app directory.
 * @param pkg The app's package.json.
 * @param deps Its dependencies.
 * @returns The entry, or null when none was found.
 */
export async function expoWebEntry(
  dir: string,
  pkg: Record<string, unknown>,
  deps: Record<string, string>,
): Promise<ExpoEntry | null> {
  const main = typeof pkg.main === "string" ? pkg.main : undefined;
  const expoRouter = main === "expo-router/entry" || "expo-router" in deps;
  if (main === "expo-router/entry" || main === "expo-router/entry-classic") {
    return {
      entry: "./" + EXPO_DEFAULT_ENTRY_FILE,
      generated: { path: EXPO_DEFAULT_ENTRY_FILE, source: EXPO_ROUTER_ENTRY, kind: "expo-router" },
      expoRouter,
    };
  }
  if (main && !/^expo\/AppEntry(\.js)?$/.test(main)) {
    const entry = await probeEntry(dir, main);
    return entry ? { entry, expoRouter } : null;
  }
  const app = await probeEntry(dir, "App");
  if (!app) return null;
  const source =
    `// ${EXPO_DEFAULT_ENTRY_FILE} — written by \`denext migrate\`: Expo's default entry
// (expo/AppEntry) mounts ./App; denext needs the entry as a file of the app.
import { registerRootComponent } from "expo";
import App from ${JSON.stringify(app.replace(/\.[jt]sx?$/, ""))};

registerRootComponent(App);
`;
  return {
    entry: "./" + EXPO_DEFAULT_ENTRY_FILE,
    generated: { path: EXPO_DEFAULT_ENTRY_FILE, source, kind: "app" },
    expoRouter,
  };
}

// --- capabilities -------------------------------------------------------------------------

/** One `denext mobile add` capability and why migrate suggests it. */
export interface CapabilitySuggestion {
  readonly capability: string;
  readonly because: string;
}

/**
 * The capabilities each `expo-*` package's shim calls natively (only packages with a shim: a
 * capability an unshimmed package's own web build never reaches is not suggested). A community
 * package's come from its `COMMUNITY_ALIASES` entry.
 */
const PACKAGE_CAPABILITIES: Readonly<Record<string, string | readonly string[]>> = {
  "expo-haptics": "haptics",
  "expo-clipboard": "clipboard",
  "expo-sharing": "share",
  "expo-device": "device",
  "expo-network": "network",
  "expo-keep-awake": "keep-awake",
  "expo-splash-screen": "splash",
  "expo-secure-store": "secure-store",
  "expo-web-browser": "browser",
  "expo-linking": "deep-links",
  "expo-auth-session": "auth-session",
  "expo-notifications": "push",
  "expo-file-system": "filesystem",
  "expo-image-picker": "camera",
  // takePictureAsync / recordAsync (camera, whose usage strings include the microphone's) and
  // the barcode scanner.
  "expo-camera": ["camera", "barcode"],
  "expo-document-picker": "document-picker",
  "expo-quick-actions": "quick-actions",
  "expo-sqlite": "sqlite",
  "expo-location": "geolocation",
  "expo-local-authentication": "biometrics",
  "expo-apple-authentication": "social-login",
  "expo-tracking-transparency": "tracking",
  // The app's name / id / version (@capacitor/app) and the vendor / Android id
  // (@capacitor/device, a peer of the capability).
  "expo-application": "application",
  "expo-store-review": "app-review",
  "expo-screen-orientation": "screen-orientation",
  "expo-media-library": "media-library",
  "expo-screen-capture": "privacy-screen",
  "expo-status-bar": "system-bars",
  "expo-navigation-bar": "system-bars",
  "expo-battery": "device",
  "expo-speech": "text-to-speech",
  "expo-brightness": "brightness",
  "expo-print": "print",
  "expo-intent-launcher": "intent-launcher",
  "expo-contacts": "contacts",
  "expo-calendar": "calendar",
};

/** Why a package's capability was chosen, when the package name alone does not say. */
const CAPABILITY_NOTES: Readonly<Record<string, string>> = {
  camera: "(writes NSCameraUsageDescription and NSMicrophoneUsageDescription, for recordAsync)",
};

/** The capabilities a dependency calls for: its Expo shim's, or its community alias's. */
function packageCapabilities(pkg: string): readonly string[] {
  // Only where the manifest has a shim to carry the calls: an entry for a package whose shim
  // was dropped would otherwise suggest a capability its own web build never reaches.
  const own = Object.hasOwn(EXPO_SHIMS, pkg) ? PACKAGE_CAPABILITIES[pkg] : undefined;
  if (own !== undefined) return typeof own === "string" ? [own] : own;
  return Object.hasOwn(COMMUNITY_ALIASES, pkg) ? COMMUNITY_ALIASES[pkg].capabilities ?? [] : [];
}

/**
 * The Expo APIs an app's source calls that a dependency alone does not reveal:
 * `expo-notifications`' local scheduling (`scheduleNotificationAsync`, …) needs the
 * `local-notifications` capability as well as `push`.
 */
export interface ExpoApiUsage {
  /** The app schedules or presents local notifications. */
  readonly localNotifications: boolean;
}

/** The calls that mean local notifications. */
const LOCAL_NOTIFICATION_CALLS =
  /\b(?:scheduleNotificationAsync|presentNotificationAsync|getAllScheduledNotificationsAsync|cancelScheduledNotificationAsync)\b/;

/** Source files the usage scan reads. */
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/** How many source files the usage scan reads at most (a large monorepo stops early). */
const MAX_SCANNED_FILES = 4000;

/**
 * Scan the app's own source (not `node_modules`, dot folders or native projects) for the
 * calls in {@linkcode ExpoApiUsage}. Only reads files; nothing runs.
 *
 * @param dir The app directory.
 */
export async function expoApiUsage(dir: string): Promise<ExpoApiUsage> {
  for await (const path of appSourceFiles(dir)) {
    const text = await Deno.readTextFile(path).catch(() => "");
    if (LOCAL_NOTIFICATION_CALLS.test(text)) return { localNotifications: true };
  }
  return { localNotifications: false };
}

/** Folders the usage scan skips: dependencies, native projects and build output. */
const SKIPPED_FOLDERS = new Set(["node_modules", "ios", "android", "dist", "out", "build"]);

/** A folder's entries, or none when it cannot be read. */
async function readFolder(path: string): Promise<Deno.DirEntry[]> {
  try {
    return await Array.fromAsync(Deno.readDir(path));
  } catch {
    return [];
  }
}

/**
 * The app's own source files under `dir` (not `node_modules`, dot folders, native projects or
 * build output; not `.d.ts`), at most {@linkcode MAX_SCANNED_FILES}.
 */
async function* appSourceFiles(dir: string): AsyncGenerator<string> {
  const pending = [dir];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readFolder(current)) {
      const kind = sourceEntryKind(entry);
      if (kind === "folder") pending.push(join(current, entry.name));
      else if (kind === "file") {
        if (++count > MAX_SCANNED_FILES) return;
        yield join(current, entry.name);
      }
    }
  }
}

/** Whether the usage scan descends into `entry`, reads it, or skips it. */
function sourceEntryKind(entry: Deno.DirEntry): "folder" | "file" | "skip" {
  if (entry.name.startsWith(".") || SKIPPED_FOLDERS.has(entry.name)) return "skip";
  if (entry.isDirectory) return "folder";
  return SOURCE_FILE.test(entry.name) && !entry.name.endsWith(".d.ts") ? "file" : "skip";
}

/** iOS usage strings a capability writes itself (key → capability). */
const PLIST_CAPABILITIES: Readonly<Record<string, string>> = {
  NSCameraUsageDescription: "camera",
  NSPhotoLibraryUsageDescription: "camera",
  NSPhotoLibraryAddUsageDescription: "camera",
};

/** Android permissions a capability declares itself (permission → capability). */
const PERMISSION_CAPABILITIES: Readonly<Record<string, string>> = {
  "android.permission.CAMERA": "camera",
  "android.permission.POST_NOTIFICATIONS": "push",
  "android.permission.ACCESS_NETWORK_STATE": "network",
  "android.permission.VIBRATE": "haptics",
};

/** What `denext mobile add` should install, and what it cannot carry over. */
export interface MobilePlan {
  /** Capabilities, in `MOBILE_CAPABILITIES` order, with the first reason each was chosen. */
  capabilities: CapabilitySuggestion[];
  /** `--scheme` values (deep-links, auth-session). */
  schemes: string[];
  /** `--domain` values (deep-links). */
  domains: string[];
  /** The full command. */
  command: string | null;
  /** iOS usage strings no capability writes: copy them into ios/App/App/Info.plist. */
  manualPlist: Record<string, string | null>;
  /** Android permissions no capability declares: add them to AndroidManifest.xml. */
  manualPermissions: string[];
  /**
   * Config plugins whose native settings nothing carries over (no capability, usage strings or
   * build settings of theirs are mapped, and they are not web-only), each with what to do.
   */
  unmappedPlugins: { plugin: string; note: string }[];
}

/**
 * Config plugins with nothing to carry into the Capacitor shell, and why: the WebView does
 * their job, or a denext command replaces them.
 */
const NATIVE_FREE_PLUGINS: Readonly<Record<string, string>> = {
  "expo-router": "routing runs in the page",
  "expo-font": "fonts load in the page (the web build's @font-face)",
  "expo-asset": "assets are files of the export",
  "expo-dev-client": "development builds are `denext mobile dev`",
  "expo-web-browser": "the in-app browser is the browser capability",
  "expo-splash-screen": "icons and splash come from `denext mobile assets`",
  "expo-system-ui": "the root background is the page's",
  "expo-localization": "locales come from the WebView",
  "expo-updates": "over-the-air updates are denext OTA (`denext mobile add-ota`)",
  "expo-build-properties": "its settings are carried by `denext mobile add app-config`",
  "expo-sqlite": "the sqlite capability",
  "expo-audio": "playback and recording run in the page",
  "expo-image-picker": "the camera capability",
  "expo-document-picker": "the document-picker capability",
  "expo-media-library": "the media-library capability",
  "expo-secure-store": "the secure-store capability",
  "expo-tracking-transparency": "the tracking capability",
};

/** Whether a config plugin's native settings are carried (a capability, its strings, the page). */
function pluginCarried(plugin: string): boolean {
  return Object.hasOwn(NATIVE_FREE_PLUGINS, plugin) ||
    Object.hasOwn(PLUGIN_USAGE_STRINGS, plugin) ||
    packageCapabilities(plugin).length > 0;
}

/** Whether the app config has native settings `mobile add app-config` writes. */
function appConfigToCarry(
  manualPlist: Record<string, string | null>,
  manualPermissions: readonly string[],
  build: ExpoBuildProperties | undefined,
): string | null {
  const parts: string[] = [];
  if (Object.values(manualPlist).some((v) => v !== null)) parts.push("iOS usage strings");
  if (manualPermissions.length > 0) parts.push("Android permissions");
  if (
    build && (build.iosDeploymentTarget || build.androidMinSdk || build.androidCompileSdk ||
      build.androidTargetSdk || build.usesCleartextTraffic !== undefined)
  ) {
    parts.push("expo-build-properties");
  }
  return parts.length > 0 ? `app config: ${parts.join(", ")}` : null;
}

/** Expo's Android permission shorthands that are not permissions of their own. */
const IGNORED_PERMISSIONS = new Set(["android.permission.INTERNET"]);

/**
 * The capability plan for an app's packages and config.
 *
 * @param deps The app's dependencies (name → version spec).
 * @param config The app config.
 * @param usage What the app's source calls ({@linkcode expoApiUsage}); by default nothing
 *   beyond what the packages imply.
 */
export function expoMobilePlan(
  deps: Record<string, string>,
  config: ExpoAppConfig,
  usage: ExpoApiUsage = { localNotifications: false },
): MobilePlan {
  const chosen = new Map<string, string>();
  const add = (capability: string | undefined, because: string) => {
    if (capability && Object.hasOwn(MOBILE_CAPABILITIES, capability) && !chosen.has(capability)) {
      const note = CAPABILITY_NOTES[capability];
      chosen.set(capability, note ? `${because} ${note}` : because);
    }
  };
  for (const pkg of Object.keys(deps).sort()) {
    for (const capability of packageCapabilities(pkg)) add(capability, pkg);
  }
  for (const plugin of config.plugins) {
    for (const capability of packageCapabilities(plugin)) {
      add(capability, `config plugin ${plugin}`);
    }
  }
  if (usage.localNotifications && "expo-notifications" in deps) {
    add("local-notifications", "expo-notifications scheduleNotificationAsync (local)");
  }
  const manualPlist = plistCapabilities(config.infoPlist, add);
  const manualPermissions = permissionCapabilities(config.androidPermissions, add);
  const carry = appConfigToCarry(manualPlist, manualPermissions, config.buildProperties);
  if (carry) add("app-config", carry);
  if (config.schemes.length > 0) add("deep-links", `scheme ${config.schemes.join(", ")}`);
  if (config.linkDomains.length > 0) add("deep-links", "ios.associatedDomains applinks");
  const order = Object.keys(MOBILE_CAPABILITIES);
  const capabilities = [...chosen].map(([capability, because]) => ({ capability, because }))
    .sort((a, b) => order.indexOf(a.capability) - order.indexOf(b.capability));
  const schemes = schemeArgs(chosen, config);
  const domains = chosen.has("deep-links") ? config.linkDomains : [];
  const command = capabilities.length === 0 ? null : [
    "denext mobile add",
    ...capabilities.map((c) => c.capability),
    ...schemes.map((s) => `--scheme ${s}`),
    ...domains.map((d) => `--domain ${d}`),
  ].join(" ");
  const unmappedPlugins = config.plugins.filter((p) => !pluginCarried(p)).map((plugin) => ({
    plugin,
    note: "its native settings are not carried over; set them in ios/ and android/ by hand",
  }));
  return {
    capabilities,
    schemes,
    domains,
    command,
    manualPlist,
    manualPermissions,
    unmappedPlugins,
  };
}

/**
 * The capabilities the app's usage strings call for, and the strings to carry over by hand:
 * every one the app sets, since `mobile add` writes only its own capabilities' keys, and only
 * a default when the key is absent (the app's text wins).
 */
function plistCapabilities(
  infoPlist: Record<string, string | null>,
  add: (capability: string | undefined, because: string) => void,
): Record<string, string | null> {
  const manual: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(infoPlist)) {
    if (!/UsageDescription$/.test(key)) continue;
    add(PLIST_CAPABILITIES[key], `ios.infoPlist ${key}`);
    manual[key] = value;
  }
  return manual;
}

/** The capabilities the app's Android permissions call for, and the permissions left over. */
function permissionCapabilities(
  permissions: string[],
  add: (capability: string | undefined, because: string) => void,
): string[] {
  const manual: string[] = [];
  for (const permission of permissions) {
    const cap = PERMISSION_CAPABILITIES[permission];
    if (cap) add(cap, `android.permissions ${permission.replace("android.permission.", "")}`);
    else if (!IGNORED_PERMISSIONS.has(permission)) manual.push(permission);
  }
  return manual;
}

/**
 * The `--scheme` values: the config's schemes. auth-session needs a scheme, and deep-links a
 * scheme or a domain: one the config computes in code (or lacks) still has to be passed, so
 * the command then carries a placeholder.
 */
function schemeArgs(chosen: Map<string, string>, config: ExpoAppConfig): string[] {
  if (!chosen.has("deep-links") && !chosen.has("auth-session")) return [];
  if (config.schemes.length > 0) return config.schemes;
  const needsScheme = chosen.has("auth-session") || config.linkDomains.length === 0;
  return needsScheme ? ["<scheme>"] : [];
}

// --- dependencies -------------------------------------------------------------------------

/**
 * What to do instead, for Expo packages with no shim whose own web build does not do the job
 * (so no `denext mobile add` capability would reach them).
 */
const NO_SHIM_ADVICE: Readonly<Record<string, string>> = {
  "expo-task-manager": "its web build defines tasks that never run; move the work to " +
    "background/<name>.ts with denext/mobile's defineBackgroundTask (`denext mobile add " +
    "background`)",
  "expo-background-task": "its web build never schedules; use denext/mobile's " +
    "defineBackgroundTask in background/<name>.ts (`denext mobile add background`)",
  "expo-background-fetch": "its web build never schedules; use denext/mobile's " +
    "defineBackgroundTask in background/<name>.ts (`denext mobile add background`)",
};

/** One `expo-*` / `@expo/*` dependency's standing under denext. */
export interface ExpoPackageStatus {
  readonly name: string;
  /** `full` / `partial` / `stub`: the `denext/expo` shim; `none`: resolves to the real package. */
  readonly status: "full" | "partial" | "stub" | "none";
  /** For a package with no shim that will not work as it is: what to use instead. */
  readonly advice?: string;
  /** Exports the shim does not provide. */
  readonly omitted: number;
  /** Their names, as the manifest lists them (`Asset.byHash`; a subpath shim's prefixed). */
  readonly omittedExports: readonly string[];
  /**
   * The package's subpaths that have shims of their own when the package itself has none
   * (`@expo/ui`: `swift-ui`, `community/masked-view`, …); every other subpath is the real
   * package's.
   */
  readonly subpaths?: readonly string[];
}

/** One community React Native dependency React Native mode aliases to a denext implementation. */
export interface CommunityPackageStatus {
  readonly name: string;
  /** How complete the stand-in is (`COMMUNITY_ALIASES`). */
  readonly status: "full" | "partial" | "stub";
  /** What implements it. */
  readonly implementation: string;
  /** Exports the stand-in does not provide. */
  readonly omitted: number;
}

/** A dependency that needs a native runtime a WebView does not have. */
export interface NativeOnlyPackage {
  readonly name: string;
  /** What makes it native-only (`Nitro module`, `TurboModule / Fabric codegen`, …). */
  readonly kind: string;
}

/** The dependency report. */
export interface ExpoDependencyReport {
  readonly expo: ExpoPackageStatus[];
  /**
   * The community packages React Native mode resolves to denext implementations (not
   * classified as native-only: their native half is replaced).
   */
  readonly community: CommunityPackageStatus[];
  readonly nativeOnly: NativeOnlyPackage[];
  /** Dependencies not installed, so not classified. */
  readonly notInstalled: string[];
}

/** Packages denext provides or that are the app's own toolchain: never native-only here. */
const SKIP_DEPS =
  /^(react|react-dom|react-native|react-native-web|@types\/.*|typescript|expo|expo-.*)$/;

/** Packages whose web build is outside their own tree (react-native-web itself, …). */
const WEB_FIELDS = ["browser"];

/** Where `name` is installed for the app at `dir` (walking up node_modules), or null. */
async function packageDir(dir: string, name: string, spec: string): Promise<string | null> {
  const local = /^(?:file|link):(.+)$/.exec(spec);
  if (local) {
    try {
      return await Deno.realPath(join(dir, local[1]));
    } catch {
      return null;
    }
  }
  let cur = dir;
  for (;;) {
    // pnpm keeps every package it installed, the transitive ones included, in its virtual
    // store's own node_modules.
    for (
      const base of [join(cur, "node_modules"), join(cur, "node_modules", ".pnpm", "node_modules")]
    ) {
      try {
        return await Deno.realPath(join(base, name));
      } catch { /* not here */ }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Whether the package tree carries a web build, searched a few levels deep: a `.web.*` module,
 * or a `.native.*` module with a plain sibling (`threads.native.js` next to `threads.js`: Metro
 * takes the `.native` file on iOS and Android, so the plain one is the web build, as in
 * react-native-worklets).
 */
async function hasWebModule(root: string, depth = 0): Promise<boolean> {
  if (depth > 4) return false;
  const listing = await listDir(root);
  if (!listing) return false;
  for (const name of listing.files) {
    if (/\.web\.[cm]?[jt]sx?$/.test(name)) return true;
    const native = /^(.+)\.native(\.[cm]?[jt]sx?)$/.exec(name);
    if (native && !native[1].endsWith(".d") && listing.files.has(native[1] + native[2])) {
      return true;
    }
  }
  for (const d of listing.dirs) {
    if (await hasWebModule(join(root, d), depth + 1)) return true;
  }
  return false;
}

/** Why the package at `root` is native-only, or null when it is not (or has a web build). */
async function nativeOnlyKind(name: string, root: string): Promise<string | null> {
  const pkg = await readJsonFile(join(root, "package.json")) ?? {};
  const exists = async (rel: string) => {
    try {
      await Deno.stat(join(root, rel));
      return true;
    } catch {
      return false;
    }
  };
  let kind: string | null = null;
  if (/nitro/.test(name) || await exists("nitro.json")) kind = "Nitro module (JSI)";
  else if (pkg.codegenConfig) kind = "TurboModule / Fabric component (codegen)";
  else if (await exists("expo-module.config.json")) {
    const module = await readJsonFile(join(root, "expo-module.config.json"));
    const platforms = Array.isArray(module?.platforms) ? module.platforms as string[] : [];
    if (!platforms.includes("web")) kind = "Expo native module";
  }
  if (!kind) {
    const file = await platformOnlyModule(root);
    return file ? `iOS / Android files only (${file} has no web or plain variant)` : null;
  }
  if (WEB_FIELDS.some((f) => f in pkg) || await hasWebModule(root)) return null;
  return kind;
}

/** Source extensions a platform variant may have. */
const VARIANT_EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs"];

/**
 * The first module (package-relative, extensionless) that exists only as `.ios.*` /
 * `.android.*` variants, with no plain or `.web.*` file beside it — an import of it cannot
 * resolve on the web. Searched a few levels deep; null when there is none.
 */
async function platformOnlyModule(root: string, rel = "", depth = 0): Promise<string | null> {
  if (depth > 5) return null;
  const listing = await listDir(join(root, rel));
  if (!listing) return null;
  const base = platformOnlyBase(listing.files);
  if (base) return rel ? `${rel}/${base}` : base;
  for (const d of listing.dirs) {
    const hit = await platformOnlyModule(root, rel ? `${rel}/${d}` : d, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** A folder's file names and its sub-folders (not `node_modules` or dot folders), or null. */
async function listDir(path: string): Promise<{ files: Set<string>; dirs: string[] } | null> {
  const files = new Set<string>();
  const dirs: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isFile) files.add(entry.name);
      else if (entry.isDirectory && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        dirs.push(entry.name);
      }
    }
  } catch {
    return null;
  }
  return { files, dirs };
}

/** The first module among `files` that exists only as `.ios.*` / `.android.*`, or null. */
function platformOnlyBase(files: Set<string>): string | null {
  for (const name of files) {
    const m = /^(.+)\.(?:ios|android)\.[cm]?[jt]sx?$/.exec(name);
    if (!m || m[1].endsWith(".d")) continue;
    const base = m[1];
    const other = VARIANT_EXTS.some((ext) =>
      files.has(base + ext) || files.has(`${base}.web${ext}`)
    );
    if (!other) return base;
  }
  return null;
}

/**
 * The `expo-*` packages' shim status and the native-only packages among the app's
 * dependencies.
 *
 * @param dir The app directory.
 * @param deps Its dependencies (name → version spec).
 */
export async function expoDependencyReport(
  dir: string,
  deps: Record<string, string>,
): Promise<ExpoDependencyReport> {
  const expo: ExpoPackageStatus[] = [];
  const community: CommunityPackageStatus[] = [];
  const nativeOnly: NativeOnlyPackage[] = [];
  const notInstalled: string[] = [];
  for (const [name, spec] of Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))) {
    const expoStatus = expoPackageStatus(name);
    if (expoStatus) {
      expo.push(expoStatus);
      continue;
    }
    if (Object.hasOwn(COMMUNITY_ALIASES, name)) {
      const alias = COMMUNITY_ALIASES[name];
      community.push({
        name,
        status: alias.status,
        implementation: alias.implementation,
        omitted: alias.omitted?.length ?? 0,
      });
      continue;
    }
    if (SKIP_DEPS.test(name)) continue;
    const root = await packageDir(dir, name, spec);
    if (!root) {
      notInstalled.push(name);
      continue;
    }
    const kind = await nativeOnlyKind(name, root);
    if (kind) nativeOnly.push({ name, kind });
  }
  return { expo, community, nativeOnly, notInstalled };
}

/**
 * The shim standing of an Expo dependency, or null when `name` is not one: `expo` and every
 * `expo-*` package, and an `@expo/*` package the manifest shims (itself or some of its
 * subpaths — `@expo/ui`'s `swift-ui`, `community/masked-view`, …). Other `@expo/*` packages
 * (`@expo/vector-icons`, the tooling) are ordinary dependencies.
 */
function expoPackageStatus(name: string): ExpoPackageStatus | null {
  const own = Object.hasOwn(EXPO_SHIMS, name) ? EXPO_SHIMS[name] : undefined;
  if (/^expo(-|$)/.test(name)) {
    if (!own) {
      const advice = NO_SHIM_ADVICE[name];
      return {
        name,
        status: "none",
        omitted: 0,
        omittedExports: [],
        ...(advice ? { advice } : {}),
      };
    }
    return { name, ...shimStanding(name, [name]) };
  }
  if (!name.startsWith("@expo/")) return null;
  const subKeys = Object.keys(EXPO_SHIMS).filter((key) => key.startsWith(`${name}/`));
  if (!own && subKeys.length === 0) return null;
  const standing = shimStanding(name, own ? [name, ...subKeys] : subKeys);
  if (own) return { name, ...standing };
  return {
    name,
    ...standing,
    status: "partial",
    subpaths: subKeys.map((key) => key.slice(name.length + 1)).sort(),
  };
}

/**
 * What the report says of `keys`' shims, read from the manifest (so the two cannot drift): the
 * package's own status, except that a shim the manifest lists omitted exports for is never
 * reported `full`; and every omitted export by name (a subpath shim's prefixed with the subpath).
 */
function shimStanding(
  name: string,
  keys: readonly string[],
): Pick<ExpoPackageStatus, "status" | "omitted" | "omittedExports"> {
  const omittedExports = keys.flatMap((key) => {
    const prefix = key === name ? "" : `${key.slice(name.length + 1)}: `;
    return (EXPO_SHIMS[key].omitted ?? []).map((exp) => prefix + exp);
  });
  const declared = keys.includes(name) ? EXPO_SHIMS[name].status : "partial";
  const status = declared === "full" && omittedExports.length > 0 ? "partial" : declared;
  return { status, omitted: omittedExports.length, omittedExports };
}

// --- the Metro config ---------------------------------------------------------------------

/** What the app's Metro config does to module resolution that the denext build does not. */
export interface MetroResolution {
  /** The config file, or null when the app has none. */
  file: string | null;
  /** `resolver.extraNodeModules` names that are not installed packages (Metro-only modules). */
  extraModules: string[];
  /** The config sets a custom `resolveRequest`. */
  resolveRequest: boolean;
}

/** The Metro config files, in the order Expo's CLI looks for them. */
const METRO_CONFIG_FILES = ["metro.config.js", "metro.config.cjs", "metro.config.ts"];

/** Every property named `name` in an AST (a shallow generic walk). */
function propertiesNamed(node: Node, name: string, out: Node[] = []): Node[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) propertiesNamed(child, name, out);
    return out;
  }
  const key = node.type === "KeyValueProperty" || node.type === "MethodProperty" ? node.key : null;
  if (key && (key.type === "Identifier" || key.type === "StringLiteral") && key.value === name) {
    out.push(node);
  }
  for (const [k, child] of Object.entries(node)) {
    if (k !== "span" && child && typeof child === "object") propertiesNamed(child, name, out);
  }
  return out;
}

/**
 * The resolution the app's Metro config adds, read statically (never run): the
 * `extraNodeModules` names that no installed package provides, and whether it sets a custom
 * `resolveRequest`. Each such module needs a mapping of its own in `deno.json` `imports`.
 *
 * @param dir The app directory.
 * @param deps The app's dependencies (name → version spec).
 */
export async function readMetroResolution(
  dir: string,
  deps: Record<string, string>,
): Promise<MetroResolution> {
  for (const file of METRO_CONFIG_FILES) {
    const source = await Deno.readTextFile(join(dir, file)).catch(() => null);
    if (source === null) continue;
    const ast = await swcParse().then((parse) => parse(source)).catch(() => null);
    if (!ast) return { file, extraModules: [], resolveRequest: false };
    const extraModules: string[] = [];
    for (const name of extraNodeModuleNames(ast)) {
      if (!(await packageDir(dir, name, deps[name] ?? ""))) extraModules.push(name);
    }
    const resolveRequest = propertiesNamed(ast, "resolveRequest").length > 0;
    return { file, extraModules, resolveRequest };
  }
  return { file: null, extraModules: [], resolveRequest: false };
}

/** The literal keys of every `extraNodeModules` object in a Metro config, sorted. */
function extraNodeModuleNames(ast: Node): string[] {
  const names = new Set<string>();
  for (const prop of propertiesNamed(ast, "extraNodeModules")) {
    for (const member of unwrap(prop.value).properties ?? []) {
      const key = member.key;
      if (key?.type === "StringLiteral" || key?.type === "Identifier") names.add(key.value);
    }
  }
  return [...names].sort();
}

// --- generated files ----------------------------------------------------------------------

/** A reverse-DNS id segment from free text (`"T3 Code"` → `"t3code"`). */
function idSegment(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(s) ? s : `app${s}`;
}

/** The Capacitor app id and name for the app. */
export function capacitorIdentity(
  config: ExpoAppConfig,
  fallbackName: string,
): { appId: string; appName: string; placeholderId: boolean } {
  const appName = config.name ?? config.slug ?? fallbackName;
  const id = config.iosBundleIdentifier ?? config.androidPackage;
  if (id) return { appId: id, appName, placeholderId: false };
  return {
    appId: `com.example.${idSegment(config.slug ?? appName)}`,
    appName,
    placeholderId: true,
  };
}

/**
 * The generated `capacitor.config.ts`: the app's id and name, the static export as the web
 * directory.
 *
 * @param marker The migrate marker comment line.
 * @param identity The app id and name.
 */
export function capacitorConfigSource(
  marker: string,
  identity: { appId: string; appName: string; placeholderId: boolean },
): string {
  const todo = identity.placeholderId
    ? "  // TODO: a placeholder — the app config's bundle identifier could not be read.\n"
    : "";
  return `${marker}
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
${todo}  appId: ${JSON.stringify(identity.appId)},
  appName: ${JSON.stringify(identity.appName)},
  // denext's static export (\`deno task export\`) writes here; Capacitor bundles it.
  webDir: "out",
};

export default config;
`;
}

/** The Capacitor release the shell targets (Capacitor 8, as every `mobile add` plugin). */
const CAPACITOR_VERSION = "^8.5.2";

/** The `mobile:*` tasks, as `denext create --capacitor` writes them. */
export function capacitorTasks(cli: string): Record<string, string> {
  const cap = `deno run -A --node-modules-dir npm:@capacitor/cli@${CAPACITOR_VERSION}`;
  return {
    "mobile:sync": `deno task export && deno run -A ${cli} ota manifest out && ${cap} sync`,
    "mobile:ios": `${cap} open ios`,
    "mobile:android": `${cap} open android`,
  };
}

/**
 * A `<script>` setting `globalThis.__DENEXT_EXPO_CONFIG__` (what `expo-constants` reads) to
 * the config's static runtime subset, safe inside HTML.
 *
 * @param runtimeConfig The subset ({@linkcode ExpoAppConfig.runtimeConfig}).
 */
export function expoConfigScript(runtimeConfig: Record<string, unknown>): string {
  const json = JSON.stringify(runtimeConfig).replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<script>globalThis.__DENEXT_EXPO_CONFIG__=${json}</script>`;
}

/** Folders Expo's prebuild writes that a Capacitor shell would also claim. */
export async function prebuildFolders(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of ["ios", "android"]) {
    try {
      if ((await Deno.stat(join(dir, name))).isDirectory) found.push(name);
    } catch { /* absent */ }
  }
  return found;
}
