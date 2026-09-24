// `denext mobile add <capability...>`: install the Capacitor plugins behind denext/mobile's
// capability functions (haptic(), share(), secureStore, …) into an existing Capacitor project.
// It finds the project (the folder holding capacitor.config.*), refuses when the installed
// @capacitor/core major is not the one the pinned plugins target, adds the npm packages with
// the project's own package manager, writes any Info.plist keys and Android permissions the
// capability needs, and runs `npx cap sync`. A capability that takes options (deep-links:
// --scheme / --domain) or needs more than plist keys and permissions (push: entitlements and
// AppDelegate forwarding) computes its edits in a `configure` hook. A capability with no npm
// package (auth-session) installs denext's own native plugin templates instead, through the
// hook's `install` step; with no package to add, neither the install nor `cap sync` runs. Every
// subprocess goes through a runner the caller passes in, so tests never spawn a real install.

import { dirname, join, relative, resolve } from "@std/path";
import {
  EMPTY_ENTITLEMENTS,
  withAppDelegatePushForwarding,
  withManifestIntentFilter,
  withManifestPermission,
  withPlistDefault,
  withPlistString,
  withPlistStringArray,
  withPlistUrlScheme,
} from "./mobile-native-config.ts";
import { addAuthSessionToProject } from "./mobile-auth-session-install.ts";
import type { NativeInstallOptions, NativeInstallReport } from "./mobile-native-install.ts";

/** The options on `denext mobile add`'s command line that a capability may take. */
export interface CapabilityOptions {
  /** `--scheme`: custom URL schemes (deep-links). */
  readonly schemes: readonly string[];
  /** `--domain`: universal link / app link domains (deep-links). */
  readonly domains: readonly string[];
}

/** One text edit to a native file, with the line the plan prints for it. */
export interface NativeEdit {
  /** What it adds, for the plan (`CFBundleURLTypes: myapp`). */
  readonly label: string;
  /** The edited text, the same text when already there, or null when it has no place to go. */
  readonly apply: (text: string) => string | null;
}

/** A native install step: denext's own plugin templates written into the project. */
export interface NativeInstallStep {
  /** What it installs, for the plan. */
  readonly label: string;
  /** Writes the files; `dir` is the project root. */
  readonly run: (opts: NativeInstallOptions) => Promise<NativeInstallReport>;
}

/** Native config a capability computes from the command-line options. */
export interface CapabilityConfig {
  /** denext's own native plugin, installed from its templates (no npm package). */
  readonly install?: NativeInstallStep;
  /** Edits to ios/App/App/Info.plist. */
  readonly infoPlist?: readonly NativeEdit[];
  /** Edits to the app's entitlements file (created when absent). */
  readonly entitlements?: readonly NativeEdit[];
  /** Edits to android/app/src/main/AndroidManifest.xml. */
  readonly manifest?: readonly NativeEdit[];
  /** Edits to ios/App/App/AppDelegate.swift. */
  readonly appDelegate?: readonly NativeEdit[];
  /** Project-relative files the capability needs at runtime, each with the warning printed when missing. */
  readonly requiredFiles?: Readonly<Record<string, string>>;
  /** Steps `denext mobile add` cannot do, printed after the run. */
  readonly manual?: readonly string[];
}

/**
 * One capability: the npm package behind it and the native config it needs. One without `npm`
 * installs denext's own native plugin through its `configure` hook's `install` step.
 */
export interface MobileCapability {
  /** The npm package that provides the native plugin (none: denext's own plugin). */
  readonly npm?: string;
  /** The version range added (`<npm>@<version>`), pinned to the plugin's Capacitor major. */
  readonly version?: string;
  /** The `@capacitor/core` major the pinned plugin (or denext's plugin template) targets. */
  readonly capacitorMajor: number;
  /** Info.plist string keys to add when absent (key → default value; an app's own wins). */
  readonly iosPlist?: Readonly<Record<string, string>>;
  /** Android permissions to declare in AndroidManifest.xml (full names). */
  readonly androidPermissions?: readonly string[];
  /** A one-line note printed with the plan. */
  readonly notes?: string;
  /** The {@linkcode CapabilityOptions} it takes (others are refused when it is the only one). */
  readonly options?: readonly (keyof CapabilityOptions)[];
  /** Native config computed from the options; throws for options it cannot use. */
  readonly configure?: (options: CapabilityOptions) => CapabilityConfig;
}

/** The Capacitor major every pinned plugin below targets. */
const CAPACITOR_MAJOR = 8;

