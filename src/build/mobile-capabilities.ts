// `denext mobile add <capability...>`: install the Capacitor plugins behind denext/mobile's
// capability functions (haptic(), share(), secureStore, …) into an existing Capacitor project.
// It finds the project (the folder holding capacitor.config.*), refuses when the installed
// @capacitor/core major is not the one the pinned plugins target, adds the npm packages with
// the project's own package manager, writes any Info.plist keys and Android permissions the
// capability needs, and runs `npx cap sync`. A capability that takes options (deep-links:
// --scheme / --domain) or needs more than plist keys and permissions (push: entitlements and
// AppDelegate forwarding) computes its edits in a `configure` hook. A capability with no npm
// package (auth-session, system-bars, and the app extensions share-extension / widget /
// live-activity) installs denext's own native plugin templates instead, through the
// hook's `install` step; with no package to add, neither the install nor `cap sync` runs. Every
// subprocess goes through a runner the caller passes in, so tests never spawn a real install.

import { dirname, join, resolve } from "@std/path";
import { posixRelative } from "./mobile-paths.ts";
import {
  EMPTY_ENTITLEMENTS,
  withAppDelegatePushForwarding,
  withAppDelegateQuickActions,
  withGradleMinSdk,
  withManifestApplicationAttribute,
  withManifestIntentFilter,
  withManifestPermission,
  withPlistDefault,
  withPlistString,
  withPlistStringArray,
  withPlistTrue,
  withPlistUrlScheme,
  withSceneDelegateQuickActions,
} from "./mobile-native-config.ts";
import { addAuthSessionToProject } from "./mobile-auth-session-install.ts";
import { addBackToProject, addEdgeToEdgeToProject } from "./mobile-system-ui-install.ts";
import { SETTINGS_INSTALL } from "./mobile-settings-install.ts";
import type { NativeInstallOptions, NativeInstallReport } from "./mobile-native-install.ts";
import {
  addLiveActivitiesToProject,
  addShareExtensionToProject,
  addWidgetsToProject,
  checkExtensionNames,
} from "./mobile-app-extensions.ts";
import { parseWidgetParams } from "./widget-native-templates.ts";
import { checkAppGroup } from "./mobile-app-group.ts";
import { applicationTargetName, targetBuildSetting } from "./pbxproj.ts";
import { CAPACITOR_CONFIGS, capacitorConfigFile, readCapacitorConfig } from "./capacitor-config.ts";
import { addOfflineScreenToProject } from "./mobile-offline-screen.ts";
import { privacyEntriesFor, privacyLabels, writePrivacyManifests } from "./mobile-privacy.ts";
import { PLATFORM_CAPABILITIES } from "./mobile-capabilities-platform.ts";
import { NATIVE_MODULE_CAPABILITY } from "./mobile-native-module.ts";
import { NATIVE_VIEW_CAPABILITIES } from "./mobile-native-views-install.ts";
import { FASTLANE_CAPABILITY } from "./mobile-fastlane.ts";

