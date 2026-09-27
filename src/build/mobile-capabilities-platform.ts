// The 2.11 platform capabilities of `denext mobile add`: app-review, app-update,
// screen-orientation, media-library, privacy-screen, tracking, background, restore,
// accessibility, background-location and application. Kept
// apart from the main table in ./mobile-capabilities.ts (which spreads them in) so each
// capability's plugin pin, plist keys and native wiring sit together. Every plugin below was
// checked against its published package: a `@capacitor/core` peer range admitting 8 and (for
// iOS) an SPM range covering capacitor-swift-pm 8.

import { join } from "@std/path";
import type { CapabilityConfig, MobileCapability, NativeEdit } from "./mobile-capabilities.ts";
import type { NativeInstallOptions, NativeInstallReport } from "./mobile-native-install.ts";
import { withPlistStringArray } from "./mobile-native-config.ts";
import {
  capacitorConfigFile,
  readCapacitorConfig,
  withCapacitorConfigValue,
} from "./capacitor-config.ts";
import { BACKGROUND_RUNNER_EVENT, BACKGROUND_RUNNER_FILE } from "./background-runner.ts";
import { BACKGROUND_RUNNER_LABEL } from "../mobile/background.ts";
import { ACCESSIBILITY_INSTALL } from "./mobile-accessibility-install.ts";
import { SETTINGS_INSTALL } from "./mobile-settings-install.ts";

/** The Capacitor major these pins target. */
const CAPACITOR_MAJOR = 8;

/** The photo-library usage strings `media-library` (and `camera`) use. */
const PHOTOS_USAGE = "Choose photos from your library.";
const PHOTOS_ADD_USAGE = "Save photos to your library.";

/** `screen-orientation`: the steps the plugin's README leaves to the app. */
function configureScreenOrientation(): CapabilityConfig {
  return {
    manual: [
      "iPad: an app that allows multitasking cannot lock its orientation; set " +
      "UIRequiresFullScreen (Info.plist) to true if the iPad build must lock",
      "iOS: the lock covers Capacitor's view controller only; to lock presented ones too (the " +
      "in-app browser), return the bridge's supportedInterfaceOrientations from AppDelegate's " +
      "application(_:supportedInterfaceOrientationsFor:)",
      "Android 16+: apps targeting SDK 36 cannot lock the orientation on large screens " +
      "(tablets, foldables); phones are unaffected",
    ],
  };
}

/** `app-update`: the store-side facts the plugin depends on. */
function configureAppUpdate(): CapabilityConfig {
  return {
    manual: [
      "iOS: getAppUpdateInfo() reads the App Store lookup API by bundle id, so it only answers " +
      "once the app is live (pass { country } outside the US store); openAppStore() and " +
      "promptStoreUpdate() need the numeric App Store id",
      "Android: in-app updates only work for a build installed from Google Play (internal " +
      "testing counts); a sideloaded or debug build always reads not-available",
    ],
  };
}

/** `app-review`: when the review sheet actually appears. */
function configureAppReview(): CapabilityConfig {
  return {
    manual: [
      "the review sheet is rate-limited by the OS (iOS: 3 times a year, never in TestFlight; " +
      "Play: a quota, never for sideloaded builds); openStoreReview({ appStoreId }) always opens " +
      "the store page",
    ],
  };
}

/** `media-library`: Android's gallery mode is opt-in. */
function configureMediaLibrary(): CapabilityConfig {
  return {
    manual: [
      "Android: saveToLibrary() and getAlbums() cover the albums this app creates, with no " +
      "permission; a gallery app that must read every album sets plugins.Media." +
      "androidGalleryMode: true in capacitor.config and declares READ_MEDIA_IMAGES / " +
      "READ_MEDIA_VIDEO (Play asks why)",
    ],
  };
}

/** `tracking`: ATT is only half the store rule. */
function configureTracking(): CapabilityConfig {
  return {
    manual: [
      "call requestTrackingPermission() before any tracking (App Store Guideline 5.1.2), after " +
      "launch settles (iOS ignores the request while the app is not active); edit " +
      "NSUserTrackingUsageDescription to say what is tracked",
      "declare NSPrivacyTracking and NSPrivacyTrackingDomains in PrivacyInfo.xcprivacy, and the " +
      "tracking data types in App Store Connect's privacy details",
    ],
  };
}

// ---- background -------------------------------------------------------------------------------

/** The Swift the runner's README asks for in `didFinishLaunchingWithOptions`. */
const RUNNER_LAUNCH_LINES = [
  "// denext mobile add background: register the Background Runner's BGTask.",
  "BackgroundRunnerPlugin.registerBackgroundTask()",
  "BackgroundRunnerPlugin.handleApplicationDidFinishLaunching(launchOptions: launchOptions)",
];