/** Schemes that are not an app's own (the web, the OS, Capacitor's webview origin). */
const RESERVED_SCHEMES = [
  "http",
  "https",
  "file",
  "content",
  "javascript",
  "data",
  "blob",
  "about",
  "mailto",
  "tel",
  "sms",
  "intent",
  "capacitor",
];

/** A custom scheme, checked: lower-case (Android matches schemes case-sensitively). */
function checkScheme(scheme: string): string {
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
    throw new Error(
      `--scheme ${scheme}: a scheme is lower-case letters, digits, "+", "-" or "." after a ` +
        `letter, with no "://" (e.g. --scheme myapp).`,
    );
  }
  if (RESERVED_SCHEMES.includes(scheme)) {
    throw new Error(`--scheme ${scheme}: not an app scheme (use --domain for https links).`);
  }
  return scheme;
}

/** A universal link / app link domain, checked: a host name, optionally `*.`-prefixed. */
function checkDomain(domain: string): string {
  const host = domain.toLowerCase();
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    throw new Error(
      `--domain ${domain}: pass a host name such as app.example.com (no scheme or path).`,
    );
  }
  return host;
}

/** A custom URL scheme's registration: an Info.plist URL type and a VIEW intent filter. */
function schemeEdits(
  schemes: readonly string[],
): { infoPlist: NativeEdit[]; manifest: NativeEdit[] } {
  return {
    infoPlist: schemes.map((scheme) => ({
      label: `CFBundleURLTypes: ${scheme}`,
      apply: (text) => withPlistUrlScheme(text, scheme),
    })),
    manifest: schemes.map((scheme) => ({
      label: `intent-filter ${scheme}://`,
      apply: (text: string) => withManifestIntentFilter(text, { scheme }),
    })),
  };
}

/** `deep-links`: URL types, intent filters and associated domains for the options. */
function configureDeepLinks(options: CapabilityOptions): CapabilityConfig {
  const schemes = options.schemes.map(checkScheme);
  const domains = options.domains.map(checkDomain);
  if (schemes.length === 0 && domains.length === 0) {
    throw new Error(
      "deep-links needs --scheme <scheme> (a custom URL scheme) and/or --domain <host> " +
        "(universal links / app links); several are comma-separated.",
    );
  }
  const applinks = domains.map((d) => `applinks:${d}`);
  const registered = schemeEdits(schemes);
  return {
    infoPlist: registered.infoPlist,
    manifest: [
      ...registered.manifest,
      ...domains.map((host) => ({
        label: `intent-filter https://${host} (autoVerify)`,
        apply: (text: string) => withManifestIntentFilter(text, { host }),
      })),
    ],
    entitlements: applinks.length === 0 ? [] : [{
      label: `com.apple.developer.associated-domains: ${applinks.join(", ")}`,
      apply: (text) =>
        withPlistStringArray(text, "com.apple.developer.associated-domains", applinks),
    }],
    manual: domains.flatMap((d) => [
      `serve https://${d}/.well-known/apple-app-site-association (applinks for <TEAM ID>.<bundle id>) ` +
      `and https://${d}/.well-known/assetlinks.json (package name + signing certificate SHA-256); ` +
      "without them iOS and Android open the link in the browser instead of the app",
    ]).concat(
      domains.length === 0 ? [] : [
        `https links reach onDeepLink only when listed: accept: { hosts: [${
          domains.map((d) => `"${d}"`).join(", ")
        }] }`,
      ],
    ),
  };
}

/**
 * `auth-session`: denext's `DenextAuthSession` plugin, plus the callback scheme's registration
 * (the same URL type and intent filter as deep-links) for each `--scheme`. Android needs that
 * intent filter to receive the redirect; iOS's ASWebAuthenticationSession needs none.
 */
function configureAuthSession(options: CapabilityOptions): CapabilityConfig {
  const schemes = options.schemes.map(checkScheme);
  return {
    ...schemeEdits(schemes),
    install: {
      label: "DenextAuthSession plugin (iOS ASWebAuthenticationSession, Android Custom Tab) " +
        "+ its registration in DenextBridgeViewController / MainActivity",
      run: addAuthSessionToProject,
    },
    manual: schemes.length > 0 ? [] : [
      "register the OAuth callback scheme unless the app already has it: re-run with " +
      "--scheme <scheme> (or `denext mobile add deep-links --scheme <scheme>`). Android hands " +
      "the redirect to the app only through that scheme's intent filter; iOS needs no registration",
    ],
  };
}

