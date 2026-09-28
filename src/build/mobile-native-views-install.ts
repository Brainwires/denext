// `denext mobile add native-views` / `native-map`: install the native `DenextNativeViews` plugin
// behind `NativeViewSlot` / `useNativeViewSlot` (denext/mobile). native-views: the plugin, the
// registry of view factories and the built-in `video` factory; iOS files in the Xcode app target
// registered by `DenextBridgeViewController`, Android files in `dev/denext/nativeviews/`
// registered from `MainActivity` (both composed with every other denext native feature, see
// mobile-native-install.ts). native-map: the `map` factory (MapKit on iOS; osmdroid on Android,
// whose dependency it adds to `android/app/build.gradle`), which the plugin finds by class name,
// after installing native-views. Running either twice changes nothing.

import { join } from "@std/path";
import { addSourceFiles } from "./pbxproj.ts";
import {
  isPristineNativeViewsTemplate,
  NATIVE_MAP_ANDROID_FILES,
  NATIVE_MAP_IOS_FILES,
  NATIVE_VIEWS_ANDROID_FILES,
  NATIVE_VIEWS_IOS_FILES,
  OSMDROID_DEPENDENCY,
  renderNativeViewsTemplate,
} from "./native-views-native-templates.ts";
import {
  hasAndroidApp,
  hasIosApp,
  IOS_APP,
  NativeInstaller,
  type NativeInstallOptions,
  type NativeInstallReport,
  PBXPROJ,
  type TemplateKind,
  writeTemplates,
} from "./mobile-native-install.ts";
import { installRegisteredPlugin } from "./mobile-plugin-install.ts";
import type { MobileCapability, NativeInstallStep } from "./mobile-capabilities.ts";

/** Where the Java files go, relative to the project root. */
const ANDROID_DIR = "android/app/src/main/java/dev/denext/nativeviews";
/** The app module's Gradle file, relative to the project root. */
const APP_GRADLE = "android/app/build.gradle";

/** The native-views templates: `// denext-native-views-template:` markers. */
const NATIVE_VIEWS_TEMPLATES: TemplateKind = {
  render: (template) => renderNativeViewsTemplate(template),
  isPristine: (_name, text) => isPristineNativeViewsTemplate(text),
};

/**
 * Install the native `DenextNativeViews` plugin into the Capacitor project at `opts.dir`.
 * Idempotent; an unedited template from an earlier denext is upgraded, and customised files are
 * never rewritten without `force`, only reported under `kept` and `manual`.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
function addNativeViewsToProject(opts: NativeInstallOptions): Promise<NativeInstallReport> {
  return installRegisteredPlugin(opts, {
    feature: "native-views",
    iosFiles: NATIVE_VIEWS_IOS_FILES,
    androidFiles: NATIVE_VIEWS_ANDROID_FILES,
    androidDir: ANDROID_DIR,
    kind: NATIVE_VIEWS_TEMPLATES,
    registration: {
      needle: "DenextNativeViewsPlugin()",
      step: "make capacitorDidLoad() call " +
        "`bridge?.registerPluginInstance(DenextNativeViewsPlugin())` after " +
        "super.capacitorDidLoad().",
    },
  });
}

/**
 * `gradle` with `dependency` in its top-level `dependencies { }` block, the same text when it is
 * already there, or null when there is no such block.
 *
 * @param gradle The text of `android/app/build.gradle`.
 * @param dependency The dependency line (`implementation '…'`).
 * @returns The edited text, or null.
 */