/** The options on `denext mobile add`'s command line that a capability may take. */
export interface CapabilityOptions {
  /** `--scheme`: custom URL schemes (deep-links). */
  readonly schemes: readonly string[];
  /** `--domain`: universal link / app link domains (deep-links). */
  readonly domains: readonly string[];
  /** `--app-group`: the App Group app extensions share with the app (at most one). */
  readonly appGroups: readonly string[];
  /** `--name`: widget / Live Activity names. */
  readonly names: readonly string[];
  /** `--configurable`: a widget's enum parameters (`param:enum=a|b`). */
  readonly configurable: readonly string[];
  /** `--ci`: also write a CI workflow (fastlane). */
  readonly ci?: boolean;
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
  /** Edits to android/variables.gradle (the SDK levels). */
  readonly variablesGradle?: readonly NativeEdit[];
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
  /** What `--list` shows in the package column without `npm` (default: denext native plugin). */
  readonly listing?: string;
  /**
   * The version range added (`<npm>@<version>`), pinned to the plugin's Capacitor major. A
   * project that pins its `@capacitor/*` packages exactly gets the range's minimum, exactly.
   */
  readonly version?: string;
  /**
   * More packages added with it, as full specs (`@sentry/browser@10.69.0`): a sibling SDK the
   * plugin's own package pins exactly.
   */
  readonly peers?: readonly string[];
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
      "without them iOS and Android open the link in the browser instead of the app. When " +
      `${d} is served by denext, add to its denext.config.ts: appLinks: { apple: { appIds: ` +
      '["<TEAM ID>.<bundle id>"] }, android: { packageName: "<application id>", ' +
      'sha256CertFingerprints: ["<AB:CD:…>"] } } (`denext start` serves both files, and ' +
      "`denext export` writes them)",
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

/**
 * `clerk`: what `denext/mobile/clerk` needs — the `DenextAuthSession` plugin and the OAuth
 * callback scheme's registration (as `auth-session --scheme`), plus the secure-storage plugin for
 * the client JWT (the npm package below) — and the Clerk-side steps.
 */
function configureClerk(options: CapabilityOptions): CapabilityConfig {
  const schemes = options.schemes.map(checkScheme);
  if (schemes.length !== 1) {
    throw new Error(
      "clerk needs exactly one --scheme <scheme>: the custom URL scheme Clerk's OAuth redirects " +
        "back to (<scheme>://app/)",
    );
  }
  const [scheme] = schemes;
  return {
    ...schemeEdits(schemes),
    install: {
      label: "DenextAuthSession plugin (iOS ASWebAuthenticationSession, Android Custom Tab) " +
        "+ its registration in DenextBridgeViewController / MainActivity",
      run: addAuthSessionToProject,
    },
    manual: [
      `call installClerkMobileBridge({ scheme: "${scheme}", nativeClerk: true }) from ` +
      "denext/mobile/clerk before the page loads clerk-js (instrumentation-client.ts in an App " +
      "Router app, the top of a SPA entry)",
      `Clerk dashboard → Native applications → Allowlist for mobile SSO redirect: add ${scheme}://app/`,
      "Clerk instance allowed origins (Backend API PATCH /v1/instance allowed_origins): add " +
      "capacitor://localhost (iOS) and https://localhost (Android), the shell's page origins",
      "passkeys sign in through Clerk's hosted page in the auth session; create them on the web",
    ],
  };
}

/** The one `--app-group`, checked, if given. */
function appGroupOption(options: CapabilityOptions): string | undefined {
  if (options.appGroups.length > 1) throw new Error("--app-group takes one App Group.");
  const group = options.appGroups[0];
  return group === undefined ? undefined : checkAppGroup(group);
}

/**
 * `share-extension`: an iOS Share Extension + Android share target handing shares to
 * onShareReceived. `--scheme` (the first) is the URL scheme the extension opens the app with,
 * registered as deep-links does on iOS; without it the app's own first scheme is used.
 */
function configureShareExtension(options: CapabilityOptions): CapabilityConfig {
  const schemes = options.schemes.map(checkScheme);
  const appGroup = appGroupOption(options);
  return {
    infoPlist: schemeEdits(schemes).infoPlist,
    install: {
      label: "Share Extension target (DenextShareExtension, App Group) + Android SEND intent " +
        "filters + the DenextShareReceive plugin",
      run: (opts) => addShareExtensionToProject({ ...opts, appGroup, scheme: schemes[0] }),
    },
  };
}

/** `widget`: a home-screen widget per `--name` (WidgetKit extension / AppWidgetProvider). */
function configureWidget(options: CapabilityOptions): CapabilityConfig {
  const names = checkExtensionNames(options.names, "widget");
  const appGroup = appGroupOption(options);
  const params = parseWidgetParams(options.configurable);
  const configurable = params.length > 0 ? params : undefined;
  return {
    install: {
      label: `${configurable ? "configurable " : ""}widget${names.length > 1 ? "s" : ""} ` +
        `${names.join(", ")} (iOS WidgetKit extension DenextWidgets, Android ` +
        "AppWidgetProvider) + the DenextWidgets plugin",
      run: (opts) => addWidgetsToProject({ ...opts, appGroup, names, configurable }),
    },
  };
}

/** `live-activity`: an ActivityKit Live Activity UI per `--name` (iOS only). */
function configureLiveActivity(options: CapabilityOptions): CapabilityConfig {
  const names = checkExtensionNames(options.names, "live-activity");
  const appGroup = appGroupOption(options);
  return {
    install: {
      label: `Live Activit${names.length > 1 ? "ies" : "y"} ${names.join(", ")} (iOS 16.1+, in ` +
        "the DenextWidgets extension) + NSSupportsLiveActivities + the DenextLiveActivity plugin",
      run: (opts) => addLiveActivitiesToProject({ ...opts, appGroup, names }),
    },
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

/** Where the iOS delegates live, relative to the project root. */
const IOS_SCENE_DELEGATE = "ios/App/App/SceneDelegate.swift";
const IOS_APP_DELEGATE = "ios/App/App/AppDelegate.swift";

/**
 * `quick-actions`' native step: forward the home-screen quick action to the AppShortcuts
 * plugin from `SceneDelegate.swift` (Capacitor 8's scene template), else from
 * `AppDelegate.swift` (an app without scenes). The plugin's README covers only the latter,
 * which UIKit bypasses once the app has a scene delegate.
 */
async function wireQuickActions({ dir }: NativeInstallOptions): Promise<NativeInstallReport> {
  const report: NativeInstallReport = {
    written: [],
    upgraded: [],
    kept: [],
    unchanged: [],
    manual: [],
    skipped: [],
  };
  const scene = await readText(join(dir, IOS_SCENE_DELEGATE));
  const rel = scene === undefined ? IOS_APP_DELEGATE : IOS_SCENE_DELEGATE;
  const text = scene ?? await readText(join(dir, IOS_APP_DELEGATE));
  if (text === undefined) {
    const hint = await exists(join(dir, "ios")) ? "wire it by hand" : "run `npx cap add ios` first";
    report.skipped.push(`iOS: no ${IOS_SCENE_DELEGATE} or ${IOS_APP_DELEGATE} (${hint}).`);
    return report;
  }
  const next = scene === undefined
    ? withAppDelegateQuickActions(text)
    : withSceneDelegateQuickActions(text);
  if (next === null) {
    report.manual.push(
      `${rel}: forward quick actions to the AppShortcuts plugin by hand (post ` +
        `NSNotification.Name("handleAppShortcutNotification") with userInfo ["shortcutItem": item] ` +
        "from performActionFor, and for the launch item once the bridge has loaded)",
    );
  } else if (next === text) {
    report.unchanged.push(rel);
  } else {
    await Deno.writeTextFile(join(dir, rel), next);
    report.written.push(rel);
  }
  return report;
}

/** `quick-actions`: the iOS delegate forwarding (Android needs none). */
function configureQuickActions(): CapabilityConfig {
  return {
    install: {
      label: "forward quick actions to AppShortcuts in SceneDelegate.swift (AppDelegate.swift " +
        "without scenes), cold start included",
      run: wireQuickActions,
    },
  };
}

/**
 * `barcode`: `@capacitor/barcode-scanner`'s Android library (ionbarcode) declares minSdk 26,
 * above Capacitor 8's default 24, so the manifest merge fails until variables.gradle is raised.
 */
function configureBarcode(): CapabilityConfig {
  return {
    variablesGradle: [{
      label: "minSdkVersion 26 (the scanner's Android library needs it; a higher one is kept)",
      apply: (text) => withGradleMinSdk(text, 26),
    }],
  };
}

/**
 * `camera`: in-page capture. `NSMicrophoneUsageDescription` is always added (when absent):
 * expo-camera's `recordAsync` (and any `getUserMedia({ audio })`) records audio in the WebView,
 * which WKWebView refuses without the string, and an unused usage string costs nothing at
 * review. It is an edit, not one of the table's plist keys, because those are what `mobile
 * doctor --store` requires of every app with the plugin, and a photo-only app needs no
 * microphone. Android's runtime permissions for the WebView's own capture are the app's call
 * (Play asks about RECORD_AUDIO), so they are a printed step.
 */
function configureCamera(): CapabilityConfig {
  return {
    infoPlist: [{
      label: "NSMicrophoneUsageDescription (when absent: video recorded in the page has sound)",
      apply: (text) => withPlistDefault(text, "NSMicrophoneUsageDescription", MICROPHONE_USAGE),
    }],
    manual: [
      "Android: an in-page camera (expo-camera's CameraView, getUserMedia) needs " +
      "android.permission.CAMERA in AndroidManifest.xml, and recording with sound (recordAsync) " +
      "RECORD_AUDIO and MODIFY_AUDIO_SETTINGS too; pickImage() needs neither",
    ],
  };
}

/**
 * `back`: denext's `DenextBack` plugin registered from MainActivity (Android's predictive-back
 * events), and `android:enableOnBackInvokedCallback="true"` on `<application>`, which Android
 * 13–15 need before they route back through the callback (and animate it, 14+); Android 16
 * does it by default for apps targeting SDK 36. `@capacitor/app` (the npm package) is the
 * fallback `onBack` listens to without the plugin, and leaves the app when nothing handles back.
 */
function configureBack(): CapabilityConfig {
  return {
    manifest: [{
      label: 'android:enableOnBackInvokedCallback="true" on <application> (when unset)',
      apply: (text) =>
        withManifestApplicationAttribute(text, "android:enableOnBackInvokedCallback", "true"),
    }],
    install: {
      label: "DenextBack plugin (Android OnBackPressedCallback: predictive-back progress) + its " +
        "registration in MainActivity",
      run: addBackToProject,
    },
  };
}

/**
 * `system-bars`: Capacitor 8 bundles `SystemBars` in `@capacitor/core`, so there is no package.
 * iOS needs `UIViewControllerBasedStatusBarAppearance` (true in Capacitor's template, set here
 * when missing or false); Android gets `EdgeToEdge.enable(this)` in MainActivity.
 */
function configureSystemBars(): CapabilityConfig {
  return {
    infoPlist: [{
      label: "UIViewControllerBasedStatusBarAppearance: true (SystemBars needs it)",
      apply: (text) => withPlistTrue(text, "UIViewControllerBasedStatusBarAppearance"),
    }],
    install: {
      label: "EdgeToEdge.enable(this) in MainActivity (edge to edge on every Android version)",
      run: addEdgeToEdgeToProject,
    },
  };
}

/** `permissions` (and the capabilities that ask for one): the DenextSettings plugin. */
function configureSettings(): CapabilityConfig {
  return { install: SETTINGS_INSTALL };
}

/** `local-notifications`: DenextSettings, plus the Android exact-alarm note. */
function configureLocalNotifications(): CapabilityConfig {
  return {
    install: SETTINGS_INSTALL,
    manual: [
      "Android: the plugin declares SCHEDULE_EXACT_ALARM; Google Play allows it only for " +
      'alarm / calendar apps (else remove it with tools:node="remove" in AndroidManifest.xml ' +
      "and accept inexact delivery). A small monochrome icon for the status bar goes in " +
      "plugins.LocalNotifications.smallIcon in capacitor.config",
    ],
  };
}

/**
 * `social-login`: the Sign in with Apple entitlement, and each `--scheme` (Google's reversed iOS
 * client id, `com.googleusercontent.apps.<id>`) registered as a URL type for the Google SDK's
 * redirect.
 */
function configureSocialLogin(options: CapabilityOptions): CapabilityConfig {
  const schemes = options.schemes.map(checkScheme);
  return {
    infoPlist: schemeEdits(schemes).infoPlist,
    entitlements: [{
      label: "com.apple.developer.applesignin: Default (Sign in with Apple)",
      apply: (text) => withPlistStringArray(text, "com.apple.developer.applesignin", ["Default"]),
    }],
    manual: [
      "capacitor.config: set plugins.SocialLogin.providers to { apple: true, google: true, " +
      "facebook: false, twitter: false } (a disabled provider is not bundled; Facebook's SDK adds " +
      "the AD_ID permission Play asks about)",
      "Apple: enable Sign in with Apple for the App ID (developer.apple.com → Identifiers); the " +
      "server's apple provider lists the bundle id as a client id",
      "Google: create OAuth clients of type iOS (bundle id), Android (package + signing SHA-1) and " +
      "Web application; pass the web and iOS ids to signInWithGoogle and list both in the " +
      "server's google provider",
      ...(schemes.length > 0 ? [] : [
        "Google on iOS: re-run with --scheme com.googleusercontent.apps.<id> (the iOS client id " +
        "reversed) to register its redirect scheme",
      ]),
    ],
  };
}

/** `purchases`: the store-side steps RevenueCat needs. */
function configurePurchasesCapability(): CapabilityConfig {
  return {
    manual: [
      "iOS: add the In-App Purchase capability (Xcode → Signing & Capabilities) and create the " +
      "products in App Store Connect; Android: create them in the Play Console (billing needs an " +
      "uploaded build on a testing track)",
      "RevenueCat: add both apps, map products to entitlements and offerings, copy each app's " +
      "public SDK key into configurePurchases({ apiKey: { ios, android } }), and point a webhook " +
      "at a route that calls verifyRevenueCatWebhook (denext/server)",
      "Digital goods must use in-app purchase (App Store Review Guideline 3.1.1; Google Play " +
      "Payments policy)",
    ],
  };
}

/**
 * `sentry`: crash reporting through `@sentry/capacitor` (native crashes via sentry-cocoa /
 * sentry-android, JS errors via the sibling web SDK). Its 4.4.0 release installs on iOS through
 * Swift Package Manager only (the podspec was removed), which Capacitor 8 projects use.
 */
function configureSentry(): CapabilityConfig {
  return {
    manual: [
      'call initCrashReporting({ dsn, sdk: () => import("@sentry/capacitor"), sibling: () => ' +
      'import("@sentry/browser") }) from denext/mobile once at startup (the release is the OTA ' +
      "UI version, so uploaded source maps match)",
      "export with `denext export --sourcemaps hidden` and upload .denext/sourcemaps with " +
      "sentry-cli (see /docs/mobile#crash-reporting); keep @sentry/capacitor and @sentry/browser " +
      "on the versions installed together (4.4.0 depends on @sentry/browser 10.69.0 exactly)",
      "iOS: @sentry/capacitor 4.4 is Swift Package Manager only; a CocoaPods project (ios/App/" +
      "Podfile) must move to SPM first",
    ],
  };
}

/** `offline-screen`: `public/offline.html` and `server.errorPath` pointing at it. */
function configureOfflineScreen(): CapabilityConfig {
  return {
    install: {
      label: "public/offline.html (the page Capacitor shows when the app cannot load) + " +
        'server.errorPath: "offline.html" in capacitor.config',
      run: addOfflineScreenToProject,
    },
  };
}

/** The camera usage string `camera` and `barcode` share. */
const CAMERA_USAGE = "Take photos and scan codes with the camera.";
/** The microphone usage string `camera` adds (video recording in the WebView records audio). */
const MICROPHONE_USAGE = "Record sound with your videos.";

/**
 * Every capability `denext mobile add` knows, keyed by the name on its command line. Ranges
 * are the plugins' Capacitor 8 releases (each declares `@capacitor/core >=8.0.0`); most follow
 * Capacitor's major, `@capacitor/barcode-scanner` has its own numbering (3.x for Capacitor 8).
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
  clerk: {
    npm: "@aparajita/capacitor-secure-storage",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "installClerkMobileBridge({ scheme, nativeClerk: true }) from denext/mobile/clerk " +
      "(<ClerkProvider> signs in: Keychain / Keystore token cache, OAuth in the auth session)",
    options: ["schemes"],
    configure: configureClerk,
  },
  push: {
    npm: "@capacitor/push-notifications",
    version: "^8.1.2",
    capacitorMajor: CAPACITOR_MAJOR,
    androidPermissions: ["android.permission.POST_NOTIFICATIONS"],
    notes: "requestPushPermission / registerForPush / onPushReceived / onPushTapped",
    configure: configurePush,
  },
  filesystem: {
    npm: "@capacitor/filesystem",
    version: "^8.1.3",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "readFile / writeFile / deleteFile / listDir / downloadToFile (OPFS on the web; " +
      'Android\'s "documents" needs storage permission up to Android 10)',
  },
  camera: {
    npm: "@capacitor/camera",
    version: "^8.2.4",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: {
      NSCameraUsageDescription: CAMERA_USAGE,
      NSPhotoLibraryUsageDescription: "Choose photos from your library.",
      NSPhotoLibraryAddUsageDescription: "Save photos to your library.",
    },
    notes: "pickImage({ source: camera | photos | prompt })",
    configure: configureCamera,
  },
  "document-picker": {
    npm: "@capawesome/capacitor-file-picker",
    version: "^8.1.0",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "pickDocument({ types })",
  },
  barcode: {
    npm: "@capacitor/barcode-scanner",
    version: "^3.1.2",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: { NSCameraUsageDescription: CAMERA_USAGE },
    notes: "scanBarcode({ formats }) (BarcodeDetector on the web; Android minSdk 26)",
    configure: configureBarcode,
  },
  "quick-actions": {
    npm: "@capawesome/capacitor-app-shortcuts",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "setQuickActions([...]) / onQuickAction / useQuickAction",
    configure: configureQuickActions,
  },
  sqlite: {
    npm: "@capacitor-community/sqlite",
    version: "^8.1.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "openSqlite(name) / deleteSqlite(name), and expo-sqlite's async API (the web " +
      "build uses the app's own @sqlite.org/sqlite-wasm)",
  },
  "share-extension": {
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "onShareReceived(cb) / useShareReceived(cb) (iOS Share Extension, Android share " +
      "target; --app-group, --scheme)",
    options: ["schemes", "appGroups"],
    configure: configureShareExtension,
  },
  widget: {
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "setWidgetData(kind, data, { params? }) / reloadWidgets(kind?) (--name <Name>, " +
      "--configurable <param:enum=a|b>, --app-group)",
    options: ["names", "appGroups", "configurable"],
    configure: configureWidget,
  },
  "live-activity": {
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "startLiveActivity / updateLiveActivity / endLiveActivity / liveActivityPushToken / " +
      "liveActivityPushToStartToken (iOS 16.1+, push-to-start 17.2+; --name <Name>)",
    options: ["names", "appGroups"],
    configure: configureLiveActivity,
  },
  keyboard: {
    npm: "@capacitor/keyboard",
    version: "^8.0.5",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "useKeyboard() / onKeyboardChange / <KeyboardAvoidingView> / <KeyboardStickyView> / " +
      "hideKeyboard() / setKeyboardResizeMode(mode) (iOS)",
  },
  back: {
    npm: "@capacitor/app",
    version: "^8.1.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "onBack / useBackHandler / onBackProgress / useBackProgress (Android back button and " +
      "predictive back; iOS has none)",
    configure: configureBack,
  },
  "system-bars": {
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "setSystemBars({ style, hidden, animation, bar }) / useSystemBarsFollowTheme() " +
      "(SystemBars ships in @capacitor/core 8)",
    configure: configureSystemBars,
  },
  dialog: {
    npm: "@capacitor/dialog",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "React Native mode's Alert.alert / Alert.prompt as system dialogs (else an in-page " +
      "dialog)",
  },
  toast: {
    npm: "@capacitor/toast",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "React Native mode's ToastAndroid.show as the system toast on Android (else an " +
      "in-page toast)",
  },
  "action-sheet": {
    npm: "@capacitor/action-sheet",
    version: "^8.1.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "React Native mode's ActionSheetIOS.showActionSheetWithOptions as a native action " +
      "sheet (else a dialog or an in-page menu)",
  },
  permissions: {
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "checkPermission / requestPermission / usePermission (each capability's plugin " +
      "answers) and openAppSettings()",
    configure: configureSettings,
  },
  "local-notifications": {
    npm: "@capacitor/local-notifications",
    version: "^8.3.1",
    capacitorMajor: CAPACITOR_MAJOR,
    androidPermissions: ["android.permission.POST_NOTIFICATIONS"],
    notes: "scheduleNotification / cancelNotification / pendingNotifications / " +
      "createNotificationChannel / setNotificationCategories / onLocalNotificationTapped",
    configure: configureLocalNotifications,
  },
  biometrics: {
    npm: "@aparajita/capacitor-biometric-auth",
    version: "^10.0.0",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: { NSFaceIDUsageDescription: "Unlock the app with Face ID." },
    androidPermissions: ["android.permission.USE_BIOMETRIC"],
    notes: "isBiometricAvailable() / authenticateBiometric({ reason }) / " +
      "secureStore.set(key, value, { requireBiometric: true })",
    configure: configureSettings,
  },
  "social-login": {
    npm: "@capgo/capacitor-social-login",
    version: "^8.5.11",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "signInWithApple() (iOS) / signInWithGoogle({ webClientId, iosClientId }) / " +
      "signInNative(session, provider) (--scheme <Google's reversed iOS client id>)",
    options: ["schemes"],
    configure: configureSocialLogin,
  },
  geolocation: {
    npm: "@capacitor/geolocation",
    version: "^8.2.2",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: { NSLocationWhenInUseUsageDescription: "Show where you are in the app." },
    androidPermissions: [
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
    ],
    notes: "getCurrentPosition() / watchPosition(cb) / useLocation() (foreground only; " +
      "navigator.geolocation on the web)",
    configure: configureSettings,
  },
  purchases: {
    npm: "@revenuecat/purchases-capacitor",
    version: "^13.6.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "configurePurchases / getOfferings / purchasePackage / restorePurchases / " +
      "getCustomerInfo / useEntitlement(id) (RevenueCat; no web fallback)",
    configure: configurePurchasesCapability,
  },
  sentry: {
    npm: "@sentry/capacitor",
    version: "4.4.0",
    peers: ["@sentry/browser@10.69.0"],
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "initCrashReporting({ dsn, sdk, sibling }) (native + JS crashes; release = the OTA UI " +
      "version; hidden source maps with `denext export --sourcemaps hidden`)",
    configure: configureSentry,
  },
  "offline-screen": {
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "installOfflineScreen() (an overlay while the network is gone; server.errorPath shows " +
      "offline.html when the app cannot load)",
    configure: configureOfflineScreen,
  },
  // app-review, app-update, screen-orientation, media-library, privacy-screen, tracking,
  // background, restore: ./mobile-capabilities-platform.ts.
  ...PLATFORM_CAPABILITIES,
  "native-module": NATIVE_MODULE_CAPABILITY,
  ...NATIVE_VIEW_CAPABILITIES,
  // Release tooling, not a plugin: fastlane lanes over `denext mobile build`.
  fastlane: FASTLANE_CAPABILITY,
};

/** A package manager `denext mobile add` can drive. */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "deno";

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
  /**
   * The package install, then `cap sync` (neither when no capability has an npm package), or
   * `cap update` when the web export is not built yet (see `webAssetsMissing`).
   */
  readonly install?: PlannedCommand;
  readonly sync?: PlannedCommand;
  /**
   * The web export folder (capacitor.config `webDir`, project-relative) when it has no
   * `index.html` yet: `cap sync` would fail copying it, so the plan runs `cap update` (the
   * native half of sync) and warns to export and sync afterwards.
   */
  readonly webAssetsMissing?: string;
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
  /** Required-reason / data-use declarations merged into PrivacyInfo.xcprivacy (labels). */
  readonly privacy: readonly string[];
}

/** The `configure` edits of every chosen capability, per native file. */
export interface NativeEditPlan {
  readonly infoPlist: readonly NativeEdit[];
  readonly entitlements: readonly NativeEdit[];
  readonly manifest: readonly NativeEdit[];
  readonly appDelegate: readonly NativeEdit[];
  readonly variablesGradle: readonly NativeEdit[];
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
  /** `--scheme`: custom URL schemes (deep-links, auth-session, share-extension). */
  readonly schemes?: readonly string[];
  /** `--domain`: universal link / app link domains (deep-links). */
  readonly domains?: readonly string[];
  /** `--app-group`: the App Group (share-extension, widget, live-activity). */
  readonly appGroups?: readonly string[];
  /** `--name`: widget / Live Activity names. */
  readonly names?: readonly string[];
  /** `--configurable`: a widget's enum parameters (`param:enum=a|b`, one per item). */
  readonly configurable?: readonly string[];
  /** `--force`: replace denext plugin templates that were edited (auth-session). */
  readonly force?: boolean;
  /** `--ci`: also write a CI workflow (fastlane). */
  readonly ci?: boolean;
}

const INFO_PLIST = "ios/App/App/Info.plist";
const ANDROID_MANIFEST = "android/app/src/main/AndroidManifest.xml";
const APP_DELEGATE = "ios/App/App/AppDelegate.swift";
const VARIABLES_GRADLE = "android/variables.gradle";
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
  // A denext project (deno.json + package.json, `deno install`): last, so an npm-family lockfile
  // beside it wins.
  ["deno.lock", "deno"],
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
 * (`pnpm-workspace.yaml` counting as pnpm's, after a lockfile in the same folder; a `deno.lock`
 * only in `root` itself, for a denext project installed with `deno install`); then the nearest
 * `package.json` `packageManager` field; then npm.
 */
async function detectPackageManager(root: string): Promise<DetectedPackageManager> {
  const dirs = await workspaceAncestors(root);
  for (const dir of dirs) {
    const found = await lockfileIn(dir);
    // A deno.lock names the project's manager only in the project itself: an npm project nested
    // in a Deno repository is still an npm project.
    if (found && (found.manager !== "deno" || dir === root)) {
      return { manager: found.manager, lockfile: posixRelative(root, found.path) };
    }
  }
  for (const dir of dirs) {
    const manager = await packageManagerFieldIn(dir);
    if (manager) {
      return { manager, packageManagerField: posixRelative(root, join(dir, "package.json")) };
    }
  }
  return { manager: "npm" };
}

/** `manager`'s command to add `specs` as dependencies. */
function addCommand(
  manager: PackageManager,
  specs: string[],
  cwd: string,
  exact: boolean,
): PlannedCommand {
  // `deno add` writes npm packages into package.json when there is one; the spec carries the
  // version (pinned exactly when `exact`, see the caller), so there is no exact flag.
  if (manager === "deno") {
    return {
      cmd: "deno",
      args: ["add", ...specs.map((s) => `npm:${s}`)],
      cwd,
    };
  }
  const verb = manager === "npm" ? "install" : "add";
  const flag = !exact
    ? []
    : manager === "npm" || manager === "pnpm"
    ? ["--save-exact"]
    : ["--exact"];
  return { cmd: manager, args: [verb, ...flag, ...specs], cwd };
}

/** A plain version (`8.5.2`, `8.0.0-rc.1`): what an exactly pinned dependency holds. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether `root/package.json` pins its `@capacitor/*` packages exactly: it declares at least
 * one, and every one (dependencies and devDependencies) is a plain version, not a range.
 */
async function pinsCapacitorExactly(root: string): Promise<boolean> {
  const pkg = JSON.parse(await Deno.readTextFile(join(root, "package.json"))) as Record<
    string,
    unknown
  >;
  const versions = [pkg.dependencies, pkg.devDependencies].flatMap((deps) =>
    deps !== null && typeof deps === "object"
      ? Object.entries(deps).filter(([name]) => name.startsWith("@capacitor/")).map(([, v]) => v)
      : []
  );
  return versions.length > 0 &&
    versions.every((v) => typeof v === "string" && EXACT_VERSION.test(v.trim()));
}

/**
 * The spec added for `cap`: its caret range, or with `exact` the range's minimum (`^8.1.2` →
 * `8.1.2`), the version the table was verified against. A range that is not a caret is kept.
 */
function packageSpec(cap: MobileCapability, exact: boolean): string {
  const version = exact ? cap.version!.replace(/^\^(?=\d)/, "") : cap.version!;
  return `${cap.npm}@${version}`;
}

/**
 * `specs` (`name@range`) with each package once, the first spec winning: two capabilities can
 * share a package (`@capacitor/app` behind deep-links, back, restore and application).
 */
function uniquePackages(specs: readonly string[]): string[] {
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const name = spec.slice(0, spec.indexOf("@", 1));
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
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
    appGroups: [...new Set(opts.appGroups ?? [])],
    names: [...new Set(opts.names ?? [])],
    configurable: [...new Set(opts.configurable ?? [])],
    ci: opts.ci === true,
  };
  const flags = [
    ["schemes", "--scheme"],
    ["domains", "--domain"],
    ["appGroups", "--app-group"],
    ["names", "--name"],
    ["configurable", "--configurable"],
  ] as const;
  for (const [key, flag] of flags) {
    if (options[key].length === 0) continue;
    if (names.some((n) => table[n].options?.includes(key))) continue;
    throw new Error(`${flag} is only for ${takersOf(table, key)}; add it or drop ${flag}.`);
  }
  if (options.ci && !names.some((n) => table[n].options?.includes("ci"))) {
    throw new Error(`--ci is only for ${takersOf(table, "ci")}; add it or drop --ci.`);
  }
  return options;
}

/**
 * `edits`, keeping the first of any with the same label. Two capabilities that take the same
 * `--scheme` (deep-links, auth-session, share-extension) each compute their own identical
 * `CFBundleURLTypes: <scheme>` edit; applying both is already a no-op (the second `apply` sees
 * its own change already there), so the plan lists it once too.
 */
function dedupeByLabel(edits: readonly NativeEdit[]): NativeEdit[] {
  const seen = new Set<string>();
  return edits.filter((e) => {
    if (seen.has(e.label)) return false;
    seen.add(e.label);
    return true;
  });
}

/** Every chosen capability's `configure` result, merged per native file. */
function configureAll(
  caps: readonly MobileCapability[],
  options: CapabilityOptions,
): { native: NativeEditPlan; requiredFiles: Record<string, string>; manual: string[] } {
  const configs = caps.map((c) => c.configure?.(options) ?? {});
  return {
    native: {
      infoPlist: dedupeByLabel(configs.flatMap((c) => c.infoPlist ?? [])),
      entitlements: dedupeByLabel(configs.flatMap((c) => c.entitlements ?? [])),
      manifest: dedupeByLabel(configs.flatMap((c) => c.manifest ?? [])),
      appDelegate: dedupeByLabel(configs.flatMap((c) => c.appDelegate ?? [])),
      variablesGradle: dedupeByLabel(configs.flatMap((c) => c.variablesGradle ?? [])),
      // Several capabilities share one install (DenextSettings): run and list it once.
      installs: [...new Set(configs.flatMap((c) => c.install ? [c.install] : []))],
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
  const values = [
    ...new Set(appEntitlementValues(pbxproj).map((v) => v.trim().replace(/^\$\(SRCROOT\)\//, ""))),
  ];
  const unresolved = values.filter((v) => v.includes("$(") || v.startsWith("/"));
  const files = values.filter((v) => !unresolved.includes(v)).map((v) => `ios/App/${v}`);
  if (files.length > 0) return { files, wired: true, unresolved };
  return { files: [`ios/App/${DEFAULT_ENTITLEMENTS}`], wired: false, unresolved };
}

/**
 * The App target's CODE_SIGN_ENTITLEMENTS values (an app extension's entitlements are its own).
 * A project the pbxproj editor cannot read falls back to every CODE_SIGN_ENTITLEMENTS in it.
 */
function appEntitlementValues(pbxproj: string): string[] {
  try {
    const values = targetBuildSetting(
      pbxproj,
      applicationTargetName(pbxproj),
      "CODE_SIGN_ENTITLEMENTS",
    )
      .values();
    return [...values].filter((v): v is string => v !== undefined);
  } catch {
    const setting = /\bCODE_SIGN_ENTITLEMENTS\s*=\s*("?)([^";\n]+)\1\s*;/g;
    return [...pbxproj.matchAll(setting)].map((m) => m[2]);
  }
}

/**
 * The manual step to wire a freshly written `App/App.entitlements` into the App target, printed
 * only while the target still names no CODE_SIGN_ENTITLEMENTS — checked once more after every
 * edit has run (see {@linkcode addMobileCapabilities}), since a native install this same run
 * (share-extension / widget / live-activity with `--app-group`) can wire it before that check.
 */
function wiringStep(): string {
  return `point the App target at ios/App/${DEFAULT_ENTITLEMENTS}: in Xcode, App target → Build ` +
    `Settings → Code Signing Entitlements = ${DEFAULT_ENTITLEMENTS} (Debug and Release), ` +
    "or add the capability under Signing & Capabilities, which sets the same. denext wrote " +
    "the file but does not edit that build setting";
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
  if (!target.wired) steps.push(wiringStep());
  return steps;
}

/**
 * Whether the App target now names a CODE_SIGN_ENTITLEMENTS, read fresh from `project.pbxproj`
 * with {@linkcode targetBuildSetting} — called after every edit of a real run so a step that
 * wired it (an app-group install earlier in the same run, or one already in the pbxproj) drops
 * the stale {@linkcode wiringStep}. `undefined` (no pbxproj to check) counts as wired: there is
 * nothing to point at by hand.
 */
async function appTargetWired(root: string): Promise<boolean> {
  const pbxproj = await readText(join(root, PBXPROJ));
  return pbxproj === undefined || appEntitlementValues(pbxproj).length > 0;
}

/**
 * `plan` with {@linkcode wiringStep}'s manual note dropped when the App target is wired by the
 * time every edit of this run has landed, even though it was not yet wired when the plan was
 * made (see {@linkcode appTargetWired}).
 */
async function withResolvedEntitlementsNote(plan: CapabilityPlan): Promise<CapabilityPlan> {
  const line = wiringStep();
  if (plan.native.entitlements.length === 0 || !plan.manual.includes(line)) return plan;
  if (!(await appTargetWired(plan.root))) return plan;
  return { ...plan, manual: plan.manual.filter((m) => m !== line) };
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

/** The capabilities' Info.plist keys, each once (the first capability's value wins). */
function uniquePlistKeys(caps: readonly MobileCapability[]): Array<{ key: string; value: string }> {
  const seen = new Map<string, string>();
  for (const cap of caps) {
    for (const [key, value] of Object.entries(cap.iosPlist ?? {})) {
      if (!seen.has(key)) seen.set(key, value);
    }
  }
  return [...seen].map(([key, value]) => ({ key, value }));
}

/**
 * The web export folder `cap sync` would copy, when it is missing: capacitor.config's `webDir`
 * (Capacitor's default `www` when the config names none) without an `index.html`. Undefined
 * when it is there, when the config loads the app from `server.url` (sync skips the copy check
 * then), or when the config cannot be read literally (Capacitor itself decides).
 */
async function missingWebAssets(root: string): Promise<string | undefined> {
  const file = await capacitorConfigFile(root);
  if (!file) return undefined;
  const source = await Deno.readTextFile(file);
  const config = await readCapacitorConfig(file, source);
  if (!config) return undefined;
  const server = config.server as { url?: unknown } | undefined;
  if (typeof server?.url === "string" && server.url !== "") return undefined;
  const webDir = config.webDir ?? (/\bwebDir\b/.test(source) ? undefined : "www");
  if (typeof webDir !== "string") return undefined;
  return await exists(join(root, webDir, "index.html")) ? undefined : webDir;
}

/**
 * The command after the install: `npx cap sync`, or `npx cap update` while the web export is
 * missing, with the warning that says what is left.
 */
async function syncStep(
  root: string,
): Promise<{ sync: PlannedCommand; missing?: string; warning?: string }> {
  const missing = await missingWebAssets(root);
  if (missing === undefined) return { sync: { cmd: "npx", args: ["cap", "sync"], cwd: root } };
  return {
    sync: { cmd: "npx", args: ["cap", "update"], cwd: root },
    missing,
    warning: `no web export at ${missing}/index.html (capacitor.config webDir) yet, so ` +
      "`npx cap update` runs instead of `npx cap sync` (it installs the native plugins; sync " +
      "would stop at the missing folder). Run `denext export`, then `npx cap sync`",
  };
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
  const exact = await pinsCapacitorExactly(root);
  const specs = uniquePackages(
    caps.flatMap((c) => c.npm ? [packageSpec(c, exact), ...(c.peers ?? [])] : []),
  );
  const target = await entitlementsTarget(root);
  const after = specs.length > 0 ? await syncStep(root) : undefined;
  return {
    root,
    capabilities: names,
    packageManager: manager,
    lockfile,
    packageManagerField,
    capacitorMajor: core.major,
    capacitorSource: core.source,
    install: specs.length > 0 ? addCommand(manager, specs, root, exact) : undefined,
    sync: after?.sync,
    webAssetsMissing: after?.missing,
    plist: uniquePlistKeys(caps),
    permissions: [...new Set(caps.flatMap((c) => c.androidPermissions ?? []))],
    notes: names.flatMap((n) => table[n].notes ? [`${n}: ${table[n].notes}`] : []),
    native: configured.native,
    entitlementsFiles: target.files,
    warnings: [
      ...(await missingFiles(root, configured.requiredFiles)),
      ...(after?.warning ? [after.warning] : []),
    ],
    manual: [
      ...(await entitlementSteps(root, target, configured.native.entitlements)),
      ...configured.manual,
    ],
    privacy: privacyLabels(privacyEntriesFor(names)),
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
    ...plan.native.variablesGradle.map((e) => `  gradle         ${e.label}`),
    ...plan.privacy.map((p) => `  privacy        ${p} (PrivacyInfo.xcprivacy)`),
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
    // A name longer than the column (background-location) still gets one space.
    `  ${name.padEnd(16)} ${
      (c.npm ? `${c.npm}@${c.version}` : c.listing ?? "(denext native plugin)").padEnd(46)
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

/** Push each of `items` onto `list` unless it is already there. */
function pushNew(list: string[], items: readonly string[]): void {
  for (const item of items) if (!list.includes(item)) list.push(item);
}

/**
 * Merge a native install's report into `report`. Several installers touch the same files (the
 * Xcode project, the bridge, Info.plist) and print the same notes: each is listed once.
 */
function mergeInstall(report: AddCapabilitiesReport, done: NativeInstallReport): void {
  pushNew(report.written, done.written);
  pushNew(report.unchanged, done.unchanged);
  report.skipped.push(...done.skipped);
  pushNew(report.manual, done.manual);
}

/** Merge the capabilities' required-reason declarations into the privacy manifests. */
async function mergePrivacy(report: AddCapabilitiesReport): Promise<void> {
  const entries = privacyEntriesFor(report.plan.capabilities);
  if (entries.length === 0) return;
  const done = await writePrivacyManifests(report.plan.root, entries);
  pushNew(report.written, done.written);
  pushNew(report.unchanged, done.unchanged.filter((p) => !report.written.includes(p)));
  report.skipped.push(...done.skipped.filter((s) => !report.skipped.includes(s)));
  pushNew(report.manual, done.manual);
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
    mergeInstall(report, await step.run({ dir: plan.root, force: opts.force }));
  }
  const stale = report.unchanged.filter((path) => report.written.includes(path));
  for (const path of stale) report.unchanged.splice(report.unchanged.indexOf(path), 1);
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
  await editNative(report, VARIABLES_GRADLE, plan.native.variablesGradle);
  await mergePrivacy(report);
  if (plan.sync) await runChecked(opts.run, plan.sync, report.ran);
  return { ...report, plan: await withResolvedEntitlementsNote(plan) };
}