/** `push`: the aps-environment entitlement, AppDelegate forwarding, and FCM's config file. */
function configurePush(): CapabilityConfig {
  return {
    entitlements: [{
      label: "aps-environment: development (when absent)",
      apply: (text) => withPlistString(text, "aps-environment", "development", false),
    }],
    appDelegate: [{
      label: "forward didRegisterForRemoteNotificationsWithDeviceToken / didFail… to Capacitor",
      apply: withAppDelegatePushForwarding,
    }],
    requiredFiles: {
      "android/app/google-services.json":
        "no android/app/google-services.json: registerForPush() fails on Android until you add " +
        "your Firebase project's google-services.json there (FCM needs it).",
    },
    manual: [
      "iOS push needs a paid Apple Developer team with the Push Notifications capability on the " +
      "App ID. aps-environment is `development` (sandbox APNs) for debug builds; an archive " +
      "exported for TestFlight / the App Store is signed with `production`, so send its tokens " +
      "to production APNs",
    ],
  };
}

/**
 * Every capability `denext mobile add` knows, keyed by the name on its command line. Ranges
 * are the plugins' Capacitor 8 majors (each declares `@capacitor/core >=8.0.0`).
 */
export const MOBILE_CAPABILITIES: Readonly<Record<string, MobileCapability>> = {
  haptics: {
    npm: "@capacitor/haptics",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "haptic(kind)",
  },
  clipboard: {
    npm: "@capacitor/clipboard",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "readClipboard() / writeClipboard(text)",
  },
  share: {
    npm: "@capacitor/share",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "share({ title, text, url })",
  },
  device: {
    npm: "@capacitor/device",
    version: "^8.0.3",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "deviceInfo()",
  },
  network: {
    npm: "@capacitor/network",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    androidPermissions: ["android.permission.ACCESS_NETWORK_STATE"],
    notes: "networkStatus() / useNetworkStatus()",
  },
  "keep-awake": {
    npm: "@capacitor-community/keep-awake",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "useKeepAwake(active)",
  },
  splash: {
    npm: "@capacitor/splash-screen",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "hideSplash() (set SplashScreen.launchAutoHide: false in capacitor.config)",
  },
  "secure-store": {
    npm: "@aparajita/capacitor-secure-storage",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "secureStore.get / set / delete (Keychain / Keystore)",
  },
  browser: {
    npm: "@capacitor/browser",
    version: "^8.0.4",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "openExternal(url) in the in-app browser",
  },
  "deep-links": {
    npm: "@capacitor/app",
    version: "^8.1.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "onDeepLink / useDeepLink (pass accept: { hosts } for https links)",
    options: ["schemes", "domains"],
    configure: configureDeepLinks,
  },
  "auth-session": {
    capacitorMajor: CAPACITOR_MAJOR,
    notes:
      "openAuthSession(url, { callbackScheme }) (and completeAuthSession() on a web callback page)",
    options: ["schemes"],
    configure: configureAuthSession,
  },
  push: {
    npm: "@capacitor/push-notifications",
    version: "^8.1.2",
    capacitorMajor: CAPACITOR_MAJOR,
    androidPermissions: ["android.permission.POST_NOTIFICATIONS"],
    notes: "requestPushPermission / registerForPush / onPushReceived / onPushTapped",
    configure: configurePush,
  },
};