/**
 * `AppDelegate.swift` registering the Background Runner at launch: `import
 * CapacitorBackgroundRunner` after `import Capacitor`, and the two calls at the top of
 * `application(_:didFinishLaunchingWithOptions:)`. Unchanged when it already registers; null
 * when the method or `import Capacitor` cannot be found.
 *
 * @param source The AppDelegate source.
 * @returns The edited source, the same source, or null.
 */
export function withAppDelegateBackgroundRunner(source: string): string | null {
  if (source.includes("BackgroundRunnerPlugin.registerBackgroundTask")) return source;
  const importCap = /^import Capacitor[ \t]*$/m.exec(source);
  const launch =
    /func\s+application\s*\(\s*_\s+\w+\s*:\s*UIApplication\s*,\s*didFinishLaunchingWithOptions\s+(\w+)\s*:[^{]*\{[ \t]*\n/
      .exec(source);
  if (!importCap || !launch) return null;
  const indent = /\n([ \t]*)\S/.exec(source.slice(launch.index + launch[0].length - 1))?.[1] ??
    "        ";
  const lines = RUNNER_LAUNCH_LINES.map((l) =>
    indent + l.replace("launchOptions: launchOptions", `launchOptions: ${launch[1]}`)
  );
  const at = launch.index + launch[0].length;
  const withCalls = source.slice(0, at) + lines.join("\n") + "\n" + source.slice(at);
  const importEnd = importCap.index + importCap[0].length;
  return withCalls.slice(0, importEnd) + "\nimport CapacitorBackgroundRunner" +
    withCalls.slice(importEnd);
}

/** The runner's Android JS engine, which `android/app/build.gradle` must find as a flat dir. */
const RUNNER_LIBS = "../../node_modules/@capacitor/background-runner/android/src/main/libs";

/**
 * `android/app/build.gradle` with the runner's library folder added to `flatDir` (the plugin's
 * README step). Unchanged when present; null without a `flatDir` block.
 *
 * @param gradle The app module's build.gradle.
 * @returns The edited text, the same text, or null.
 */
export function withRunnerFlatDir(gradle: string): string | null {
  if (gradle.includes("@capacitor/background-runner/android/src/main/libs")) return gradle;
  const flat = /flatDir\s*\{[^}\n]*\n([ \t]*)/.exec(gradle);
  if (!flat) return null;
  const at = flat.index + flat[0].length - flat[1].length;
  return gradle.slice(0, at) + `${flat[1]}dirs '${RUNNER_LIBS}', 'libs'\n` + gradle.slice(at);
}

/** The `plugins.BackgroundRunner` block `mobile add background` writes. */
export const BACKGROUND_RUNNER_CONFIG = {
  label: BACKGROUND_RUNNER_LABEL,
  src: BACKGROUND_RUNNER_FILE,
  event: BACKGROUND_RUNNER_EVENT,
  repeat: true,
  interval: 15,
  autoStart: true,
} as const;

/** An empty native install report. */
function emptyReport(): NativeInstallReport {
  return { written: [], upgraded: [], kept: [], unchanged: [], manual: [], skipped: [] };
}

/** Write `plugins.BackgroundRunner` into capacitor.config unless the app configured one. */
async function writeRunnerConfig(dir: string, report: NativeInstallReport): Promise<void> {
  const file = await capacitorConfigFile(dir);
  if (!file) return void report.skipped.push("no capacitor.config.* to write the runner into");
  const rel = file.slice(dir.length + 1);
  const source = await Deno.readTextFile(file);
  const plugins = (await readCapacitorConfig(file, source))?.plugins as
    | Record<string, unknown>
    | undefined;
  if (plugins?.BackgroundRunner !== undefined || /\bBackgroundRunner\s*:/.test(source)) {
    return void report.unchanged.push(rel);
  }
  try {
    const next = await withCapacitorConfigValue(
      file,
      source,
      ["plugins", "BackgroundRunner"],
      BACKGROUND_RUNNER_CONFIG,
    );
    await Deno.writeTextFile(file, next);
    report.written.push(rel);
  } catch (err) {
    report.manual.push(
      `${rel}: set plugins.BackgroundRunner to ${JSON.stringify(BACKGROUND_RUNNER_CONFIG)} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Add the runner's flat dir to android/app/build.gradle. */
async function wireRunnerGradle(dir: string, report: NativeInstallReport): Promise<void> {
  const rel = "android/app/build.gradle";
  let gradle: string;
  try {
    gradle = await Deno.readTextFile(join(dir, rel));
  } catch {
    return void report.skipped.push(`Android: no ${rel} (run \`npx cap add android\` first)`);
  }
  const next = withRunnerFlatDir(gradle);
  if (next === null) {
    report.manual.push(
      `${rel}: add \`dirs '${RUNNER_LIBS}', 'libs'\` inside repositories { flatDir { … } }`,
    );
  } else if (next === gradle) {
    report.unchanged.push(rel);
  } else {
    await Deno.writeTextFile(join(dir, rel), next);
    report.written.push(rel);
  }
}

/**
 * `background`'s native step: the runner config in capacitor.config and the Android flat dir
 * (the plist keys and the AppDelegate registration go through the table's own edits).
 *
 * @param opts The Capacitor project.
 * @returns What it wrote.
 */
async function addBackgroundRunnerToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const report = emptyReport();
  await writeRunnerConfig(opts.dir, report);
  await wireRunnerGradle(opts.dir, report);
  return report;
}

/** `background`: UIBackgroundModes, the BGTask identifier, AppDelegate, config and gradle. */
function configureBackground(): CapabilityConfig {
  const infoPlist: NativeEdit[] = [
    {
      label: "UIBackgroundModes: fetch, processing",
      apply: (text) => withPlistStringArray(text, "UIBackgroundModes", ["fetch", "processing"]),
    },
    {
      label: `BGTaskSchedulerPermittedIdentifiers: ${BACKGROUND_RUNNER_LABEL}`,
      apply: (text) =>
        withPlistStringArray(text, "BGTaskSchedulerPermittedIdentifiers", [
          BACKGROUND_RUNNER_LABEL,
        ]),
    },
  ];
  return {
    infoPlist,
    appDelegate: [{
      label: "register the Background Runner in application(_:didFinishLaunchingWithOptions:)",
      apply: withAppDelegateBackgroundRunner,
    }],
    install: {
      label: `plugins.BackgroundRunner in capacitor.config (src ${BACKGROUND_RUNNER_FILE}, event ` +
        `${BACKGROUND_RUNNER_EVENT}, every 15 min) + the runner's flatDir in android/app/build.gradle`,
      run: addBackgroundRunnerToProject,
    },
    manual: [
      "write tasks as background/<name>.ts (export default defineBackgroundTask({ name, interval, " +
      "handler }) from denext/mobile); `denext export` compiles them into " +
      `${BACKGROUND_RUNNER_FILE} in the export`,
      "the OS decides when the runner wakes: iOS (BGTaskScheduler) from usage patterns, never in " +
      "the simulator, ~30 s per run; Android (WorkManager) at least 15 minutes apart, and some " +
      "vendors' battery savers stop it (dontkillmyapp.com)",
    ],
  };
}

/** `restore`: the relaunch half of Android process death. */
function configureRestore(): CapabilityConfig {
  return {
    manual: [
      "register onRestoredResult(handler) at startup so a pickImage() / pickDocument() / camera " +
      "result that arrives after Android killed the app is delivered; restoreRouteOnRelaunch() " +
      "returns to the last route (add @capacitor/preferences to store it natively)",
    ],
  };
}

// ---- background-location ----------------------------------------------------------------------

/**
 * `background-location`: `UIBackgroundModes: location` (the Info.plist keys are the table's),
 * DenextSettings (a refused Always can only be changed in Settings), and the review steps.
 * Android's ACCESS_BACKGROUND_LOCATION is deliberately not declared: the plugin tracks through
 * a foreground service (FOREGROUND_SERVICE_LOCATION) with a visible notification, which needs
 * no background permission, and Play reviews every app that declares one.
 */
function configureBackgroundLocation(): CapabilityConfig {
  return {
    infoPlist: [{
      label: "UIBackgroundModes: location",
      apply: (text) => withPlistStringArray(text, "UIBackgroundModes", ["location"]),
    }],
    install: SETTINGS_INSTALL,
    manual: [
      "App Store review (Guideline 2.5.4, 5.1.1): background location must serve a feature the " +
      "user can see and that needs it (navigation, fitness, delivery tracking); say which in the " +
      "review notes, make NSLocationAlwaysAndWhenInUseUsageDescription name that feature, and " +
      "expect a rejection when it is not obvious from the app",
      "Google Play: the foreground service type `location` is declared in the Play Console " +
      "(App content > Foreground service permissions) with a short video of the feature; " +
      "ACCESS_BACKGROUND_LOCATION (only for background geofencing) adds the Location " +
      "permissions declaration and a prominent in-app disclosure before the request",
      "Android: set android.useLegacyBridge: true in capacitor.config, or updates stop after " +
      "about 5 minutes in the background (the plugin's README); forward fixes to a server with " +
      "CapacitorHttp or watchPositionInBackground's native `url`, since WebView requests are " +
      "throttled in the background",
      "declare Precise Location in App Store Connect's privacy details (and " +
      "NSPrivacyCollectedDataTypePreciseLocation in PrivacyInfo.xcprivacy) when fixes leave " +
      "the device",
    ],
  };
}

/** The platform capabilities, spread into `MOBILE_CAPABILITIES`. */
export const PLATFORM_CAPABILITIES: Readonly<Record<string, MobileCapability>> = {
  "app-review": {
    npm: "@capawesome/capacitor-app-review",
    version: "^8.0.2",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "requestReview() / openStoreReview({ appStoreId })",
    configure: configureAppReview,
  },
  "app-update": {
    npm: "@capawesome/capacitor-app-update",
    version: "^8.0.5",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "getAppUpdateInfo() / openAppStore() / performImmediateUpdate() / " +
      "startFlexibleUpdate() (Android) / promptStoreUpdate() (OTA's onNativeUpdateRequired)",
    configure: configureAppUpdate,
  },
  "screen-orientation": {
    npm: "@capacitor/screen-orientation",
    version: "^8.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "lockOrientation(o) / unlockOrientation() / getOrientation() / useOrientation() " +
      "(screen.orientation on the web)",
    configure: configureScreenOrientation,
  },
  "media-library": {
    npm: "@capacitor-community/media",
    version: "^9.1.0",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: {
      NSPhotoLibraryUsageDescription: PHOTOS_USAGE,
      NSPhotoLibraryAddUsageDescription: PHOTOS_ADD_USAGE,
    },
    notes: "saveToLibrary(src, { kind, album }) / getAlbums() / createAlbum(name) / " +
      "getRecentMedia() (iOS) (a download on the web)",
    configure: configureMediaLibrary,
  },
  "privacy-screen": {
    npm: "@capacitor/privacy-screen",
    version: "^2.0.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "setPrivacyScreen(on) / usePrivacyScreen() (app-switcher cover; Android also blocks " +
      "screenshots)",
  },
  tracking: {
    npm: "capacitor-plugin-app-tracking-transparency",
    version: "^3.0.0",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: {
      NSUserTrackingUsageDescription:
        "Your data is used to measure ads and deliver ones relevant to you.",
    },
    notes: "requestTrackingPermission() / getTrackingStatus() (App Tracking Transparency, iOS " +
      "14+; unavailable elsewhere)",
    configure: configureTracking,
  },
  background: {
    npm: "@capacitor/background-runner",
    version: "^3.0.0",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "defineBackgroundTask({ name, interval, handler }) in background/*.ts / " +
      "runBackgroundTask(name)",
    configure: configureBackground,
  },
  restore: {
    npm: "@capacitor/app",
    version: "^8.1.1",
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "onRestoredResult(handler) / useRestoredResult / restoreRouteOnRelaunch() (Android " +
      "process death)",
    configure: configureRestore,
  },
  accessibility: {
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "isScreenReaderEnabled() / onScreenReaderChange(cb) / useScreenReader() (VoiceOver, " +
      "TalkBack; React Native mode's AccessibilityInfo reads it too)",
    configure: () => ({ install: ACCESSIBILITY_INSTALL }),
  },
  "background-location": {
    npm: "@capgo/background-geolocation",
    version: "^8.4.7",
    capacitorMajor: CAPACITOR_MAJOR,
    iosPlist: {
      NSLocationWhenInUseUsageDescription: "Show where you are in the app.",
      NSLocationAlwaysAndWhenInUseUsageDescription:
        "Keep tracking your route while the app is in the background.",
    },
    androidPermissions: [
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_LOCATION",
      "android.permission.POST_NOTIFICATIONS",
    ],
    notes: "watchPositionInBackground(cb, { notification }) / stopBackgroundLocation() / " +
      "isBackgroundLocationAvailable() (@capgo/background-geolocation, MPL-2.0; foreground " +
      "watchPosition on the web)",
    configure: configureBackgroundLocation,
  },
  application: {
    npm: "@capacitor/app",
    version: "^8.1.1",
    peers: ["@capacitor/device@^8.0.3"],
    capacitorMajor: CAPACITOR_MAJOR,
    notes: "the app's name, id, version and build (expo-application over @capacitor/app's " +
      "getInfo()) and the vendor / Android id (@capacitor/device's getId())",
  },
};