export function withGradleDependency(gradle: string, dependency: string): string | null {
  const coordinate = /'([^':]+:[^':]+):/.exec(dependency)?.[1];
  if (coordinate && gradle.includes(coordinate)) return gradle;
  const block = /^dependencies\s*\{[^\n]*\n/m.exec(gradle);
  if (!block) return null;
  const at = block.index + block[0].length;
  return `${gradle.slice(0, at)}    ${dependency}\n${gradle.slice(at)}`;
}

type Installer = NativeInstaller<NativeInstallOptions, NativeInstallReport>;

/** The map factory's Swift file, in the app target (no registration: found by class name). */
async function installMapIos(inst: Installer): Promise<void> {
  if (!(await hasIosApp(inst))) return;
  const appDir = join(inst.opts.dir, IOS_APP);
  await writeTemplates(inst, appDir, NATIVE_MAP_IOS_FILES, NATIVE_VIEWS_TEMPLATES);
  // No bridge registration: the plugin finds the factory class by name.
  const add = (pbxproj: string) =>
    addSourceFiles(pbxproj, Object.keys(NATIVE_MAP_IOS_FILES), { randomId: inst.opts.randomId })
      .text;
  await inst.edit(join(inst.opts.dir, PBXPROJ), add);
}

/** The osmdroid map factory and its dependency. */
async function installMapAndroid(inst: Installer): Promise<void> {
  if (!(await hasAndroidApp(inst))) return;
  await writeTemplates(
    inst,
    join(inst.opts.dir, ANDROID_DIR),
    NATIVE_MAP_ANDROID_FILES,
    NATIVE_VIEWS_TEMPLATES,
  );
  const gradle = join(inst.opts.dir, APP_GRADLE);
  let missing = false;
  await inst.edit(gradle, (text) => {
    const next = withGradleDependency(text, OSMDROID_DEPENDENCY);
    missing = next === null;
    return next ?? text;
  });
  if (missing || (await inst.read(gradle)) === undefined) {
    inst.report.manual.push(`${APP_GRADLE}: add \`${OSMDROID_DEPENDENCY}\` to its dependencies.`);
  }
}

/**
 * Install the `map` native view (and, first, the `DenextNativeViews` plugin it runs in) into the
 * Capacitor project at `opts.dir`: `DenextMapViewFactory.swift` (MapKit) in the app target, and
 * `DenextOsmMapFactory.java` plus the osmdroid dependency on Android.
 *
 * @param opts The project directory and flags.
 * @returns What was written, what was already current, and what is left to do by hand.
 */
async function addNativeMapToProject(
  opts: NativeInstallOptions,
): Promise<NativeInstallReport> {
  const report = await addNativeViewsToProject(opts);
  const inst: Installer = new NativeInstaller(opts, report);
  await installMapIos(inst);
  await installMapAndroid(inst);
  // Both passes check the platforms; report each missing one once.
  report.skipped.splice(0, report.skipped.length, ...new Set(report.skipped));
  return report;
}

/** `native-views`'s native step: the DenextNativeViews plugin and its registration. */
const NATIVE_VIEWS_INSTALL: NativeInstallStep = {
  label: "DenextNativeViews plugin (NativeViewSlot: native views in the page, the video view) + " +
    "its registration in DenextBridgeViewController / MainActivity",
  run: addNativeViewsToProject,
};

/** `native-map`'s native step: native-views plus the map view. */
const NATIVE_MAP_INSTALL: NativeInstallStep = {
  label: "DenextNativeViews plugin + the map view (MapKit on iOS, osmdroid on Android, with its " +
    "Gradle dependency)",
  run: addNativeMapToProject,
};

/** The `denext mobile add` capabilities for native views (spread into MOBILE_CAPABILITIES). */
export const NATIVE_VIEW_CAPABILITIES: Readonly<Record<string, MobileCapability>> = {
  "native-views": {
    capacitorMajor: 8,
    notes: "NativeViewSlot / useNativeViewSlot: native views in the page layout (the built-in " +
      "video view, and view types you register natively)",
    configure: () => ({ install: NATIVE_VIEWS_INSTALL }),
  },
  "native-map": {
    capacitorMajor: 8,
    notes: '<NativeViewSlot type="map"> (MapKit on iOS, OpenStreetMap via osmdroid on Android; ' +
      "no API key). Installs native-views too",
    configure: () => ({ install: NATIVE_MAP_INSTALL }),
  },
};