/** A package manager `denext mobile add` can drive. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** A subprocess to run: `cmd args…` in `cwd`. */
export interface PlannedCommand {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Runs a {@linkcode PlannedCommand} and resolves its exit code. */
export type CommandRunner = (command: PlannedCommand) => Promise<{ code: number }>;

/** What `denext mobile add` will do, computed without touching anything. */
export interface CapabilityPlan {
  /** The Capacitor project root. */
  readonly root: string;
  /** The capabilities, deduplicated, in command-line order. */
  readonly capabilities: readonly string[];
  /**
   * The detected package manager and where it came from: `lockfile` is the lockfile (or
   * `pnpm-workspace.yaml`) relative to `root`, e.g. `../../pnpm-lock.yaml` in a workspace;
   * `packageManagerField` the `package.json` whose `packageManager` field named it. Neither:
   * npm by default.
   */
  readonly packageManager: PackageManager;
  readonly lockfile?: string;
  readonly packageManagerField?: string;
  /** The `@capacitor/core` major found, and where it was read. */
  readonly capacitorMajor: number;
  readonly capacitorSource: "installed" | "package.json";
  /** The package install, then `cap sync` (neither when no capability has an npm package). */
  readonly install?: PlannedCommand;
  readonly sync?: PlannedCommand;
  /** Info.plist keys to add when absent. */
  readonly plist: ReadonlyArray<{ key: string; value: string }>;
  /** Android permissions to declare. */
  readonly permissions: readonly string[];
  /** Notes for each capability (`name: note`). */
  readonly notes: readonly string[];
  /** Edits from the capabilities' `configure` hooks, per native file. */
  readonly native: NativeEditPlan;
  /** The entitlements files the entitlement edits go to (project-relative). */
  readonly entitlementsFiles: readonly string[];
  /** Problems that do not stop the install but will stop the capability working. */
  readonly warnings: readonly string[];
  /** Steps to do by hand. */
  readonly manual: readonly string[];
}

/** The `configure` edits of every chosen capability, per native file. */
export interface NativeEditPlan {
  readonly infoPlist: readonly NativeEdit[];
  readonly entitlements: readonly NativeEdit[];
  readonly manifest: readonly NativeEdit[];
  readonly appDelegate: readonly NativeEdit[];
  /** denext's own native plugins to install from their templates. */
  readonly installs: readonly NativeInstallStep[];
}

/** What {@linkcode addMobileCapabilities} did, as project-relative paths and notes. */
export interface AddCapabilitiesReport {
  readonly plan: CapabilityPlan;
  /** Native files changed (config files, and denext plugin templates and their wiring). */
  readonly written: string[];
  /** Native files already as they would be written. */
  readonly unchanged: string[];
  /** Platforms or edits skipped, with the reason. */
  readonly skipped: string[];
  /** Steps the native plugin installs could not automate (edited files kept, and the like). */
  readonly manual: string[];
  /** The commands run, each as one line (empty for a dry run). */
  readonly ran: string[];
}

/** Options for {@linkcode planMobileCapabilities} and {@linkcode addMobileCapabilities}. */
export interface AddCapabilitiesOptions {
  /** The capability names from the command line. */
  readonly capabilities: readonly string[];
  /** The working directory: the project when `dir` is absent, and what `dir` resolves against. */
  readonly cwd: string;
  /** `--dir`: the Capacitor project. When given it is the only place looked (no `cwd` fallback). */
  readonly dir?: string;
  /** Plan only: print it, change nothing, run nothing. */
  readonly dryRun?: boolean;
  /** Runs the install and sync (required unless `dryRun`). */
  readonly run?: CommandRunner;
  /** The capability table (tests); defaults to {@linkcode MOBILE_CAPABILITIES}. */
  readonly table?: Readonly<Record<string, MobileCapability>>;
  /** `--scheme`: custom URL schemes (deep-links). */
  readonly schemes?: readonly string[];
  /** `--domain`: universal link / app link domains (deep-links). */
  readonly domains?: readonly string[];
  /** `--force`: replace denext plugin templates that were edited (auth-session). */
  readonly force?: boolean;
}

const CAPACITOR_CONFIGS = [
  "capacitor.config.ts",
  "capacitor.config.js",
  "capacitor.config.mjs",
  "capacitor.config.cjs",
  "capacitor.config.json",
];
const INFO_PLIST = "ios/App/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";
const APP_DELEGATE = "ios/App/App/AppDelegate.swift";
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
/** The entitlements file written when the Xcode project names none (SRCROOT is ios/App). */
const DEFAULT_ENTITLEMENTS = "App/App.entitlements";

/** Lockfile → package manager, in detection order. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
];

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return undefined;
    throw err;
  }
}

/** Whether `dir` holds a `capacitor.config.*`. */
async function isCapacitorProject(dir: string): Promise<boolean> {
  for (const name of CAPACITOR_CONFIGS) if (await exists(join(dir, name))) return true;
  return false;
}

/**
 * The project root: `dir` resolved against `cwd` when given, else `cwd`. It must hold a
 * `capacitor.config.*` and a `package.json`. An explicit `dir` never falls back to `cwd`:
 * a mistyped `--dir` would otherwise change whichever project the shell happens to be in.
 */
async function findProject(cwd: string, dir: string | undefined): Promise<string> {
  const root = dir === undefined ? cwd : resolve(cwd, dir);
  if (!(await isCapacitorProject(root))) {
    throw new Error(
      dir === undefined
        ? `no Capacitor project (capacitor.config.*) in ${root}. Pass --dir <the Capacitor project>.`
        : `--dir ${dir}: no Capacitor project (capacitor.config.*) in ${root}.`,
    );
  }
  if (!(await exists(join(root, "package.json")))) {
    throw new Error(`${root} has a capacitor.config but no package.json.`);
  }
  return root;
}

/** The leading major of a version or a range (`8.5.2`, `^8.0.0`, `~8.1`, `>=8`). */
function majorOf(version: string): number | undefined {
  const m = /(\d+)/.exec(version);
  return m ? Number(m[1]) : undefined;
}

/** The `@capacitor/core` major: the installed package first, else package.json's range. */
async function capacitorCore(
  root: string,
): Promise<{ major: number; source: "installed" | "package.json" }> {
  const installed = await readText(
    join(root, "node_modules", "@capacitor", "core", "package.json"),
  );
  const installedMajor = installed === undefined
    ? undefined
    : majorOf(String((JSON.parse(installed) as { version?: unknown }).version ?? ""));
  if (installedMajor !== undefined) return { major: installedMajor, source: "installed" };
  const pkg = JSON.parse(await Deno.readTextFile(join(root, "package.json"))) as Record<
    string,
    Record<string, string> | undefined
  >;
  const range = pkg.dependencies?.["@capacitor/core"] ?? pkg.devDependencies?.["@capacitor/core"];
  const declaredMajor = range === undefined ? undefined : majorOf(range);
  if (declaredMajor === undefined) {
    throw new Error(`${root} does not depend on @capacitor/core (is it a Capacitor project?).`);
  }
  return { major: declaredMajor, source: "package.json" };
}

/** Where the package manager was detected: a lockfile, or a `packageManager` field. */
interface DetectedPackageManager {
  manager: PackageManager;
  lockfile?: string;
  packageManagerField?: string;
}

/** The pnpm workspace marker, a pnpm signal checked after the lockfiles in each folder. */
const PNPM_WORKSPACE = "pnpm-workspace.yaml";

/** The folders from `root` up to the first holding `.git` (inclusive), else the filesystem root. */
async function workspaceAncestors(root: string): Promise<string[]> {
  const dirs: string[] = [];
  for (let dir = root;; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir || await exists(join(dir, ".git"))) return dirs;
  }
}

/** The package manager `dir`'s lockfile (or pnpm-workspace.yaml) names, and that file. */
async function lockfileIn(
  dir: string,
): Promise<{ manager: PackageManager; path: string } | undefined> {
  for (const [lockfile, manager] of LOCKFILES) {
    if (await exists(join(dir, lockfile))) return { manager, path: join(dir, lockfile) };
  }
  if (await exists(join(dir, PNPM_WORKSPACE))) {
    return { manager: "pnpm", path: join(dir, PNPM_WORKSPACE) };
  }
  return undefined;
}

/** The manager `dir/package.json`'s `packageManager` field names (`"pnpm@11.10.0"`). */
async function packageManagerFieldIn(dir: string): Promise<PackageManager | undefined> {
  const text = await readText(join(dir, "package.json"));
  if (text === undefined) return undefined;
  let field: unknown;
  try {
    field = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
  } catch {
    return undefined;
  }
  const m = typeof field === "string" ? /^(npm|pnpm|yarn|bun)@/.exec(field) : null;
  return m ? m[1] as PackageManager : undefined;
}

/**
 * The package manager, walking up from the Capacitor project `root` to the repository root
 * (the first folder holding `.git`) or the filesystem root, so a project inside a workspace
 * (pnpm, yarn, bun, npm) uses the workspace's manager. Precedence: the nearest lockfile
 * (`pnpm-workspace.yaml` counting as pnpm's, after a lockfile in the same folder); then the
 * nearest `package.json` `packageManager` field; then npm.
 */
async function detectPackageManager(root: string): Promise<DetectedPackageManager> {
  const dirs = await workspaceAncestors(root);
  for (const dir of dirs) {
    const found = await lockfileIn(dir);
    if (found) return { manager: found.manager, lockfile: relative(root, found.path) };
  }
  for (const dir of dirs) {
    const manager = await packageManagerFieldIn(dir);
    if (manager) return { manager, packageManagerField: relative(root, join(dir, "package.json")) };
  }
  return { manager: "npm" };
}

/** `manager`'s command to add `specs` as dependencies. */
function addCommand(manager: PackageManager, specs: string[], cwd: string): PlannedCommand {
  const verb = manager === "npm" ? "install" : "add";
  return { cmd: manager, args: [verb, ...specs], cwd };
}

/** The capability names, deduplicated, refusing unknown ones. */
function pickCapabilities(
  names: readonly string[],
  table: Readonly<Record<string, MobileCapability>>,
): string[] {
  if (names.length === 0) {
    throw new Error(`name at least one capability (${Object.keys(table).join(", ")}).`);
  }
  const unknown = names.filter((n) => !Object.hasOwn(table, n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown capability ${unknown.map((n) => `"${n}"`).join(", ")} (known: ${
        Object.keys(table).join(", ")
      }).`,
    );
  }
  return [...new Set(names)];
}

/** The capabilities in `table` that take `key`, for an error message. */
function takersOf(table: Readonly<Record<string, MobileCapability>>, key: keyof CapabilityOptions) {
  const names = Object.keys(table).filter((n) => table[n].options?.includes(key));
  return names.length === 0 ? "no capability" : names.join(", ");
}

/** The command-line options, deduplicated, refusing one that no chosen capability takes. */
function capabilityOptions(
  opts: AddCapabilitiesOptions,
  names: readonly string[],
  table: Readonly<Record<string, MobileCapability>>,
): CapabilityOptions {
  const options: CapabilityOptions = {
    schemes: [...new Set(opts.schemes ?? [])],
    domains: [...new Set(opts.domains ?? [])],
  };
  const flags = [["schemes", "--scheme"], ["domains", "--domain"]] as const;
  for (const [key, flag] of flags) {
    if (options[key].length === 0) continue;
    if (names.some((n) => table[n].options?.includes(key))) continue;
    throw new Error(`${flag} is only for ${takersOf(table, key)}; add it or drop ${flag}.`);
  }
  return options;
}

/** Every chosen capability's `configure` result, merged per native file. */
function configureAll(
  caps: readonly MobileCapability[],
  options: CapabilityOptions,
): { native: NativeEditPlan; requiredFiles: Record<string, string>; manual: string[] } {
  const configs = caps.map((c) => c.configure?.(options) ?? {});
  return {
    native: {
      infoPlist: configs.flatMap((c) => c.infoPlist ?? []),
      entitlements: configs.flatMap((c) => c.entitlements ?? []),
      manifest: configs.flatMap((c) => c.manifest ?? []),
      appDelegate: configs.flatMap((c) => c.appDelegate ?? []),
      installs: configs.flatMap((c) => c.install ? [c.install] : []),
    },
    requiredFiles: Object.assign({}, ...configs.map((c) => c.requiredFiles ?? {})),
    manual: configs.flatMap((c) => c.manual ?? []),
  };
}

/**
 * The entitlements files the Xcode project signs with (its CODE_SIGN_ENTITLEMENTS values,
 * relative to ios/App), and the values that name a build variable this cannot resolve. With
 * none set, `ios/App/App/App.entitlements`, not yet wired.
 */
async function entitlementsTarget(
  root: string,
): Promise<{ files: string[]; wired: boolean; unresolved: string[] }> {
  const pbxproj = await readText(join(root, PBXPROJ)) ?? "";
  const setting = /\bCODE_SIGN_ENTITLEMENTS\s*=\s*("?)([^";\n]+)\1\s*;/g;
  const values = [
    ...new Set(
      [...pbxproj.matchAll(setting)].map((m) => m[2].trim().replace(/^\$\(SRCROOT\)\//, "")),
    ),
  ];
  const unresolved = values.filter((v) => v.includes("$(") || v.startsWith("/"));
  const files = values.filter((v) => !unresolved.includes(v)).map((v) => `ios/App/${v}`);
  if (files.length > 0) return { files, wired: true, unresolved };
  return { files: [`ios/App/${DEFAULT_ENTITLEMENTS}`], wired: false, unresolved };
}

/** The manual steps entitlement edits need: wiring a new file, or editing an unresolved one. */
async function entitlementSteps(
  root: string,
  target: { wired: boolean; unresolved: string[] },
  edits: readonly NativeEdit[],
): Promise<string[]> {
  if (edits.length === 0 || !(await exists(join(root, PBXPROJ)))) return [];
  const labels = edits.map((e) => e.label).join("; ");
  const steps = target.unresolved.map((v) =>
    `the Xcode project also signs with ${v}, which denext cannot resolve: add ${labels} to it`
  );
  if (!target.wired) {
    steps.push(
      `point the App target at ios/App/${DEFAULT_ENTITLEMENTS}: in Xcode, App target → Build ` +
        `Settings → Code Signing Entitlements = ${DEFAULT_ENTITLEMENTS} (Debug and Release), ` +
        "or add the capability under Signing & Capabilities, which sets the same. denext wrote " +
        "the file but does not edit that build setting",
    );
  }
  return steps;
}

/** A warning for each required file that is missing where its platform folder exists. */
async function missingFiles(root: string, required: Record<string, string>): Promise<string[]> {
  const warnings: string[] = [];
  for (const [rel, warning] of Object.entries(required)) {
    if (await exists(join(root, dirname(rel))) && !(await exists(join(root, rel)))) {
      warnings.push(warning);
    }
  }
  return warnings;
}

/**
 * Work out what `denext mobile add` will do, without changing anything: the project root,
 * its package manager, the install and sync commands, and the native config edits. It throws
 * for an unknown capability, a folder without a Capacitor project, and an `@capacitor/core`
 * major other than the one the chosen plugins target.
 *
 * @param opts The capability names and where to look.
 * @returns The plan.
 */
export async function planMobileCapabilities(
  opts: AddCapabilitiesOptions,
): Promise<CapabilityPlan> {
  const table = opts.table ?? MOBILE_CAPABILITIES;
  const names = pickCapabilities(opts.capabilities, table);
  const configured = configureAll(
    names.map((n) => table[n]),
    capabilityOptions(opts, names, table),
  );
  const root = await findProject(opts.cwd, opts.dir);
  const core = await capacitorCore(root);
  const mismatched = names.filter((n) => table[n].capacitorMajor !== core.major);
  if (mismatched.length > 0) {
    const wanted = [...new Set(mismatched.map((n) => table[n].capacitorMajor))].join(" / ");
    throw new Error(
      `@capacitor/core ${core.major} (${
        core.source === "installed" ? "installed" : "from package.json"
      }) does not match Capacitor ${wanted}, which ${
        mismatched.join(", ")
      } targets. Upgrade Capacitor, or install a matching plugin version by hand.`,
    );
  }
  const { manager, lockfile, packageManagerField } = await detectPackageManager(root);
  const caps = names.map((n) => table[n]);
  const specs = caps.flatMap((c) => c.npm ? [`${c.npm}@${c.version}`] : []);
  const target = await entitlementsTarget(root);
  return {
    root,
    capabilities: names,
    packageManager: manager,
    lockfile,
    packageManagerField,
    capacitorMajor: core.major,
    capacitorSource: core.source,
    install: specs.length > 0 ? addCommand(manager, specs, root) : undefined,
    sync: specs.length > 0 ? { cmd: "npx", args: ["cap", "sync"], cwd: root } : undefined,
    plist: caps.flatMap((c) =>
      Object.entries(c.iosPlist ?? {}).map(([key, value]) => ({ key, value }))
    ),
    permissions: [...new Set(caps.flatMap((c) => c.androidPermissions ?? []))],
    notes: names.flatMap((n) => table[n].notes ? [`${n}: ${table[n].notes}`] : []),
    native: configured.native,
    entitlementsFiles: target.files,
    warnings: await missingFiles(root, configured.requiredFiles),
    manual: [
      ...(await entitlementSteps(root, target, configured.native.entitlements)),
      ...configured.manual,
    ],
  };
}

/** One command as a shell-like line. */
function commandLine(command: PlannedCommand): string {
  return [command.cmd, ...command.args].join(" ");
}

/** Where the plan's package manager came from, for the dry-run line. */
function packageManagerSource(plan: CapabilityPlan): string {
  if (plan.lockfile) return plan.lockfile;
  if (plan.packageManagerField) return `packageManager in ${plan.packageManagerField}`;
  return "no lockfile";
}

/**
 * The plan as the lines `denext mobile add --dry-run` prints.
 *
 * @param plan A plan from {@linkcode planMobileCapabilities}.
 * @returns The lines, without a trailing newline.
 */
export function formatCapabilityPlan(plan: CapabilityPlan): string {
  const lines = [
    `  project        ${plan.root}`,
    `  capacitor      @capacitor/core ${plan.capacitorMajor} (${plan.capacitorSource})`,
    `  package mgr    ${plan.packageManager} (${packageManagerSource(plan)})`,
    `  install        ${plan.install ? commandLine(plan.install) : "(no npm package)"}`,
    ...plan.native.installs.map((i) => `  native         ${i.label}`),
    ...plan.plist.map((p) => `  Info.plist     ${p.key} (when absent)`),
    ...plan.native.infoPlist.map((e) => `  Info.plist     ${e.label}`),
    ...plan.native.entitlements.map((e) =>
      `  entitlements   ${e.label} (${plan.entitlementsFiles.join(", ")})`
    ),
    ...plan.native.appDelegate.map((e) => `  AppDelegate    ${e.label}`),
    ...plan.permissions.map((p) => `  manifest       <uses-permission ${p}>`),
    ...plan.native.manifest.map((e) => `  manifest       ${e.label}`),
    ...(plan.sync ? [`  sync           ${commandLine(plan.sync)}`] : []),
    ...plan.warnings.map((w) => `  WARNING        ${w}`),
  ];
  if (plan.manual.length > 0) {
    lines.push("", "  By hand:", ...plan.manual.map((m) => `    - ${m}`));
  }
  if (plan.notes.length > 0) {
    lines.push("", "  Then call from denext/mobile:", ...plan.notes.map((n) => `    - ${n}`));
  }
  return lines.join("\n");
}

/**
 * The capability table as the lines `denext mobile add --list` prints.
 *
 * @param table The table (default {@linkcode MOBILE_CAPABILITIES}).
 * @returns One line per capability: its name, package and range, and what it enables.
 */
export function formatCapabilityTable(
  table: Readonly<Record<string, MobileCapability>> = MOBILE_CAPABILITIES,
): string {
  return Object.entries(table).map(([name, c]) =>
    `  ${name.padEnd(14)}${
      (c.npm ? `${c.npm}@${c.version}` : "(denext native plugin)").padEnd(46)
    }${c.notes ?? ""}`
  ).join("\n");
}

/**
 * Apply `edits` in turn to the file at `rel` under the project root, recording the outcome in
 * `report`. A missing file is skipped, unless `create` gives its initial text and its folder
 * exists.
 */
async function editNative(
  report: AddCapabilitiesReport,
  rel: string,
  edits: readonly NativeEdit[],
  create?: string,
): Promise<void> {
  if (edits.length === 0) return;
  const path = join(report.plan.root, rel);
  const platform = rel.split("/")[0];
  const existing = await readText(path);
  const canCreate = create !== undefined && await exists(dirname(path));
  if (existing === undefined && !canCreate) {
    const hint = await exists(join(report.plan.root, platform))
      ? "add the entries by hand"
      : `run \`npx cap add ${platform}\` first`;
    report.skipped.push(`${platform === "ios" ? "iOS" : "Android"}: no ${rel} (${hint}).`);
    return;
  }
  const text = existing ?? create!;
  let next: string | null = text;
  for (const edit of edits) next = next === null ? null : edit.apply(next);
  if (next === null) {
    const labels = edits.map((e) => e.label).join("; ");
    report.skipped.push(`${rel}: could not add ${labels}; add them by hand.`);
    return;
  }
  if (next === existing) return void report.unchanged.push(rel);
  await Deno.writeTextFile(path, next);
  report.written.push(rel);
}

/** Run `command`, throwing when it exits non-zero. */
async function runChecked(
  run: CommandRunner,
  command: PlannedCommand,
  ran: string[],
): Promise<void> {
  const line = commandLine(command);
  ran.push(line);
  const { code } = await run(command);
  if (code !== 0) throw new Error(`\`${line}\` exited with code ${code}.`);
}

/**
 * Install capabilities into a Capacitor project: plan (see
 * {@linkcode planMobileCapabilities}), then add the packages, install denext's own native
 * plugins (auth-session), write the Info.plist keys, entitlements, AppDelegate forwarding and
 * Android manifest entries the capabilities need, and run `npx cap sync` (only when packages
 * were added). With `dryRun` it only plans.
 *
 * @param opts The capability names, where to look, and the command runner.
 * @returns The plan, the native files changed, and the commands run.
 */
export async function addMobileCapabilities(
  opts: AddCapabilitiesOptions,
): Promise<AddCapabilitiesReport> {
  const plan = await planMobileCapabilities(opts);
  const report: AddCapabilitiesReport = {
    plan,
    written: [],
    unchanged: [],
    skipped: [],
    manual: [],
    ran: [],
  };
  if (opts.dryRun) return report;
  if (!opts.run) throw new Error("addMobileCapabilities: a command runner is required.");
  if (plan.install) await runChecked(opts.run, plan.install, report.ran);
  for (const step of plan.native.installs) {
    const done = await step.run({ dir: plan.root, force: opts.force });
    report.written.push(...done.written);
    report.unchanged.push(...done.unchanged);
    report.skipped.push(...done.skipped);
    report.manual.push(...done.manual);
  }
  const plistDefaults = plan.plist.map((p): NativeEdit => ({
    label: p.key,
    apply: (text) => withPlistDefault(text, p.key, p.value),
  }));
  await editNative(report, INFO_PLIST, [...plistDefaults, ...plan.native.infoPlist]);
  for (const file of plan.entitlementsFiles) {
    await editNative(report, file, plan.native.entitlements, EMPTY_ENTITLEMENTS);
  }
  await editNative(report, APP_DELEGATE, plan.native.appDelegate);
  const permissions = plan.permissions.map((p): NativeEdit => ({
    label: `<uses-permission ${p}>`,
    apply: (text) => withManifestPermission(text, p),
  }));
  await editNative(report, ANDROID_MANIFEST, [...permissions, ...plan.native.manifest]);
  if (plan.sync) await runChecked(opts.run, plan.sync, report.ran);
  return report;
}
